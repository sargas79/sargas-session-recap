/**
 * Starts whisper-cli for one chunk (S04 section 7: `-m <model> -f <wav> -l pt -ojf`). An argument
 * array and no shell. stdout and stderr are discarded, not captured: stdout is the transcript,
 * which must not reach a log or an error message, and an unread pipe could stall the process.
 */
import { spawn } from 'node:child_process';
import { StageError } from '../jobs/errors.ts';

export interface WhisperArgsInput {
  readonly model: string;
  readonly wav: string;
  /** whisper writes `<outputBase>.json`. */
  readonly outputBase: string;
  readonly language: string;
  /** Omitted from the command line when empty. */
  readonly prompt: string;
}

export function whisperArgs(input: WhisperArgsInput): string[] {
  const args = [
    '-m',
    input.model,
    '-f',
    input.wav,
    '-l',
    input.language,
    '-ojf',
    '-of',
    input.outputBase,
  ];
  if (input.prompt !== '') args.push('--prompt', input.prompt);
  return args;
}

/**
 * A path whisper can open whatever its length. whisper-cli uses plain `fopen`, which fails past the
 * 260-character Windows limit, and run directories under a long data root can exceed it.
 */
export function whisperPath(file: string): string {
  return process.platform === 'win32' && !file.startsWith('\\\\') ? `\\\\?\\${file}` : file;
}

export interface RunWhisperOptions {
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

/**
 * Runs whisper and resolves once it exits successfully. Crashes and timeouts are retryable: the
 * job runner tries again and the stage resumes at this chunk. The timeout must stay generous: the
 * first run per model compiles shaders, and a CPU fallback is near real time (S04 section 5.0).
 */
export function runWhisper(
  file: string,
  args: readonly string[],
  options: RunWhisperOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], { shell: false, windowsHide: true, stdio: 'ignore' });
    let failure: StageError | undefined;
    const stop = (error: StageError): void => {
      failure ??= error;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      stop(
        new StageError(
          'whisper-timeout',
          `whisper did not finish a chunk within ${String(options.timeoutMs)} ms`,
          { retryable: true },
        ),
      );
    }, options.timeoutMs);
    const onAbort = (): void => {
      stop(new StageError('whisper-cancelled', 'whisper was cancelled'));
    };
    options.signal.addEventListener('abort', onAbort, { once: true });
    if (options.signal.aborted) onAbort();
    const finish = (): void => {
      clearTimeout(timer);
      options.signal.removeEventListener('abort', onAbort);
    };
    child.once('error', (error: NodeJS.ErrnoException) => {
      finish();
      reject(
        new StageError(
          'whisper-not-started',
          `whisper could not be started (${error.code ?? 'error'}); run \`recap doctor\``,
          { cause: error },
        ),
      );
    });
    child.once('close', (code, signal) => {
      finish();
      if (failure !== undefined) {
        reject(failure);
      } else if (code === 0) {
        resolve();
      } else {
        const status = code === null ? `signal ${String(signal)}` : `code ${String(code)}`;
        reject(
          new StageError('whisper-failed', `whisper exited with ${status}`, { retryable: true }),
        );
      }
    });
  });
}
