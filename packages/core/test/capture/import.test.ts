import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { validateContract, type Fragment, type Manifest } from '@sargas-recap/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importRecording, type ImportOptions, type ImportResult } from '../../src/capture/index.ts';
import { consentPolicyHash, parseCampaignConfig } from '../../src/config/index.ts';
import { createLogger } from '../../src/log/index.ts';
import { validatePackage } from '../../src/package/index.ts';
import {
  BASIC_MAPPING,
  CAMPAIGN_ID,
  campaignYaml,
  makeImportFixture,
  NOW,
  wavBytes,
  writeBasicTracks,
  type ImportFixture,
} from './helpers.ts';

let fx: ImportFixture;
let logs: string[];

beforeEach(() => {
  fx = makeImportFixture();
  logs = [];
});
afterEach(() => {
  fx.cleanup();
});

function options(overrides: Partial<ImportOptions> = {}): ImportOptions {
  return {
    dir: fx.dir,
    campaignId: CAMPAIGN_ID,
    sessionId: 's01',
    paths: fx.paths,
    toolVersion: '0.0.0-test',
    now: () => NOW,
    logger: createLogger({ sink: (line) => logs.push(line), level: 'debug' }),
    ...overrides,
  };
}

const sha = (file: string): string =>
  `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;

function readManifest(result: ImportResult): Manifest {
  return JSON.parse(
    readFileSync(path.join(result.packageDir, 'manifest.json'), 'utf8'),
  ) as Manifest;
}

function readFragments(result: ImportResult): Fragment[] {
  return readFileSync(path.join(result.packageDir, 'fragments.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Fragment);
}

/** Session directory entries (temp leftovers would show up here). */
function sessionsListing(): string[] {
  const dir = fx.paths.sessionsDir(CAMPAIGN_ID);
  return existsSync(dir) ? readdirSync(dir) : [];
}

describe('importRecording', () => {
  it('produces a sealed package that passes the package validator', async () => {
    writeBasicTracks(fx);
    fx.writeMapping(BASIC_MAPPING);
    const result = await importRecording(options());

    expect(result.packageDir).toBe(fx.sessionDir());
    expect(result.report.ok).toBe(true);
    expect(result.report.state).toBe('sealed');
    // The same validator `recap package validate` and the Discord bot output (T06) use.
    const report = await validatePackage(result.packageDir);
    expect(report.issues).toEqual([]);
    expect(report.state).toBe('sealed');

    const manifest = readManifest(result);
    expect(validateContract('manifest', manifest).ok).toBe(true);
    expect(manifest.source).toEqual({ kind: 'multitrack-import', tool_version: '0.0.0-test' });
    expect(manifest.package_id).toBe(result.packageId);
    expect(manifest.timeline).toEqual({
      origin: 'provisional',
      origin_uncertainty_ms: 0,
      discontinuities: [],
    });
    expect(manifest.seal?.artifacts.map((a) => a.path)).toEqual([
      'audio/gm/1.wav',
      'audio/player-ana/1.wav',
      'fragments.jsonl',
    ]);
    expect(sessionsListing()).toEqual(['s01']);
  });

  it('copies consent provenance (mode, provider, policy hash) from the receipt', async () => {
    writeBasicTracks(fx);
    fx.writeMapping(BASIC_MAPPING);
    const result = await importRecording(options());
    const policy = consentPolicyHash(parseCampaignConfig(campaignYaml()).value);
    expect(result.consent).toMatchObject({
      stage: 'recording',
      mode: 'records',
      provider: 'craig',
    });
    expect(readManifest(result).consent).toEqual(
      ['gm', 'player-ana'].map((speaker_id) => ({
        speaker_id,
        scopes: ['recording'],
        policy_hash: policy,
        mode: 'records',
        provider: 'craig',
        recorded_at: NOW.toISOString(),
      })),
    );
  });

  it('records per-track source offsets and timing per ADR-003', async () => {
    writeBasicTracks(fx);
    fx.writeTrack('1-gm-later.wav', wavBytes({ rate: 8000, samples: 4000 }));
    fx.writeMapping(`schema_version: 1
origin_uncertainty_ms: 25
default_timing_uncertainty_ms: 10
tracks:
  # Listed first but starts later: it becomes gm:2.
  - { file: 1-gm-later.wav, speaker_id: gm, start_offset_ms: 600000 }
  - { file: 1-gm.wav, speaker_id: gm }
  - file: 2-ana.wav
    speaker_id: player-ana
    start_offset_ms: -1500
    timing_uncertainty_ms: 40
    label: Track 2 (synthetic)
