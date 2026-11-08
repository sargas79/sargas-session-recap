import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Manifest } from '@sargas-recap/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PackageError,
  formatIssue,
  planAudioPurge,
  purgeAudio,
  sealPackage,
  sha256Bytes,
  sha256File,
  validatePackage,
  writeManifest,
  type PackageIssue,
  type PackageReport,
} from '../../src/package/index.ts';
import { createLogger } from '../../src/log/index.ts';
import { fragment, jsonl, makePackage, tinyWav, type TempPackage } from './helpers.ts';

const NOW = () => new Date('2026-11-07T12:00:00.000Z');

let pkg: TempPackage;

beforeEach(() => {
  pkg = makePackage();
});
afterEach(() => {
  pkg.cleanup();
});

const readManifest = (): Manifest =>
  JSON.parse(readFileSync(pkg.file('manifest.json'), 'utf8')) as Manifest;

const errors = (report: PackageReport): PackageIssue[] =>
  report.issues.filter((i) => i.severity === 'error');

const codes = (report: PackageReport): string[] => report.issues.map((i) => i.code);

function expectNoValueEcho(report: PackageReport, marker: string): void {
  const text = report.issues.map(formatIssue).join('\n') + JSON.stringify(report.issues);
  expect(text).not.toContain(marker);
}

describe('hashing', () => {
  it('streams files to sha256:<hex>', async () => {
    expect(sha256Bytes('abc')).toBe(
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    const wav = tinyWav(4000);
    pkg.write('audio/gm/big.wav', wav);
    const digest = await sha256File(pkg.file('audio/gm/big.wav'));
    expect(digest).toEqual({ hash: sha256Bytes(wav), bytes: wav.length });
  });
});

describe('validatePackage', () => {
  it('accepts a well-formed capturing package', async () => {
    const report = await validatePackage(pkg.root);
    expect(errors(report)).toEqual([]);
    expect(report.state).toBe('capturing');
    expect(report.sources).toEqual([
      'audio/gm/0.wav',
      'audio/player-a/0.wav',
      'audio/player-a/1.wav',
      'fragments.jsonl',
    ]);
  });

  it('reports a missing package and a missing manifest', async () => {
    const gone = await validatePackage(path.join(pkg.base, 'nope'));
    expect(gone.state).toBe('invalid');
    expect(gone.issues[0]?.code).toBe('PACKAGE_NOT_FOUND');
    rmSync(pkg.file('manifest.json'));
    const report = await validatePackage(pkg.root);
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: 'FILE_MISSING', file: 'manifest.json' }),
    );
  });

  it('reports corrupt JSON without quoting it', async () => {
    writeFileSync(pkg.file('manifest.json'), '{"campaign_id": "SECRET-VALUE", ');
    const report = await validatePackage(pkg.root);
    expect(report.state).toBe('invalid');
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: 'INVALID_JSON', file: 'manifest.json', field: '' }),
    );
    expectNoValueEcho(report, 'SECRET-VALUE');
  });

  it('names the file, line and field of contract errors, never the value', async () => {
    const bad = { ...fragment('gm', 0), codec: 'SECRET-CODEC', track_label: '' };
    pkg.write('fragments.jsonl', jsonl([bad, fragment('player-a', 0), fragment('player-a', 1)]));
    const manifest = { ...readManifest(), session_id: 'SECRET Session' };
    writeFileSync(pkg.file('manifest.json'), JSON.stringify(manifest));
    const report = await validatePackage(pkg.root);
    expect(report.state).toBe('invalid');
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: 'CONTRACT', file: 'manifest.json', field: '/session_id' }),
    );
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: 'CONTRACT',
        file: 'fragments.jsonl',
        line: 1,
        field: '/codec',
      }),
    );
    expect(report.issues).toContainEqual(
      expect.objectContaining({ file: 'fragments.jsonl', line: 1, field: '/track_label' }),
    );
    expectNoValueEcho(report, 'SECRET');
    const codecIssue = report.issues.find((i) => i.field === '/codec');
    if (codecIssue === undefined) throw new Error('no /codec issue');
    expect(formatIssue(codecIssue)).toMatch(/^error {3}fragments\.jsonl:1 \/codec: must be one of/);
  });

  it('checks cross-field rules: ID prefixes, layout, duplicates, missing audio', async () => {
    const wrongSpeaker = { ...fragment('gm', 0), fragment_id: 'player-a:7' };
    const wrongDir = { ...fragment('player-a', 0), path: 'audio/gm/x.wav' };
    const missing = fragment('player-a', 5);
    const duplicate = fragment('player-a', 1);
    pkg.write('fragments.jsonl', jsonl([wrongSpeaker, wrongDir, missing, duplicate, duplicate]));
    const report = await validatePackage(pkg.root);
    const found = report.issues.map((i) => `${i.code} ${i.line ?? ''} ${i.field}`);
    expect(found).toContain('INCONSISTENT 1 /fragment_id');
    expect(found).toContain('INCONSISTENT 2 /path');
    expect(found).toContain('DUPLICATE 5 /fragment_id');
    expect(found).toContain('DUPLICATE 5 /path');
    expect(found).toContain('FRAGMENT_AUDIO_MISSING  /path');
    expect(codes(report)).toContain('AUDIO_UNREFERENCED');
  });

  it('rejects Windows-unsafe paths in records and on disk', async () => {
    const reserved = { ...fragment('gm', 0), path: 'audio/gm/CON.wav' };
    const trailing = { ...fragment('gm', 1), path: 'audio/gm/1.wav.' };
    pkg.write('fragments.jsonl', jsonl([reserved, trailing]));
    const report = await validatePackage(pkg.root);
    const unsafe = report.issues.filter((i) => i.code === 'UNSAFE_PATH');
    expect(unsafe.map((i) => i.line)).toEqual([1, 2]);
    expect(unsafe[0]?.message).toContain('reserved Windows device names');
  });

  it('validates derived run directories and their ID scope', async () => {
    const run = '01JBX7Q8M2N4P6R8S0T2V4W6XY';
    const other = '01JBX7Q8M2N4P6R8S0T2V4W6XZ';
    pkg.write(`transcript/${run}/segments.jsonl`, '{"schema_version": 1}\n');
    pkg.write('transcript/not-a-ulid/segments.jsonl', '');
    pkg.write(`classify/${other}/.keep`, '');
    pkg.write(`recap/.1.123.0123abcd.tmp/recap.json`, '');
    const report = await validatePackage(pkg.root);
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: 'CONTRACT',
        file: `transcript/${run}/segments.jsonl`,
        line: 1,
        field: '/transcription_run_id',
      }),
    );
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: 'UNSAFE_PATH', file: 'transcript' }),
    );
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: 'FILE_MISSING', file: `classify/${other}/results.jsonl` }),
    );
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: 'TEMP_LEFTOVER', file: 'recap', severity: 'warning' }),
    );
  });
});

