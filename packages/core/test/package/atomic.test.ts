import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  commitFileAtomic,
  finalizeDirectory,
  isAtomicTempName,
  renameWithRetry,
  tempDirFor,
  tempPathFor,
  validatePackage,
  writeFileAtomic,
} from '../../src/package/index.ts';
import { makePackage } from './helpers.ts';

const atomicModule = pathToFileURL(
  path.resolve(import.meta.dirname, '../../src/package/atomic.ts'),
).href;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'recap-atomic-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const listing = () => readdirSync(dir).sort();

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe('writeFileAtomic', () => {
  it('creates and replaces a file, leaving no temp files', async () => {
    const target = path.join(dir, 'manifest.json');
    await writeFileAtomic(target, 'first');
    expect(readFileSync(target, 'utf8')).toBe('first');
    await writeFileAtomic(target, Buffer.from('second'));
    expect(readFileSync(target, 'utf8')).toBe('second');
    expect(listing()).toEqual(['manifest.json']);
  });

  it('keeps the original when the write fails before the rename (in-process)', async () => {
    const target = path.join(dir, 'manifest.json');
    writeFileSync(target, 'original');
    let seenTemp = '';
    await expect(
      writeFileAtomic(target, 'replacement that never lands', {
        hooks: {
          beforeRename: (temp) => {
            seenTemp = temp;
            // The complete new content exists only under the temp name.
            expect(readFileSync(temp, 'utf8')).toBe('replacement that never lands');
            expect(readFileSync(target, 'utf8')).toBe('original');
            throw new Error('simulated crash');
          },
        },
      }),
    ).rejects.toThrow('simulated crash');
    expect(isAtomicTempName(path.basename(seenTemp))).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('original');
    expect(listing()).toEqual(['manifest.json']);
  });

  it('survives a process killed right before the rename: no partial file, original intact', () => {
    const target = path.join(dir, 'manifest.json');
    writeFileSync(target, 'original');
    const script = `
      const { writeFileAtomic } = await import(${JSON.stringify(atomicModule)});
      await writeFileAtomic(${JSON.stringify(target)}, 'x'.repeat(1 << 20), {
        hooks: { beforeRename: () => process.exit(137) },
      });
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(137);
    expect(readFileSync(target, 'utf8')).toBe('original');
    // The dead process leaves its fsynced temp file behind; it is recognisably a temp name.
    const leftovers = listing().filter((name) => name !== 'manifest.json');
    expect(leftovers).toHaveLength(1);
    expect(isAtomicTempName(leftovers[0] ?? '')).toBe(true);
  });

  it('a crashed manifest write leaves a package that still validates, with a leftover warning', async () => {
    const pkg = makePackage();
    try {
      const target = pkg.file('manifest.json');
      const before = readFileSync(target, 'utf8');
      const script = `
        const { writeFileAtomic } = await import(${JSON.stringify(atomicModule)});
        await writeFileAtomic(${JSON.stringify(target)}, '{"half": ', {
          hooks: { beforeRename: () => process.exit(137) },
        });
      `;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script]);
      expect(result.status).toBe(137);
      expect(readFileSync(target, 'utf8')).toBe(before);
      const report = await validatePackage(pkg.root);
      expect(report.state).toBe('capturing');
      expect(report.issues.map((i) => i.code)).toContain('TEMP_LEFTOVER');
    } finally {
      pkg.cleanup();
    }
  });

  it('retries the rename on transient Windows lock errors', async () => {
    const target = path.join(dir, 'out.json');
    const codes = ['EBUSY', 'EPERM', 'EACCES'];
    const attempts: string[] = [];
    await writeFileAtomic(target, 'done', {
      retryDelaysMs: [1, 1, 1, 1],
      hooks: {
        rename: async (from, to) => {
          const code = codes[attempts.length];
          attempts.push(code ?? 'ok');
          if (code !== undefined) throw errno(code);
          const { rename } = await import('node:fs/promises');
          await rename(from, to);
        },
      },
    });
    expect(attempts).toEqual(['EBUSY', 'EPERM', 'EACCES', 'ok']);
    expect(readFileSync(target, 'utf8')).toBe('done');
  });

  it('gives up after the bounded retries and cleans up the temp file', async () => {
    const target = path.join(dir, 'out.json');
    writeFileSync(target, 'original');
    let calls = 0;
    await expect(
      writeFileAtomic(target, 'new', {
        retryDelaysMs: [1, 1],
        hooks: {
          rename: () => {
            calls += 1;
            return Promise.reject(errno('EBUSY'));
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'EBUSY' });
    expect(calls).toBe(3);
    expect(readFileSync(target, 'utf8')).toBe('original');
    expect(listing()).toEqual(['out.json']);
  });

  it('does not retry other errors', async () => {
    let calls = 0;
    await expect(
      renameWithRetry('a', 'b', {
        retryDelaysMs: [1, 1],
        hooks: {
          rename: () => {
            calls += 1;
            return Promise.reject(errno('ENOENT'));
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(calls).toBe(1);
  });
});

describe('commitFileAtomic', () => {
  it('moves a finished temp file over the target', async () => {
    const target = path.join(dir, 'decoded.wav');
    writeFileSync(target, 'old');
    const temp = tempPathFor(target);
    writeFileSync(temp, 'new');
    await commitFileAtomic(temp, target);
    expect(readFileSync(target, 'utf8')).toBe('new');
    expect(listing()).toEqual(['decoded.wav']);
  });

  it('refuses a temp file in another directory', async () => {
    mkdirSync(path.join(dir, 'other'));
    await expect(
      commitFileAtomic(path.join(dir, 'other', 'x.tmp'), path.join(dir, 'x')),
    ).rejects.toThrow('in the target directory');
  });
});

describe('finalizeDirectory', () => {
  it('renames a complete run directory into place and never overwrites one', async () => {
    const final = path.join(dir, '01JBX7Q8M2N4P6R8S0T2V4W6XY');
    const temp = tempDirFor(final);
    mkdirSync(path.join(temp, 'raw'), { recursive: true });
    writeFileSync(path.join(temp, 'segments.jsonl'), '');
    writeFileSync(path.join(temp, 'raw', 'chunk-0.json'), '{}');
    await finalizeDirectory(temp, final);
    expect(readdirSync(final).sort()).toEqual(['raw', 'segments.jsonl']);
    expect(listing()).toEqual(['01JBX7Q8M2N4P6R8S0T2V4W6XY']);

    const again = tempDirFor(final);
    mkdirSync(again);
    await expect(finalizeDirectory(again, final)).rejects.toMatchObject({ code: 'EEXIST' });
  });
});
