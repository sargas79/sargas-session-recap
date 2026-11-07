/**
 * Integration tests against a real ffmpeg/ffprobe.
 *
 * Synthetic audio (sine + silence) is generated at test time with ffmpeg's
 * `lavfi` sources; no audio is committed. Locally the suite is skipped when
 * ffmpeg is missing. In CI (`CI` env var set) a missing ffmpeg is a failure,
 * because the workflow installs it.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AudioToolError,
  decodeToPcm16kMono,
  detectSilences,
  probeAudio,
  resolveAudioToolchain,
  runTool,
  type AudioToolchain,
} from '../../src/audio/index.ts';

const toolchain: AudioToolchain | AudioToolError = await resolveAudioToolchain().catch(
  (error: unknown) => {
    if (error instanceof AudioToolError) {
      return error;
    }
    throw error;
  },
);
const tools = toolchain instanceof AudioToolError ? undefined : toolchain;
const inCi = (process.env['CI'] ?? '') !== '';

if (tools === undefined && !inCi) {
  process.stderr.write(
    `\n[audio integration] SKIPPED: ${(toolchain as AudioToolError).message}. ` +
      'Install FFmpeg (winget install Gyan.FFmpeg) or set RECAP_FFMPEG/RECAP_FFPROBE to run them.\n\n',
  );
}

describe.runIf(tools === undefined && inCi)('audio integration prerequisites (CI)', () => {
  it('has ffmpeg and ffprobe installed by the workflow', () => {
    expect.fail(
      `ffmpeg/ffprobe must be available in CI: ${(toolchain as AudioToolError).toUserMessage()}`,
    );
  });
});

const SKIP_LABEL = tools === undefined ? ' (SKIPPED: ffmpeg/ffprobe not found)' : '';

// 0-1 s sine, 1-2 s silence, 2-3 s sine, 3-4.5 s trailing silence; 48 kHz stereo.
const SOURCE_RATE = 48_000;
const SOURCE_SAMPLES = 216_000; // 4.5 s
const TONE = '0.5*sin(2*PI*440*t)*(lt(t,1)+between(t,2,3))';
const SILENCE = { thresholdDb: -30, minSilenceMs: 500 } as const;

describe.runIf(tools !== undefined)(`audio toolchain with real ffmpeg${SKIP_LABEL}`, () => {
  const toolOptions = () => ({
    ffmpeg: tools?.ffmpeg,
    ffprobe: tools?.ffprobe,
  });
  let root = '';
  let dir = '';
  let source = '';

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'recap-audio-'));
    // Spaces and non-ASCII characters in both the directory and the file name.
    dir = path.join(root, 'ação teste');
    mkdirSync(dir);
    source = path.join(dir, 'áudio.wav');
    const ffmpeg = tools?.ffmpeg.path ?? 'ffmpeg';
    const result = await runTool(
      ffmpeg,
      [
        '-hide_banner',
        '-nostdin',
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `aevalsrc=exprs='${TONE}|${TONE}':s=${SOURCE_RATE}:d=5`,
        '-af',
        `atrim=end_sample=${SOURCE_SAMPLES}`,
        '-c:a',
        'pcm_s16le',
        '-bitexact',
        source,
      ],
      { tool: 'ffmpeg', timeoutMs: 60_000 },
    );
    expect(result.exitCode, result.stderr).toBe(0);
  });

  afterAll(() => {
    if (root !== '') {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it('reports versions that meet the minimum', () => {
    expect(tools?.ffmpeg.version.raw.length).toBeGreaterThan(0);
    expect(tools?.ffprobe.version.raw.length).toBeGreaterThan(0);
  });

  it('probes the synthetic source exactly, with integers', async () => {
    const probe = await probeAudio(source, toolOptions());
    expect(probe).toEqual({
      durationMs: 4500,
      sampleRate: SOURCE_RATE,
      channels: 2,
      codec: 'pcm_s16le',
      sampleCount: SOURCE_SAMPLES,
    });
    expect(await probeAudio(source, toolOptions())).toEqual(probe);
  });

  it('decodes to 16 kHz mono PCM deterministically, via temp file + rename', async () => {
    const first = path.join(dir, 'saída 16k.wav');
    const second = path.join(dir, 'saída 16k (2).wav');
    await decodeToPcm16kMono(source, first, toolOptions());
    await decodeToPcm16kMono(source, second, toolOptions());

    const probe = await probeAudio(first, toolOptions());
    expect(probe.sampleRate).toBe(16_000);
    expect(probe.channels).toBe(1);
    expect(probe.codec).toBe('pcm_s16le');
    expect(Number.isSafeInteger(probe.sampleCount)).toBe(true);
    expect(Math.abs(probe.sampleCount - 72_000)).toBeLessThanOrEqual(64);
    expect(Math.abs(probe.durationMs - 4500)).toBeLessThanOrEqual(4);

    expect(readFileSync(first).equals(readFileSync(second))).toBe(true);
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('overwrites an existing destination', async () => {
    const target = path.join(dir, 'overwrite.wav');
    writeFileSync(target, 'old content');
    await decodeToPcm16kMono(source, target, toolOptions());
    expect(readFileSync(target).subarray(0, 4).toString('latin1')).toBe('RIFF');
  });

  it('detects the middle and trailing silences in integer ms, deterministically', async () => {
    const silences = await detectSilences(source, SILENCE, toolOptions());
    expect(silences).toHaveLength(2);
    const [middle, trailing] = silences;
    expect(Math.abs((middle?.startMs ?? -1) - 1000)).toBeLessThanOrEqual(2);
    expect(Math.abs((middle?.endMs ?? -1) - 2000)).toBeLessThanOrEqual(2);
    expect(Math.abs((trailing?.startMs ?? -1) - 3000)).toBeLessThanOrEqual(2);
    expect(trailing?.endMs).toBe(4500);
    for (const interval of silences) {
      expect(Number.isSafeInteger(interval.startMs)).toBe(true);
      expect(Number.isSafeInteger(interval.endMs)).toBe(true);
    }
    expect(await detectSilences(source, SILENCE, toolOptions())).toEqual(silences);
  });

  it('detects the same silences on the decoded 16 kHz file', async () => {
    const decoded = path.join(dir, 'silence check.wav');
    await decodeToPcm16kMono(source, decoded, toolOptions());
    const silences = await detectSilences(decoded, SILENCE, toolOptions());
    expect(silences).toHaveLength(2);
    expect(Math.abs((silences[0]?.startMs ?? -1) - 1000)).toBeLessThanOrEqual(3);
    expect(Math.abs((silences[1]?.startMs ?? -1) - 3000)).toBeLessThanOrEqual(3);
  });

  it('reports a non-audio input as AUDIO_PROCESS_FAILED and leaves nothing behind', async () => {
    const bogus = path.join(dir, 'not audio.wav');
    writeFileSync(bogus, 'this is not a RIFF file');
    const target = path.join(dir, 'never written.wav');
    const error = await decodeToPcm16kMono(bogus, target, toolOptions()).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AudioToolError);
    expect((error as AudioToolError).code).toBe('AUDIO_PROCESS_FAILED');
    expect(readdirSync(dir)).not.toContain('never written.wav');
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('times out with AUDIO_TIMEOUT and cleans up the temp file', async () => {
    const target = path.join(dir, 'timeout.wav');
    const error = await decodeToPcm16kMono(source, target, {
      ...toolOptions(),
      timeoutMs: 1,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AudioToolError);
    expect((error as AudioToolError).code).toBe('AUDIO_TIMEOUT');
    expect(readdirSync(dir)).not.toContain('timeout.wav');
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});