describe('seal', () => {
  it('hashes source artifacts into the manifest and moves to sealed', async () => {
    const lines: string[] = [];
    const result = await sealPackage(pkg.root, {
      now: NOW,
      logger: createLogger({ sink: (line) => lines.push(line) }),
    });
    expect(result.report.state).toBe('sealed');
    expect(result.artifacts).toBe(4);
    const manifest = readManifest();
    expect(manifest.lifecycle).toBe('sealed');
    expect(manifest.seal?.sealed_at).toBe('2026-11-07T12:00:00.000Z');
    const gm = manifest.seal?.artifacts.find((a) => a.path === 'audio/gm/0.wav');
    expect(gm).toEqual({
      path: 'audio/gm/0.wav',
      kind: 'audio-fragment',
      ...(await sha256File(pkg.file('audio/gm/0.wav'))),
    });
    expect(manifest.seal?.artifacts.map((a) => a.kind)).toContain('fragments-index');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ event: 'package.sealed', count: 4 });
    expect(lines[0]).not.toContain(pkg.root.replaceAll('\\', '\\\\'));

    const again = await validatePackage(pkg.root);
    expect(again.ok).toBe(true);
    expect(again.state).toBe('sealed');
  });

  it('seals foundry.jsonl when present', async () => {
    const event = {
      schema_version: 1,
      event_id: 'fvtt:01JBX7A0B1C2D3E4F5G6H7J8K9:0',
      capture_id: '01JBX7A0B1C2D3E4F5G6H7J8K9',
      seq: 0,
      campaign_id: 'test-campaign',
      session_id: 's01',
      world_id: 'world',
      writer_user_id: 'AbCdEfGhIjKlMnOp',
      foundry_version: '14.0',
      system_id: 'pf2e',
      system_version: '7.0.0',
      type: 'core.roll',
      observed_at_unix_ms: 1793559731000,
      clock_uncertainty_ms: 10,
      payload: {},
    };
    pkg.write('foundry.jsonl', jsonl([event]));
    await sealPackage(pkg.root, { now: NOW });
    expect(readManifest().seal?.artifacts).toContainEqual(
      expect.objectContaining({ path: 'foundry.jsonl', kind: 'foundry-events' }),
    );
  });

  it('refuses to seal twice or to seal an invalid package', async () => {
    await sealPackage(pkg.root, { now: NOW });
    await expect(sealPackage(pkg.root)).rejects.toMatchObject({ code: 'ALREADY_SEALED' });

    const other = makePackage();
    try {
      other.write('fragments.jsonl', 'not json\n');
      const error = (await sealPackage(other.root).catch((e: unknown) => e)) as PackageError;
      expect(error).toBeInstanceOf(PackageError);
      expect(error.code).toBe('PACKAGE_INVALID');
      expect(error.issues[0]).toMatchObject({ code: 'INVALID_JSON', file: 'fragments.jsonl' });
      expect(readFileSync(other.file('manifest.json'), 'utf8')).toContain('"capturing"');
    } finally {
      other.cleanup();
    }
  });

  it('refuses to seal when a junction or symlink escapes the root', async (ctx) => {
    const outside = path.join(pkg.base, 'outside');
    const link = pkg.file('audio/escape');
    let ok: boolean;
    if (process.platform === 'win32') {
      spawnSync('cmd', ['/c', 'mkdir', outside]);
      ok = spawnSync('cmd', ['/c', 'mklink', '/J', link, outside]).status === 0;
    } else {
      const { mkdirSync, symlinkSync } = await import('node:fs');
      mkdirSync(outside);
      symlinkSync(outside, link, 'dir');
      ok = true;
    }
    if (!ok) {
      ctx.skip('could not create a junction with `cmd /c mklink /J`; skipping');
      return;
    }
    writeFileSync(path.join(outside, 'x.wav'), tinyWav());
    await expect(sealPackage(pkg.root)).rejects.toMatchObject({ code: 'PACKAGE_INVALID' });
    const report = await validatePackage(pkg.root);
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: 'UNSAFE_PATH', file: 'audio/escape' }),
    );
  });

  describe('detects any later modification of source artifacts', () => {
    beforeEach(async () => {
      await sealPackage(pkg.root, { now: NOW });
    });

    it('a flipped byte (same size)', async () => {
      const file = pkg.file('audio/player-a/0.wav');
      const bytes = readFileSync(file);
      bytes[60] = (bytes[60] ?? 0) ^ 0xff;
      writeFileSync(file, bytes);
      const report = await validatePackage(pkg.root);
      expect(report.state).toBe('corrupt');
      expect(errors(report)).toEqual([
        expect.objectContaining({
          code: 'ARTIFACT_MODIFIED',
          file: 'audio/player-a/0.wav',
          message: expect.stringContaining('/hash') as unknown,
        }),
      ]);
    });

    it('a truncated or appended file', async () => {
      appendFileSync(pkg.file('fragments.jsonl'), '\n');
      const report = await validatePackage(pkg.root);
      expect(report.state).toBe('corrupt');
      expect(report.issues).toContainEqual(
        expect.objectContaining({ code: 'ARTIFACT_MODIFIED', file: 'fragments.jsonl' }),
      );
    });

    it('a deleted file (no purge provenance)', async () => {
      rmSync(pkg.file('audio/gm/0.wav'));
      const report = await validatePackage(pkg.root);
      expect(report.state).toBe('corrupt');
      expect(report.issues).toContainEqual(
        expect.objectContaining({ code: 'ARTIFACT_MISSING', file: 'audio/gm/0.wav' }),
      );
    });

    it('an added source file', async () => {
      pkg.write('audio/gm/9.wav', tinyWav());
      pkg.write('foundry.jsonl', '');
      const report = await validatePackage(pkg.root);
      expect(report.state).toBe('corrupt');
      const unsealed = report.issues
        .filter((i) => i.code === 'ARTIFACT_UNSEALED')
        .map((i) => i.file);
      expect(unsealed).toEqual(['audio/gm/9.wav', 'foundry.jsonl']);
    });

    it('a tampered seal entry', async () => {
      const manifest = readManifest();
      const seal = manifest.seal;
      if (seal === undefined) throw new Error('no seal');
      const tampered: Manifest = {
        ...manifest,
        seal: {
          ...seal,
          artifacts: seal.artifacts.map((a, i) =>
            i === 0 ? { ...a, hash: `sha256:${'0'.repeat(64)}` } : a,
          ),
        },
      };
      writeFileSync(pkg.file('manifest.json'), JSON.stringify(tampered));
      const report = await validatePackage(pkg.root);
      expect(report.state).toBe('corrupt');
    });
  });
});

