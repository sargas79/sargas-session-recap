/**
 * Synthetic multitrack recordings for import tests. Everything is generated at test time in a temp
 * dir: sine and silence 16-bit PCM WAVs written by a tiny JS WAV writer (no ffmpeg), a synthetic
 * campaign.yaml and a track mapping. No real audio, people or consent.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDataPaths, type DataPaths } from '../../src/paths/index.ts';

export interface WavSpec {
  readonly rate?: number;
  readonly channels?: number;
  /** Samples per channel. */
  readonly samples?: number;
  /** `sine` (440 Hz) or digital silence. */
  readonly kind?: 'sine' | 'silence';
  readonly freq?: number;
}

/** 16-bit PCM WAV bytes (`WAVE_FORMAT_PCM`, 44-byte header). */
export function wavBytes(spec: WavSpec = {}): Buffer {
  const rate = spec.rate ?? 8000;
  const channels = spec.channels ?? 1;
  const samples = spec.samples ?? rate / 4;
  const freq = spec.freq ?? 440;
  const data = Buffer.alloc(samples * channels * 2);
  if (spec.kind !== 'silence') {
    for (let i = 0; i < samples; i += 1) {
      const value = Math.round(8000 * Math.sin((2 * Math.PI * freq * i) / rate));
      for (let c = 0; c < channels; c += 1) data.writeInt16LE(value, (i * channels + c) * 2);
    }
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export const CAMPAIGN_ID = 'test-vaults';
export const NOW = new Date('2026-11-08T20:00:00.000Z');

/**
 * Synthetic campaign: `gm` and `player-ana` consented to recording with craig, `player-cora` has
 * no records, `player-dan` withdrew. `player-zed` is not a speaker at all.
 */
export function campaignYaml(mode: 'records' | 'implied' = 'records'): string {
  return `# SYNTHETIC test campaign
schema_version: 1
campaign_id: ${CAMPAIGN_ID}
system: pf2e
language: pt-BR
consent_mode: ${mode}
provider:
  recording: craig
  asr: whisper-local
  classification: claude-cli
  recap: claude-cli
speakers:
  - speaker_id: gm
    role: gm
    consent:
      - { purpose: recording, provider: craig, granted_on: 2026-01-10 }
  - speaker_id: player-ana
    role: player
    consent:
      - { purpose: recording, provider: craig, granted_on: 2026-01-10 }
  - speaker_id: player-cora
    role: player
  - speaker_id: player-dan
    role: player
    consent:
      - { purpose: recording, provider: craig, granted_on: 2026-01-10, withdrawn_on: 2026-03-01 }
`;
}

export interface ImportFixture {
  readonly base: string;
  /** Folder with the tracks (the import source). */
  readonly dir: string;
  readonly dataRoot: string;
  readonly paths: DataPaths;
  readonly campaignFile: string;
  readonly track: (name: string) => string;
  readonly writeTrack: (name: string, data: Buffer) => void;
  readonly writeMapping: (text: string, name?: string) => string;
  readonly writeCampaign: (text: string) => void;
  readonly sessionDir: (session?: string) => string;
  readonly cleanup: () => void;
}

/** Temp import folder + data root with campaign.yaml in its default location. */
export function makeImportFixture(): ImportFixture {
  const base = mkdtempSync(path.join(tmpdir(), 'recap-import-'));
  const dir = path.join(base, 'Craig export (synthetic)');
  const dataRoot = path.join(base, 'data root');
  mkdirSync(dir);
  const paths = createDataPaths(dataRoot);
  const campaignFile = paths.campaignConfigFile(CAMPAIGN_ID);
  mkdirSync(path.dirname(campaignFile), { recursive: true });
  writeFileSync(campaignFile, campaignYaml());
  const track = (name: string) => path.join(dir, name);
  return {
    base,
    dir,
    dataRoot,
    paths,
    campaignFile,
    track,
    writeTrack: (name, data) => {
      writeFileSync(track(name), data);
    },
    writeMapping: (text, name = 'recap-tracks.yaml') => {
      const file = path.join(dir, name);
      writeFileSync(file, text);
      return file;
    },
    writeCampaign: (text) => {
      writeFileSync(campaignFile, text);
    },
    sessionDir: (session = 's01') => paths.sessionDir(CAMPAIGN_ID, session),
    cleanup: () => {
      rmSync(base, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

/** Standard mapping: gm (sine, offset 0) and player-ana (silence, offset -1500). */
export const BASIC_MAPPING = `schema_version: 1
default_timing_uncertainty_ms: 10
tracks:
  - file: 1-gm.wav
    speaker_id: gm
  - file: 2-ana.wav
    speaker_id: player-ana
    start_offset_ms: -1500
    timing_uncertainty_ms: 40
`;

export function writeBasicTracks(fx: ImportFixture): void {
  fx.writeTrack('1-gm.wav', wavBytes({ rate: 8000, samples: 8000, kind: 'sine' }));
  fx.writeTrack('2-ana.wav', wavBytes({ rate: 16000, samples: 8000, kind: 'silence' }));
}
