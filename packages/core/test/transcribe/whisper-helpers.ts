/**
 * Synthetic world for the transcribe stage: a sealed package with tiny generated audio, the fake
 * whisper script, and seams replacing ffmpeg and the T23 lock check. No real audio or transcripts.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Fragment } from '@sargas-recap/contracts';
import type { ResolvedTool } from '../../src/audio/index.ts';
import { defineStages, type StageRegistry } from '../../src/jobs/stage.ts';
import { sealPackage } from '../../src/package/lifecycle.ts';
import type { WhisperTools } from '../../src/tools/inspect.ts';
import { createChunkPlanStage, type DetectPauses } from '../../src/transcribe/chunk-plan-stage.ts';
import {
  createTranscribeStage,
  type TranscribeStageOptions,
} from '../../src/transcribe/transcribe-stage.ts';
import { baseManifest, jsonl, tinyWav } from '../package/helpers.ts';

export const FAKE_WHISPER = fileURLToPath(new URL('./fake-whisper.mjs', import.meta.url));
export const CAMPAIGN = 'synthetic-vaults';
export const SESSION = 's01';

const sha = (text: string): string => `sha256:${createHash('sha256').update(text).digest('hex')}`;

export const fakeTools: WhisperTools = {
  version: 'v0-fake',
  commit: 'fake',
  binaryPath: process.execPath,
  binaryHash: sha('fake-binary'),
  modelId: 'fake-model',
  modelPath: 'fake-model.bin',
  modelHash: sha('fake-model'),
  warnings: [],
};

const fakeFfmpeg = { path: 'ffmpeg', source: 'path', version: { raw: '9.0.2' } };

/** Stands in for ffmpeg: a 16 kHz WAV as long as the 8 kHz source. */
const syntheticDecode = (source: string, target: string): Promise<void> => {
  const samples = (readFileSync(source).length - 44) / 2;
  writeFileSync(target, tinyWav(samples * 2, 16_000));
  return Promise.resolve();
};

export function stageOptions(
  control: string,
  overrides: Partial<TranscribeStageOptions> = {},
): TranscribeStageOptions {
  return {
    resolveTools: () => Promise.resolve(fakeTools),
    resolveFfmpeg: () => Promise.resolve(fakeFfmpeg as unknown as ResolvedTool),
    decode: syntheticDecode,
    whisperPrefixArgs: [FAKE_WHISPER, control],
    ...overrides,
  };
}

/** player-ana:0 has a pause long enough to be removed, so its chunk has two pieces. */
const detectPauses: DetectPauses = (_path, fragment) =>
  Promise.resolve(
    fragment.fragment_id === 'player-ana:0' ? [{ startMs: 8_000, endMs: 12_000 }] : [],
  );

export function stagesFor(
  control: string,
  overrides?: Partial<TranscribeStageOptions>,
): StageRegistry {
  return defineStages([
    createChunkPlanStage({
      detect: detectPauses,
      resolveFfmpeg: () => Promise.resolve(fakeFfmpeg as unknown as ResolvedTool),
    }),
    createTranscribeStage(stageOptions(control, overrides)),
  ]);
}

function syntheticFragment(id: string, durationMs: number, offsetMs: number): Fragment {
  const speaker = id.slice(0, id.lastIndexOf(':'));
  const n = id.slice(id.lastIndexOf(':') + 1);
  return {
    schema_version: 1,
    fragment_id: id,
    speaker_id: speaker,
    track_label: `Track ${speaker}`,
    path: `audio/${speaker}/${n}.wav`,
    codec: 'pcm_s16le',
    sample_rate_hz: 8000,
    channels: 1,
    sample_count: durationMs * 8,
    duration_ms: durationMs,
    fragment_start_offset_ms: offsetMs,
    timing_uncertainty_ms: 50,
    status: 'complete',
  };
}

const FRAGMENTS = [
  syntheticFragment('gm:0', 3_000, 0),
  syntheticFragment('gm:1', 3_000, 100_000),
  syntheticFragment('player-ana:0', 20_000, 5_000),
  // Overlaps the previous fragment, so it cannot share a chunk: a third chunk.
  syntheticFragment('player-ana:1', 3_000, 10_000),
];

/** A sealed package at `root`, speakers matching the synthetic campaign fixture. */
export async function writeSealedSession(root: string): Promise<void> {
  const write = (rel: string, data: string | Buffer): void => {
    const file = path.join(root, ...rel.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, data);
  };
  for (const [i, f] of FRAGMENTS.entries()) write(f.path, tinyWav(f.sample_count, 8000, i));
  write('fragments.jsonl', jsonl(FRAGMENTS));
  const manifest = baseManifest();
  manifest.campaign_id = CAMPAIGN;
  manifest.session_id = SESSION;
  manifest.consent = manifest.consent.map((c) =>
    c.speaker_id === 'player-a' ? { ...c, speaker_id: 'player-ana' } : c,
  );
  write('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  await sealPackage(root);
}
