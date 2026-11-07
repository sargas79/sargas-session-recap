import { spawn } from 'node:child_process';
import type { Logger } from '../log/index.ts';
import { AudioToolError, installHint, type AudioToolName } from './errors.ts';

/** Default cap on captured stdout/stderr per stream (32 MiB). */
export const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

export interface RunToolOptions {
  /** Tool label used in errors and logs. Never the command line itself. */
  readonly tool: AudioToolName;
  /** Hard wall-clock limit. The process is killed when it elapses. */
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
  /** Per-stream capture cap; exceeding it kills the process. */
  readonly maxOutputBytes?: number | undefined;
  readonly logger?: Logger | undefined;
}

export interface RunToolResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs an external tool and captures its output.
 *
 * The argument array is passed straight to the OS (`shell: false`), so paths
 * with spaces, quotes or non-ASCII characters need no escaping and cannot be
 * interpreted by a shell. The window is hidden on Windows. Output is kept in
 * memory only and is never logged: the logger receives the tool name, exit
 * status and duration, nothing else.
 *
 * A non-zero exit code is returned, not thrown; callers decide what it means.
 */
export function runTool(
  file: string,
  args: readonly string[],
  options: RunToolOptions,
): Promise<RunToolResult> {
  const { tool, timeoutMs, signal, logger } = options;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(
      new AudioToolError('AUDIO_INVALID_ARGUMENT', 'timeoutMs must be a positive number', {
        tool,
      }),
    );
  }
  if (signal?.aborted === true) {
    return Promise.reject(abortedError(tool));
  }

  const started = Date.now();
  return new Promise<RunToolResult>((resolve, reject) => {
    const child = spawn(file, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: AudioToolError | undefined;
    let settled = false;

    const fail = (error: AudioToolError): void => {
      failure ??= error;
      child.kill('SIGKILL');
    };

    const timer = setTimeout(() => {
      fail(
        new AudioToolError('AUDIO_TIMEOUT', `${tool} did not finish within ${timeoutMs} ms`, {
          tool,
          hint: 'the input may be very long, on a slow or network drive, or the tool may be hung; retry with a longer timeout',
        }),
      );
    }, timeoutMs);

    const onAbort = (): void => {
      fail(abortedError(tool));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (): void => {
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        fail(outputTooLarge(tool));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxOutputBytes) {
        fail(outputTooLarge(tool));
        return;
      }
      stderr.push(chunk);
    });

    child.once('error', (error: NodeJS.ErrnoException) => {
      if (settled) {
        return;
      }
      finish();
      const code =
        error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 'UNKNOWN'
          ? 'AUDIO_TOOL_NOT_FOUND'
          : 'AUDIO_PROCESS_FAILED';
      logger?.warn('audio.tool.run', {
        command: tool,
        status: 'error',
        errorCode: code,
        durationMs: Date.now() - started,
      });
      reject(
        new AudioToolError(
          code,
          code === 'AUDIO_TOOL_NOT_FOUND'
            ? `${tool} could not be started (${error.code ?? 'error'})`
            : `${tool} failed to start (${error.code ?? 'error'})`,
          { tool, hint: installHint(tool), cause: error },
        ),
      );
    });

    child.once('close', (exitCode, exitSignal) => {
      if (settled) {
        return;
      }
      finish();
      const durationMs = Date.now() - started;
      if (failure !== undefined) {
        logger?.warn('audio.tool.run', {
          command: tool,
          status: 'error',
          errorCode: failure.code,
          durationMs,
        });
        reject(failure);
        return;
      }
      logger?.debug('audio.tool.run', {
        command: tool,
        status: exitCode === 0 ? 'ok' : 'failed',
        durationMs,
      });
      resolve({
        exitCode,
        signal: exitSignal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function abortedError(tool: AudioToolName): AudioToolError {
  return new AudioToolError('AUDIO_ABORTED', `${tool} was cancelled`, { tool });
}

function outputTooLarge(tool: AudioToolName): AudioToolError {
  return new AudioToolError('AUDIO_OUTPUT_TOO_LARGE', `${tool} produced more output than allowed`, {
    tool,
  });
}

/**
 * Last non-empty stderr line, truncated. Used only as `detail` on errors so an
 * operator can see ffmpeg's own reason; it is never logged.
 */
export function stderrTail(stderr: string, maxChars = 300): string | undefined {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const last = lines.at(-1);
  if (last === undefined) {
    return undefined;
  }
  return last.length > maxChars ? `${last.slice(0, maxChars)}...` : last;
}

/** Throws a typed error for a non-zero exit. */
export function assertSuccess(result: RunToolResult, tool: AudioToolName, action: string): void {
  if (result.exitCode === 0) {
    return;
  }
  const status =
    result.exitCode === null ? `signal ${result.signal ?? 'unknown'}` : `code ${result.exitCode}`;
  throw new AudioToolError('AUDIO_PROCESS_FAILED', `${tool} failed while ${action} (${status})`, {
    tool,
    exitCode: result.exitCode,
    detail: stderrTail(result.stderr),
    hint: "check that the input exists, is readable and is an audio file ffmpeg understands; see `detail` for ffmpeg's reason",
  });
}
