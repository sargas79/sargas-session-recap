/**
 * Import against a real ffprobe/ffmpeg (FLAC tracks, which the JS WAV reader does not handle).
 *
 * Like test/audio/integration.test.ts: synthetic audio is generated at test time, nothing is
 * committed. Locally the suite is skipped when ffmpeg is missing; in CI (`CI` set) the audio
 * integration suite already fails on a missing ffmpeg, so this one only skips.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AudioToolError,
  probeAudio,
  resolveAudioToolchain,
  runTool,
  type AudioToolchain,
} from '../../src/audio/index.ts';
import { importRecording, probeWavHeader } from '../../src/capture/index.ts';
import { validatePackage } from '../../src/package/index.ts';
import { CAMPAIGN_ID, makeImportFixture, NOW, wavBytes, type ImportFixture } from './helpers.ts';

const toolchain: AudioToolchain | undefined = await resolveAudioToolchain().catch(
  (error: unknown) => {
    if (error instanceof AudioToolError) return undefined;
    throw error;
  },
);
const SKIP_LABEL = toolchain === undefined ? ' (SKIPPED: ffmpeg/ffprobe not found)' : '';

describe.runIf(toolchain !== undefined)(`recap import with real ffprobe${SKIP_LABEL}`, () => {
  let fx: ImportFixture;
  beforeEach(() => {
    fx = makeImportFixture();
  });
  afterEach(() => {
    fx.cleanup();
  });

  const tools = () => ({ ffmpeg: toolchain?.ffmpeg, ffprobe: toolchain?.ffprobe });

  it('the JS WAV header reader agrees with ffprobe', async () => {
    fx.writeTrack('stereo.wav', wavBytes({ rate: 48_000, channels: 2, samples: 12_345 }));
    const file = fx.track('stereo.wav');
    expect(await probeWavHeader(file)).toEqual(await probeAudio(file, tools()));
  });

  it('imports FLAC tracks byte for byte and the package validates', async () => {
    fx.writeTrack('gm.wav', wavBytes({ rate: 48_000, samples: 48_000 }));
    const flac = fx.track('1-gm.flac');
    const encoded = await runTool(
      toolchain?.ffmpeg.path ?? 'ffmpeg',
      [
        '-hide_banner',
        '-nostdin',
        '-v',
        'error',
        '-y',
        '-i',
        fx.track('gm.wav'),
        '-c:a',
        'flac',
        flac,
      ],
      { tool: 'ffmpeg', timeoutMs: 60_000 },
    );
    expect(encoded.exitCode, encoded.stderr).toBe(0);
    fx.writeMapping('schema_version: 1\ntracks:\n  - { file: 1-gm.flac, speaker_id: gm }\n');

    const result = await importRecording({
      dir: fx.dir,
      campaignId: CAMPAIGN_ID,
      sessionId: 's01',
      paths: fx.paths,
      toolVersion: '0.0.0-test',
      now: () => NOW,
      audio: tools(),
    });
    expect(result.imported).toEqual([
      expect.objectContaining({ fragmentId: 'gm:1', path: 'audio/gm/1.flac', codec: 'flac' }),
    ]);
    expect(result.excluded).toEqual([{ file: 'gm.wav', reason: 'unmapped' }]);
    const copy = path.join(result.packageDir, 'audio', 'gm', '1.flac');
    expect(readFileSync(copy).equals(readFileSync(flac))).toBe(true);
    const report = await validatePackage(result.packageDir);
    expect(report.state).toBe('sealed');
    const fragment = JSON.parse(
      readFileSync(path.join(result.packageDir, 'fragments.jsonl'), 'utf8'),
    ) as { sample_count: number; sample_rate_hz: number };
    expect(fragment.sample_rate_hz).toBe(48_000);
    expect(fragment.sample_count).toBe(48_000);
  });
});
