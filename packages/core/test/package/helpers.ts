/**
 * Synthetic session packages for tests. Everything is generated in a temp dir: tiny PCM WAVs
 * (a few hundred samples of a sine), synthetic IDs, no real audio or transcripts.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Fragment, Manifest } from '@sargas-recap/contracts';

export const PACKAGE_ID = '01JBX6ZZ0A1B2C3D4E5F6G7H8J';
const POLICY_HASH = `sha256:${'a'.repeat(64)}`;

/** 16-bit mono PCM WAV of `samples` samples of a 440 Hz sine at `rate` Hz. */
export function tinyWav(samples = 160, rate = 8000, seed = 0): Buffer {
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    data.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * (i + seed)) / rate)), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export function baseManifest(): Manifest {
  return {
    schema_version: 1,
    campaign_id: 'test-campaign',
    session_id: 's01',
    package_id: PACKAGE_ID,
    created_at: '2026-11-01T19:00:00.000Z',
    lifecycle: 'capturing',
    source: { kind: 'multitrack-import', tool_version: '0.0.0' },
    timeline: { origin: 'provisional', origin_uncertainty_ms: 0, discontinuities: [] },
    consent: [
      {
        speaker_id: 'gm',
        scopes: ['recording', 'asr', 'classification', 'recap'],
        policy_hash: POLICY_HASH,
        recorded_at: '2026-11-01T18:55:00.000Z',
      },
      {
        speaker_id: 'player-a',
        scopes: ['recording', 'asr', 'classification', 'recap'],
        policy_hash: POLICY_HASH,
        recorded_at: '2026-11-01T18:55:00.000Z',
      },
    ],
  };
}

export function fragment(speaker: string, n: number, samples = 160): Fragment {
  return {
    schema_version: 1,
    fragment_id: `${speaker}:${n}`,
    speaker_id: speaker,
    track_label: `Track ${speaker}`,
    path: `audio/${speaker}/${n}.wav`,
    codec: 'pcm_s16le',
    sample_rate_hz: 8000,
    channels: 1,
    sample_count: samples,
    duration_ms: Math.floor((samples * 1000) / 8000),
    fragment_start_offset_ms: 0,
    timing_uncertainty_ms: 0,
    status: 'complete',
  };
}

export const jsonl = (records: readonly unknown[]): string =>
  records.map((r) => JSON.stringify(r)).join('\n') + '\n';

export interface TempPackage {
  /** Parent temp dir (also holds things "outside" the package for escape tests). */
  readonly base: string;
  /** The package directory. */
  readonly root: string;
  readonly file: (rel: string) => string;
  readonly write: (rel: string, data: string | Buffer) => void;
  readonly cleanup: () => void;
}

/** A capturing package with two speakers and three tiny WAV fragments. */
export function makePackage(): TempPackage {
  const base = mkdtempSync(path.join(tmpdir(), 'recap-pkg-'));
  const root = path.join(base, 'package');
  mkdirSync(root);
  const file = (rel: string) => path.join(root, ...rel.split('/'));
  const write = (rel: string, data: string | Buffer) => {
    mkdirSync(path.dirname(file(rel)), { recursive: true });
    writeFileSync(file(rel), data);
  };
  const fragments = [fragment('gm', 0), fragment('player-a', 0), fragment('player-a', 1, 80)];
  fragments.forEach((f, i) => {
    write(f.path, tinyWav(f.sample_count, 8000, i));
  });
  write('fragments.jsonl', jsonl(fragments));
  write('manifest.json', `${JSON.stringify(baseManifest(), null, 2)}\n`);
  return {
    base,
    root,
    file,
    write,
    cleanup: () => {
      rmSync(base, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}
