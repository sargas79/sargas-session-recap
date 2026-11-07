import { divRound, scaleDecimal, toSafeNumber } from './decimal.ts';
import { AudioToolError } from './errors.ts';
import { resolveInputFile } from './input.ts';
import { resolveTool, type AudioToolchainOptions, type ResolvedTool } from './locate.ts';
import { assertSuccess, runTool } from './run.ts';

export const DEFAULT_PROBE_TIMEOUT_MS = 60_000;

/** Facts about the first audio stream of a file. All values are integers. */
export interface AudioProbe {
  /** Duration in integer milliseconds, derived from `sampleCount / sampleRate` (rounded). */
  readonly durationMs: number;
  /** Samples per second, per channel. */
  readonly sampleRate: number;
  readonly channels: number;
  /** ffmpeg codec name, e.g. `pcm_s16le`, `flac`, `opus`. */
  readonly codec: string;
  /**
   * Samples per channel, as reported by the container. Exact for PCM WAV and
   * FLAC; for lossy formats it may include encoder delay/padding.
   */
  readonly sampleCount: number;
}

export interface AudioOperationOptions extends AudioToolchainOptions {
  /** Wall-clock limit for the operation's subprocess. */
  readonly timeoutMs?: number | undefined;
}

export interface ProbeOptions extends AudioOperationOptions {
  /** Already resolved ffprobe; skips lookup and the version check. */
  readonly ffprobe?: ResolvedTool | undefined;
}

/** Arguments for ffprobe. `input` must be absolute so it can never look like an option. */
export function probeArgs(input: string): string[] {
  return [
    '-hide_banner',
    '-v',
    'error',
    '-select_streams',
    'a:0',
    '-show_entries',
    'stream=index,codec_type,codec_name,sample_rate,channels,time_base,duration_ts,duration:format=duration',
    '-of',
    'json',
    input,
  ];
}

function parseFailed(message: string): AudioToolError {
  return new AudioToolError('AUDIO_PARSE_FAILED', `could not read ffprobe output: ${message}`, {
    tool: 'ffprobe',
    hint: 'make sure ffprobe matches the supported version (`recap doctor`) and the file is not corrupt',
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInt(value: unknown): number | undefined {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value)
        ? Number.parseInt(value, 10)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function nonNegativeBigInt(value: unknown): bigint | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return BigInt(value);
  }
  return undefined;
}

/** Sample count from `duration_ts * time_base * sample_rate`, exact rational arithmetic. */
function samplesFromTimestamps(stream: Record<string, unknown>, sampleRate: number) {
  const durationTs = nonNegativeBigInt(stream['duration_ts']);
  const timeBase = typeof stream['time_base'] === 'string' ? stream['time_base'] : undefined;
  const match = timeBase === undefined ? null : /^(\d+)\/(\d+)$/.exec(timeBase);
  if (durationTs === undefined || match === null) {
    return undefined;
  }
  const num = BigInt(match[1] ?? '0');
  const den = BigInt(match[2] ?? '0');
  if (num === 0n || den === 0n) {
    return undefined;
  }
  return divRound(durationTs * num * BigInt(sampleRate), den);
}

function samplesFromSeconds(value: unknown, sampleRate: number): bigint | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const samples = scaleDecimal(value, BigInt(sampleRate));
  return samples === undefined || samples < 0n ? undefined : samples;
}

/**
 * Parses `ffprobe -of json` output produced by {@link probeArgs}. Pure and
 * deterministic: identical JSON always gives identical integers.
 */
export function parseProbeJson(json: string): AudioProbe {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw parseFailed('not valid JSON');
  }
  if (!isRecord(parsed)) {
    throw parseFailed('expected a JSON object');
  }
  const streams = Array.isArray(parsed['streams']) ? (parsed['streams'] as unknown[]) : [];
  const stream = streams.find(
    (candidate): candidate is Record<string, unknown> =>
      isRecord(candidate) && (candidate['codec_type'] ?? 'audio') === 'audio',
  );
  if (stream === undefined) {
    throw new AudioToolError('AUDIO_NO_AUDIO_STREAM', 'the file has no audio stream', {
      tool: 'ffprobe',
      hint: 'check that the file is an audio recording (or a video with an audio track)',
    });
  }
  const codec = stream['codec_name'];
  if (typeof codec !== 'string' || codec.length === 0) {
    throw parseFailed('audio stream has no codec_name');
  }
  const sampleRate = positiveInt(stream['sample_rate']);
  if (sampleRate === undefined) {
    throw parseFailed('audio stream has no valid sample_rate');
  }
  const channels = positiveInt(stream['channels']);
  if (channels === undefined) {
    throw parseFailed('audio stream has no valid channels');
  }
  const format = isRecord(parsed['format']) ? parsed['format'] : {};
  const samples =
    samplesFromTimestamps(stream, sampleRate) ??
    samplesFromSeconds(stream['duration'], sampleRate) ??
    samplesFromSeconds(format['duration'], sampleRate);
  if (samples === undefined) {
    throw parseFailed('duration is unknown (the file may be truncated or a live stream)');
  }
  const sampleCount = toSafeNumber(samples);
  const durationMs = toSafeNumber(divRound(samples * 1000n, BigInt(sampleRate)));
  if (sampleCount === undefined || durationMs === undefined) {
    throw parseFailed('duration is out of range');
  }
  return { durationMs, sampleRate, channels, codec, sampleCount };
}

/** Probes the first audio stream of `input` with ffprobe. */
export async function probeAudio(input: string, options: ProbeOptions = {}): Promise<AudioProbe> {
  const resolvedInput = await resolveInputFile(input);
  const ffprobe = options.ffprobe ?? (await resolveTool('ffprobe', options));
  const runner = options.runner ?? runTool;
  const result = await runner(ffprobe.path, probeArgs(resolvedInput), {
    tool: 'ffprobe',
    timeoutMs: options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    signal: options.signal,
    logger: options.logger,
  });
  assertSuccess(result, 'ffprobe', 'probing the input');
  return parseProbeJson(result.stdout);
}