`);
    const result = await importRecording(options());
    const fragments = readFragments(result);
    expect(fragments).toEqual([
      {
        schema_version: 1,
        fragment_id: 'gm:1',
        speaker_id: 'gm',
        track_label: '1-gm.wav',
        path: 'audio/gm/1.wav',
        codec: 'pcm_s16le',
        sample_rate_hz: 8000,
        channels: 1,
        sample_count: 8000,
        duration_ms: 1000,
        fragment_start_offset_ms: 0,
        timing_uncertainty_ms: 10,
        status: 'complete',
      },
      expect.objectContaining({
        fragment_id: 'gm:2',
        path: 'audio/gm/2.wav',
        sample_count: 4000,
        duration_ms: 500,
        fragment_start_offset_ms: 600000,
        timing_uncertainty_ms: 10,
      }),
      expect.objectContaining({
        fragment_id: 'player-ana:1',
        track_label: 'Track 2 (synthetic)',
        sample_rate_hz: 16000,
        sample_count: 8000,
        duration_ms: 500,
        fragment_start_offset_ms: -1500,
        timing_uncertainty_ms: 40,
      }),
    ]);
    for (const f of fragments) expect(validateContract('fragment', f).ok).toBe(true);
    expect(readManifest(result).timeline.origin_uncertainty_ms).toBe(25);
    // The copy of gm:2 is the later track, not the first one listed for gm.
    expect(sha(path.join(result.packageDir, 'audio', 'gm', '2.wav'))).toBe(
      sha(fx.track('1-gm-later.wav')),
    );
  });

  it('leaves originals unmodified: hash before == copy == after', async () => {
    writeBasicTracks(fx);
    fx.writeMapping(BASIC_MAPPING);
    const before = ['1-gm.wav', '2-ana.wav'].map((n) => sha(fx.track(n)));
    const result = await importRecording(options());
    const after = ['1-gm.wav', '2-ana.wav'].map((n) => sha(fx.track(n)));
    expect(after).toEqual(before);
    const copies = ['audio/gm/1.wav', 'audio/player-ana/1.wav'].map((rel) =>
      sha(path.join(result.packageDir, ...rel.split('/'))),
    );
    expect(copies).toEqual(before);
    expect(result.imported.map((t) => t.hash)).toEqual(before);
    const sealed = readManifest(result).seal?.artifacts.filter((a) => a.kind === 'audio-fragment');
    expect(sealed?.map((a) => a.hash)).toEqual(before);
  });

  it('refuses when an original changes during the import and writes nothing', async () => {
    writeBasicTracks(fx);
    fx.writeMapping(BASIC_MAPPING);
    await expect(
      importRecording(
        options({
          hooks: {
            afterCopy: (source) => {
              appendFileSync(source, Buffer.alloc(2));
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'IMPORT_SOURCE_CHANGED' });
    expect(sessionsListing()).toEqual([]);
  });

  it('fails on a missing track, names the mapping entry and writes nothing', async () => {
    fx.writeTrack('1-gm.wav', wavBytes());
    const mapping = fx.writeMapping(BASIC_MAPPING);
    const error = await importRecording(options()).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'IMPORT_TRACK_MISSING' });
    expect((error as Error).message).toContain(`${mapping} /tracks/1/file`);
    expect(sessionsListing()).toEqual([]);
  });

  it('refuses a mapped track that is a folder', async () => {
    fx.writeTrack('1-gm.wav', wavBytes());
    mkdirSync(fx.track('2-ana.wav'));
    fx.writeMapping(BASIC_MAPPING);
    await expect(importRecording(options())).rejects.toMatchObject({
      code: 'IMPORT_TRACK_MISSING',
    });
  });

  it('excludes and reports audio files the mapping does not list', async () => {
    writeBasicTracks(fx);
    fx.writeTrack('3-stranger.flac', Buffer.from('not imported'));
    fx.writeTrack('notes.txt', Buffer.from('not audio'));
    fx.writeMapping(BASIC_MAPPING);
    const result = await importRecording(options());
    expect(result.excluded).toEqual([{ file: '3-stranger.flac', reason: 'unmapped' }]);
    expect(result.imported.map((t) => t.speakerId)).toEqual(['gm', 'player-ana']);
    expect(existsSync(path.join(result.packageDir, 'audio', 'player-zed'))).toBe(false);
  });

  it('excludes a track mapped to a speaker that is not in campaign.yaml', async () => {
    writeBasicTracks(fx);
    fx.writeTrack('9-zed.wav', wavBytes());
    fx.writeMapping(`${BASIC_MAPPING}  - { file: 9-zed.wav, speaker_id: player-zed }\n`);
    const result = await importRecording(options());
    expect(result.excluded).toEqual([
      { file: '9-zed.wav', speakerId: 'player-zed', reason: 'unknown-speaker' },
    ]);
    expect(result.consent.speaker_ids).toEqual(['gm', 'player-ana']);
    expect(readManifest(result).consent.map((c) => c.speaker_id)).toEqual(['gm', 'player-ana']);
    expect(readFragments(result).map((f) => f.speaker_id)).toEqual(['gm', 'player-ana']);
  });

  it('excludes non-consenting speakers in records mode with the refusal reason', async () => {
    writeBasicTracks(fx);
    fx.writeTrack('3-cora.wav', wavBytes());
    fx.writeTrack('4-dan.wav', wavBytes());
    fx.writeMapping(
      `${BASIC_MAPPING}  - { file: 3-cora.wav, speaker_id: player-cora }\n` +
        '  - { file: 4-dan.wav, speaker_id: player-dan }\n',
    );
    const result = await importRecording(options());
    expect(result.excluded).toEqual([
      { file: '3-cora.wav', speakerId: 'player-cora', reason: 'no-record' },
      { file: '4-dan.wav', speakerId: 'player-dan', reason: 'withdrawn' },
    ]);
    expect(readFragments(result).map((f) => f.speaker_id)).toEqual(['gm', 'player-ana']);
    expect(existsSync(path.join(result.packageDir, 'audio', 'player-cora'))).toBe(false);
    expect((await validatePackage(result.packageDir)).state).toBe('sealed');
  });

  it('accepts the same speakers in implied mode but still refuses unlisted ones', async () => {
    fx.writeCampaign(campaignYaml('implied'));
    writeBasicTracks(fx);
    fx.writeTrack('3-cora.wav', wavBytes());
    fx.writeTrack('4-dan.wav', wavBytes());
    fx.writeTrack('9-zed.wav', wavBytes());
    fx.writeMapping(
      `${BASIC_MAPPING}  - { file: 3-cora.wav, speaker_id: player-cora }\n` +
        '  - { file: 4-dan.wav, speaker_id: player-dan }\n' +
        '  - { file: 9-zed.wav, speaker_id: player-zed }\n',
    );
    const result = await importRecording(options());
    expect(result.excluded).toEqual([
      { file: '9-zed.wav', speakerId: 'player-zed', reason: 'unknown-speaker' },
    ]);
    expect(result.consent.mode).toBe('implied');
    const consent = readManifest(result).consent;
    expect(consent.map((c) => c.speaker_id)).toEqual([
      'gm',
      'player-ana',
      'player-cora',
      'player-dan',
    ]);
    expect(consent.every((c) => c.mode === 'implied')).toBe(true);
  });

  it('refuses the import when no speaker may be recorded', async () => {
    fx.writeTrack('3-cora.wav', wavBytes());
    fx.writeMapping(
      'schema_version: 1\ntracks:\n  - { file: 3-cora.wav, speaker_id: player-cora }\n',
    );
    const error = await importRecording(options()).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'IMPORT_NO_TRACKS' });
    expect((error as Error).message).toContain('player-cora');
    expect(sessionsListing()).toEqual([]);
  });

  it('refuses a recorder that is not the campaign recording provider', async () => {
    writeBasicTracks(fx);
    fx.writeMapping(`recorder: zoom-h6\n${BASIC_MAPPING}`);
    await expect(importRecording(options())).rejects.toMatchObject({
      code: 'CONSENT_PROVIDER_NOT_CONFIGURED',
    });
    expect(sessionsListing()).toEqual([]);
  });

  it('refuses re-import into an existing session unless replace is chosen', async () => {
    writeBasicTracks(fx);
    fx.writeMapping(BASIC_MAPPING);
    const first = await importRecording(options());
    const firstManifest = readFileSync(path.join(first.packageDir, 'manifest.json'), 'utf8');

    const error = await importRecording(options()).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'IMPORT_SESSION_EXISTS' });
    expect((error as Error).message).toContain('s01');
    expect(readFileSync(path.join(first.packageDir, 'manifest.json'), 'utf8')).toBe(firstManifest);

    const second = await importRecording(options({ replace: true, now: () => new Date() }));
    expect(second.replaced).toBe(true);
    expect(second.packageId).not.toBe(first.packageId);
    expect((await validatePackage(second.packageDir)).state).toBe('sealed');
    expect(sessionsListing()).toEqual(['s01']);
  });

  it('never replaces a package that holds derived work', async () => {
    writeBasicTracks(fx);
    fx.writeMapping(BASIC_MAPPING);
    const first = await importRecording(options());
    mkdirSync(path.join(first.packageDir, 'transcript'));
    await expect(importRecording(options({ replace: true }))).rejects.toMatchObject({
      code: 'IMPORT_SESSION_IN_USE',
    });
    expect(existsSync(path.join(first.packageDir, 'audio', 'gm', '1.wav'))).toBe(true);
  });

  it('detects tampering after import with the same validator', async () => {
    writeBasicTracks(fx);
    fx.writeMapping(BASIC_MAPPING);
    const result = await importRecording(options());
    appendFileSync(path.join(result.packageDir, 'audio', 'gm', '1.wav'), Buffer.alloc(2));
    expect((await validatePackage(result.packageDir)).state).toBe('corrupt');
  });

  it('refuses an unsupported codec with a fix and writes nothing', async () => {
    writeBasicTracks(fx);
    fx.writeMapping(BASIC_MAPPING);
    const error = await importRecording(
      options({
        probe: () =>
          Promise.resolve({
            codec: 'mp3',
            sampleRate: 44100,
            channels: 2,
            sampleCount: 44100,
            durationMs: 1000,
          }),
      }),
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'IMPORT_TRACK_UNSUPPORTED' });
    expect((error as { hint?: string }).hint).toContain('flac');
    expect(sessionsListing()).toEqual([]);
  });

  it('finds a JSON mapping and refuses when there is none or more than one', async () => {
    writeBasicTracks(fx);
    await expect(importRecording(options())).rejects.toMatchObject({
      code: 'IMPORT_MAPPING_NOT_FOUND',
    });
    fx.writeMapping(
      JSON.stringify({ schema_version: 1, tracks: [{ file: '1-gm.wav', speaker_id: 'gm' }] }),
      'recap-tracks.json',
    );
    const result = await importRecording(options());
    expect(result.imported.map((t) => t.fragmentId)).toEqual(['gm:1']);
    expect(result.excluded).toEqual([{ file: '2-ana.wav', reason: 'unmapped' }]);

    fx.writeMapping(BASIC_MAPPING);
    await expect(importRecording(options({ sessionId: 's02' }))).rejects.toMatchObject({
      code: 'IMPORT_MAPPING_AMBIGUOUS',
    });
  });

  it('accepts a mapping passed explicitly from elsewhere', async () => {
    writeBasicTracks(fx);
    const elsewhere = path.join(fx.base, 'my mapping.yaml');
    appendFileSync(elsewhere, BASIC_MAPPING);
    const result = await importRecording(options({ mappingFile: elsewhere }));
    expect(result.imported).toHaveLength(2);
  });

  it('reports mapping errors by position without echoing values', async () => {
    writeBasicTracks(fx);
    fx.writeMapping(
      'schema_version: 1\ntracks:\n  - { file: 1-gm.wav, speaker_id: SECRET-Value }\n' +
        '  - { file: 1-GM.wav, speaker_id: gm }\n',
    );
    const error = await importRecording(options()).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'CONFIG_INVALID', kind: 'import-mapping' });
    const message = (error as Error).message;
    expect(message).toContain('/tracks/0/speaker_id');
    expect(message).not.toContain('SECRET');
  });

  it('flags duplicate track entries ignoring case', async () => {
    writeBasicTracks(fx);
    fx.writeMapping(
      'schema_version: 1\ntracks:\n  - { file: 1-gm.wav, speaker_id: gm }\n' +
        '  - { file: 1-GM.wav, speaker_id: player-ana }\n',
    );
    const error = await importRecording(options()).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'CONFIG_INVALID' });
    expect((error as Error).message).toContain('/tracks/1/file: duplicates /tracks/0/file');
  });

  it('refuses a campaign.yaml of another campaign', async () => {
    writeBasicTracks(fx);
    fx.writeMapping(BASIC_MAPPING);
    fx.writeCampaign(campaignYaml().replace(`campaign_id: ${CAMPAIGN_ID}`, 'campaign_id: other'));
    await expect(importRecording(options())).rejects.toMatchObject({
      code: 'IMPORT_CAMPAIGN_MISMATCH',
    });
  });

  it('refuses a missing import directory and invalid IDs before touching anything', async () => {
    await expect(
      importRecording(options({ dir: path.join(fx.base, 'nope') })),
    ).rejects.toMatchObject({ code: 'IMPORT_DIR_NOT_FOUND' });
    await expect(importRecording(options({ sessionId: '../s01' }))).rejects.toMatchObject({
      code: 'PATHS_INVALID_ID',
    });
    expect(existsSync(fx.paths.sessionsDir(CAMPAIGN_ID))).toBe(false);
  });

  it('logs only allowlisted fields (no file names, paths or speakers)', async () => {
    writeBasicTracks(fx);
    fx.writeTrack('3-stranger.wav', wavBytes());
    fx.writeMapping(BASIC_MAPPING);
    await importRecording(options());
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) {
      const record = JSON.parse(line) as Record<string, unknown>;
      expect(record['redacted']).toBeUndefined();
      expect(line).not.toMatch(/stranger|1-gm|player-ana|Craig/);
    }
    expect(logs.map((l) => (JSON.parse(l) as { event: string }).event)).toEqual([
      'import.completed',
      'import.excluded',
    ]);
  });
});