describe('purge-audio', () => {
  beforeEach(async () => {
    await sealPackage(pkg.root, { now: NOW });
  });

  it('refuses an unsealed package', async () => {
    const other = makePackage();
    try {
      await expect(purgeAudio(other.root)).rejects.toMatchObject({ code: 'NOT_SEALED' });
      expect(existsSync(other.file('audio/gm/0.wav'))).toBe(true);
    } finally {
      other.cleanup();
    }
  });

  it('deletes audio, records provenance and validates as audio-purged', async () => {
    const sealed = readManifest().seal?.artifacts ?? [];
    const plan = await planAudioPurge(pkg.root);
    expect(plan.files.map((f) => f.path)).toEqual([
      'audio/gm/0.wav',
      'audio/player-a/0.wav',
      'audio/player-a/1.wav',
    ]);
    const lines: string[] = [];
    const result = await purgeAudio(pkg.root, {
      purgedBy: 'gm',
      reason: 'retention-policy',
      now: NOW,
      logger: createLogger({ sink: (line) => lines.push(line) }),
    });
    expect(result.deleted).toBe(3);
    expect(result.report.state).toBe('audio-purged');
    expect(existsSync(pkg.file('audio'))).toBe(false);
    expect(existsSync(pkg.file('fragments.jsonl'))).toBe(true);

    const manifest = readManifest();
    expect(manifest.lifecycle).toBe('audio-purged');
    expect(manifest.seal?.artifacts).toEqual(sealed); // the seal is never rewritten
    expect(manifest.purge).toEqual({
      purged_at: '2026-11-07T12:00:00.000Z',
      purged_by: 'gm',
      reason: 'retention-policy',
      purged_artifacts: sealed
        .filter((a) => a.kind === 'audio-fragment')
        .map((a) => ({ path: a.path, hash: a.hash })),
    });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      event: 'package.audio-purged',
      count: 3,
      status: 'audio-purged',
    });

    const report = await validatePackage(pkg.root);
    expect(report.ok).toBe(true);
    expect(report.state).toBe('audio-purged');
    expect(report.issues).toEqual([]);

    await expect(purgeAudio(pkg.root)).rejects.toMatchObject({ code: 'ALREADY_PURGED' });
  });

  it('a purged package whose fragments index is then modified is corrupt, not purged', async () => {
    await purgeAudio(pkg.root, { purgedBy: 'gm', now: NOW });
    appendFileSync(pkg.file('fragments.jsonl'), jsonl([fragment('gm', 3)]));
    const report = await validatePackage(pkg.root);
    expect(report.state).toBe('corrupt');
  });

  it('a purge record that does not match the seal is reported', async () => {
    await purgeAudio(pkg.root, { purgedBy: 'gm', now: NOW });
    const manifest = readManifest();
    const purge = manifest.purge;
    if (purge === undefined) throw new Error('no purge');
    const wrong: Manifest = {
      ...manifest,
      purge: {
        ...purge,
        purged_artifacts: [{ path: 'audio/gm/0.wav', hash: `sha256:${'1'.repeat(64)}` }],
      },
    };
    writeFileSync(pkg.file('manifest.json'), JSON.stringify(wrong));
    const report = await validatePackage(pkg.root);
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: 'PURGE_MISMATCH',
        file: 'manifest.json',
        field: '/purge/purged_artifacts/0/hash',
      }),
    );
    // The other two sealed audio files are now unexplained.
    expect(report.state).toBe('corrupt');
  });

  it('finishes an interrupted purge (provenance written, files not yet deleted)', async () => {
    // Simulate a crash between the manifest write and the deletions.
    const manifest = readManifest();
    const audio = (manifest.seal?.artifacts ?? []).filter((a) => a.kind === 'audio-fragment');
    await writeManifest(pkg.root, {
      ...manifest,
      lifecycle: 'audio-purged',
      purge: {
        purged_at: NOW().toISOString(),
        purged_by: 'gm',
        reason: 'consent-withdrawn',
        purged_artifacts: audio.map((a) => ({ path: a.path, hash: a.hash })),
      },
    });
    rmSync(pkg.file('audio/gm/0.wav')); // one deletion happened before the crash
    const interrupted = await validatePackage(pkg.root);
    expect(interrupted.state).toBe('audio-purged');
    expect(interrupted.issues.filter((i) => i.code === 'PURGE_INCOMPLETE')).toHaveLength(2);

    const result = await purgeAudio(pkg.root);
    expect(result.deleted).toBe(2);
    expect(result.report.issues).toEqual([]);
    expect(readManifest().purge?.reason).toBe('consent-withdrawn');
  });

  it('refuses to purge a corrupt package', async () => {
    writeFileSync(pkg.file('audio/gm/0.wav'), 'tampered');
    await expect(purgeAudio(pkg.root)).rejects.toMatchObject({ code: 'PACKAGE_INVALID' });
    expect(existsSync(pkg.file('audio/player-a/0.wav'))).toBe(true);
  });
});
