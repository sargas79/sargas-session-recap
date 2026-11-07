import { randomBytes } from 'node:crypto';
import { rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AudioToolError } from './errors.ts';
import { resolveInputFile } from './input.ts';
import { resolveTool, type ResolvedTool } from './locate.ts';
import type { AudioOperationOptions } from './probe.ts';
import { assertSuccess, runTool } from './run.ts';

/** Generous default: multi-hour sessions decode in minutes, not an hour. */
export const DEFAULT_DECODE_TIMEOUT_MS = 60 * 60_000;

export const PCM_16K_SAMPLE_RATE = 16_000;

export interface DecodeOptions extends AudioOperationOptions {
  /** Already resolved ffmpeg; skips lookup and the version check. */
  readonly ffmpeg?: ResolvedTool | undefined;
}

/**
 * ffmpeg arguments for a deterministic 16 kHz mono signed 16-bit PCM WAV.
 *
 * - first audio stream only, no video/subtitle/data streams
 * - all metadata and chapters dropped (`-map_metadata -1`, `-map_chapters -1`)
 * - bit-exact muxing/encoding, so no encoder version string is written and the
 *   same input and ffmpeg version always give byte-identical output
 * - explicit `-f wav` because the temp file name has no `.wav` extension
 *
 * `input` must be absolute so it can never look like an option.
 */
export function decodeArgs(input: string, output: string): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-nostats',
    '-v',
    'error',
    '-y',
    '-i',
    input,
    '-map',
    '0:a:0',
    '-vn',
    '-sn',
    '-dn',
    '-map_metadata',
    '-1',
    '-map_chapters',
    '-1',
    '-ac',
    '1',
    '-ar',
    String(PCM_16K_SAMPLE_RATE),
    '-c:a',
    'pcm_s16le',
    '-bitexact',
    '-fflags',
    '+bitexact',
    '-flags:a',
    '+bitexact',
    '-f',
    'wav',
    output,
  ];
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Rename with a short bounded retry for transient Windows locks (antivirus, indexer). */
async function renameWithRetry(from: string, to: string): Promise<void> {
  const delays = [50, 150, 400];
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
      const wait = delays[attempt];
      if (!retryable || wait === undefined) {
        throw error;
      }
      await delay(wait);
    }
  }
}

/**
 * Decodes the first audio stream of `src` to a 16 kHz mono `pcm_s16le` WAV at
 * `dst`.
 *
 * The output is written to a temp file in the destination directory and then
 * renamed over `dst`, so `dst` is either the previous file or the complete new
 * one, never a partial write.
 *
 * TODO(#19): switch to the T03 atomic-write helper (fsync + rename with retry)
 * once it lands.
 */
export async function decodeToPcm16kMono(
  src: string,
  dst: string,
  options: DecodeOptions = {},
): Promise<void> {
  const input = await resolveInputFile(src);
  if (dst.length === 0) {
    throw new AudioToolError('AUDIO_INVALID_ARGUMENT', 'output path is empty');
  }
  const output = path.resolve(dst);
  if (samePath(input, output)) {
    throw new AudioToolError(
      'AUDIO_INVALID_ARGUMENT',
      'output path must differ from the input path',
      { hint: 'choose a separate file for the decoded 16 kHz audio' },
    );
  }
  const dir = path.dirname(output);
  const dirExists = await stat(dir).then(
    (info) => info.isDirectory(),
    () => false,
  );
  if (!dirExists) {
    throw new AudioToolError('AUDIO_INVALID_ARGUMENT', `output directory does not exist: ${dir}`, {
      hint: 'create the directory first',
    });
  }

  const ffmpeg = options.ffmpeg ?? (await resolveTool('ffmpeg', options));
  const runner = options.runner ?? runTool;
  const temp = path.join(
    dir,
    `.${path.basename(output)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
  );
  try {
    const result = await runner(ffmpeg.path, decodeArgs(input, temp), {
      tool: 'ffmpeg',
      timeoutMs: options.timeoutMs ?? DEFAULT_DECODE_TIMEOUT_MS,
      signal: options.signal,
      logger: options.logger,
    });
    assertSuccess(result, 'ffmpeg', 'decoding to 16 kHz mono PCM');
    try {
      await renameWithRetry(temp, output);
    } catch (error) {
      throw new AudioToolError(
        'AUDIO_WRITE_FAILED',
        `could not move the decoded audio into place at ${output}`,
        {
          tool: 'ffmpeg',
          hint: 'close any program that has the output file open (players, editors) and retry',
          cause: error,
        },
      );
    }
  } finally {
    // Best effort: a killed ffmpeg may still hold the handle for a moment on
    // Windows. Never let cleanup mask the original error.
    await rm(temp, { force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
  }
}
