import { secondsToMs } from './decimal.ts';
import { AudioToolError } from './errors.ts';
import { resolveInputFile } from './input.ts';
import { resolveTool, type ResolvedTool } from './locate.ts';
import { probeAudio, type AudioOperationOptions } from './probe.ts';
import { assertSuccess, runTool } from './run.ts';

export const DEFAULT_SILENCE_TIMEOUT_MS = 60 * 60_000;

/** Half-open interval `[startMs, endMs)` in integer milliseconds from the start of the file. */
export interface SilenceInterval {
  readonly startMs: number;
  readonly endMs: number;
}

export interface SilenceParams {
  /** Level below which audio counts as silence, in dBFS. Must be in [-200, 0]. */
  readonly thresholdDb: number;
  /** Minimum silence length in integer milliseconds (>= 1). */
  readonly minSilenceMs: number;
}

export interface DetectSilencesOptions extends AudioOperationOptions {
  readonly ffmpeg?: ResolvedTool | undefined;
  readonly ffprobe?: ResolvedTool | undefined;
  /**
   * Duration of the input, used to close a trailing silence that ffmpeg reports
   * without a `silence_end`. Probed with ffprobe when omitted.
   */
  readonly durationMs?: number | undefined;
}

function validateParams(params: SilenceParams): void {
  const { thresholdDb, minSilenceMs } = params;
  if (!Number.isFinite(thresholdDb) || thresholdDb > 0 || thresholdDb < -200) {
    throw new AudioToolError(
      'AUDIO_INVALID_ARGUMENT',
      `thresholdDb must be a number between -200 and 0 (got ${String(thresholdDb)})`,
      { hint: 'typical speech thresholds are between -50 and -30 dB' },
    );
  }
  if (!Number.isSafeInteger(minSilenceMs) || minSilenceMs < 1) {
    throw new AudioToolError(
      'AUDIO_INVALID_ARGUMENT',
      `minSilenceMs must be a positive integer (got ${String(minSilenceMs)})`,
    );
  }
}

/** The `silencedetect` filter expression, formatted without floating-point noise. */
export function silenceFilter(params: SilenceParams): string {
  validateParams(params);
  const seconds = Math.trunc(params.minSilenceMs / 1000);
  const millis = String(params.minSilenceMs % 1000).padStart(3, '0');
  return `silencedetect=noise=${params.thresholdDb.toFixed(2)}dB:duration=${seconds}.${millis}`;
}

/** ffmpeg arguments; `input` must be absolute so it can never look like an option. */
export function silenceArgs(input: string, params: SilenceParams): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-nostats',
    // silencedetect reports at `info` level.
    '-v',
    'info',
    '-i',
    input,
    '-map',
    '0:a:0',
    '-vn',
    '-sn',
    '-dn',
    '-af',
    silenceFilter(params),
    '-f',
    'null',
    '-',
  ];
}

// The log prefix differs between ffmpeg releases: `[silencedetect @ 0x..]` in
// 6.x, `[Parsed_silencedetect_0 @ ..]` in 9.0 (seen in Windows CI), so only the
// key is matched.
// No other filter we run emits `silence_start:` / `silence_end:`.
const START_RE = /(?:^|[\]\s])silence_start:\s*(\S+)/;
const END_RE = /(?:^|[\]\s])silence_end:\s*([^\s|]+)/;

function parseTime(text: string): number {
  const ms = secondsToMs(text);
  if (ms === undefined) {
    throw new AudioToolError('AUDIO_PARSE_FAILED', 'could not read a silencedetect timestamp', {
      tool: 'ffmpeg',
      hint: 'make sure ffmpeg matches the supported version (`recap doctor`)',
    });
  }
  return ms;
}

/**
 * Parses `silencedetect` log lines from ffmpeg stderr into integer-ms
 * intervals, in file order.
 *
 * - Timestamps are parsed as exact decimals (including `%g` exponent forms such
 *   as `2.08333e-05`) and rounded to the nearest millisecond.
 * - Slightly negative starts (resampler/decoder priming) are clamped to 0.
 * - A trailing `silence_start` without `silence_end` (the file ends in
 *   silence) is closed at `durationMs`; if `durationMs` is not given it is
 *   dropped.
 * - Intervals are clamped to `durationMs` when it is given, and empty ones are
 *   dropped.
 *
 * Pure and deterministic. Lines not from silencedetect are ignored.
 */
export function parseSilenceDetect(stderr: string, durationMs?: number): SilenceInterval[] {
  const intervals: SilenceInterval[] = [];
  let openStart: number | undefined;
  const clamp = (ms: number): number => {
    const nonNegative = Math.max(0, ms);
    return durationMs === undefined ? nonNegative : Math.min(nonNegative, durationMs);
  };
  const push = (startMs: number, endMs: number): void => {
    if (endMs > startMs) {
      intervals.push({ startMs, endMs });
    }
  };

  for (const line of stderr.split(/\r?\n/)) {
    const start = START_RE.exec(line);
    if (start !== null) {
      // A second start without an end should not happen; keep the earliest.
      openStart ??= clamp(parseTime(start[1] ?? ''));
      continue;
    }
    const end = END_RE.exec(line);
    if (end !== null && openStart !== undefined) {
      push(openStart, clamp(parseTime(end[1] ?? '')));
      openStart = undefined;
    }
  }
  if (openStart !== undefined && durationMs !== undefined) {
    push(openStart, durationMs);
  }
  return intervals;
}

/**
 * Runs ffmpeg's `silencedetect` on the first audio stream of `input` and
 * returns the silent intervals in integer milliseconds. Results are
 * deterministic for identical inputs and ffmpeg versions.
 */
export async function detectSilences(
  input: string,
  params: SilenceParams,
  options: DetectSilencesOptions = {},
): Promise<SilenceInterval[]> {
  const resolvedInput = await resolveInputFile(input);
  const args = silenceArgs(resolvedInput, params);
  if (
    options.durationMs !== undefined &&
    (!Number.isSafeInteger(options.durationMs) || options.durationMs < 0)
  ) {
    throw new AudioToolError('AUDIO_INVALID_ARGUMENT', 'durationMs must be a non-negative integer');
  }
  const durationMs =
    options.durationMs ??
    (await probeAudio(resolvedInput, { ...options, timeoutMs: undefined })).durationMs;
  const ffmpeg = options.ffmpeg ?? (await resolveTool('ffmpeg', options));
  const runner = options.runner ?? runTool;
  const result = await runner(ffmpeg.path, args, {
    tool: 'ffmpeg',
    timeoutMs: options.timeoutMs ?? DEFAULT_SILENCE_TIMEOUT_MS,
    signal: options.signal,
    logger: options.logger,
  });
  assertSuccess(result, 'ffmpeg', 'detecting silence');
  return parseSilenceDetect(result.stderr, durationMs);
}
