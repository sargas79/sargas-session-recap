import { spawnSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  UnsafePathError,
  checkRelPath,
  findCaseCollisions,
  isReservedWindowsName,
  realPackageRoot,
  resolveInsidePackage,
} from '../../src/package/index.ts';
import { makePackage, type TempPackage } from './helpers.ts';

describe('checkRelPath (lexical)', () => {
  it.each([
    ['manifest.json'],
    ['fragments.jsonl'],
    ['audio/player-a/0.wav'],
    ['transcript/01JBX7Q8M2N4P6R8S0T2V4W6XY/segments.jsonl'],
    ['audio/console/0.wav'], // "console" is not "CON"
    ['audio/com10/0.wav'], // only COM0-9 are reserved
    ['audio/a.b.c'],
  ])('accepts %s', (rel) => {
    expect(checkRelPath(rel)).toBeUndefined();
  });

  it.each([
    ['', 'PATH_EMPTY'],
    ['a/'.repeat(121) + 'a', 'PATH_TOO_LONG'],
    ['../outside.wav', 'PATH_TRAVERSAL'],
    ['audio/../../outside.wav', 'PATH_TRAVERSAL'],
    ['audio/./0.wav', 'PATH_TRAVERSAL'],
    ['..', 'PATH_TRAVERSAL'],
    ['/etc/passwd', 'PATH_ABSOLUTE'],
    ['\\Windows\\win.ini', 'PATH_ABSOLUTE'],
    ['C:\\Windows\\win.ini', 'PATH_DRIVE'],
    ['C:/Windows/win.ini', 'PATH_DRIVE'],
    ['C:foo', 'PATH_DRIVE'],
    ['c:audio/0.wav', 'PATH_DRIVE'],
    ['\\\\server\\share\\a.wav', 'PATH_UNC'],
    ['//server/share/a.wav', 'PATH_UNC'],
    ['\\\\?\\C:\\a.wav', 'PATH_DEVICE'],
    ['\\\\.\\PhysicalDrive0', 'PATH_DEVICE'],
    ['//?/C:/a.wav', 'PATH_DEVICE'],
    ['audio\\player-a\\0.wav', 'PATH_BACKSLASH'],
    ['audio//0.wav', 'PATH_EMPTY_SEGMENT'],
    ['a.wav:x', 'PATH_STREAM'],
    ['audio/0.wav:Zone.Identifier:$DATA', 'PATH_STREAM'],
    ['CON', 'PATH_RESERVED_NAME'],
    ['audio/nul', 'PATH_RESERVED_NAME'],
    ['audio/NUL.wav', 'PATH_RESERVED_NAME'],
    ['audio/con.tar.gz', 'PATH_RESERVED_NAME'],
    ['audio/Com1.wav', 'PATH_RESERVED_NAME'],
    ['audio/LPT9', 'PATH_RESERVED_NAME'],
    ['aux/0.wav', 'PATH_RESERVED_NAME'],
    ['audio/CON .wav', 'PATH_RESERVED_NAME'],
    ['audio/0.wav.', 'PATH_TRAILING_DOT_OR_SPACE'],
    ['audio/0.wav ', 'PATH_TRAILING_DOT_OR_SPACE'],
    ['audio./0.wav', 'PATH_TRAILING_DOT_OR_SPACE'],
    ['audio/.hidden', 'PATH_INVALID_CHARS'],
    ['audio/a*b.wav', 'PATH_INVALID_CHARS'],
    ['audio/sa\u00edda.wav', 'PATH_INVALID_CHARS'],
  ])('rejects %j as %s', (rel, code) => {
    expect(checkRelPath(rel)?.code).toBe(code);
  });

  it('never repeats the path in its message', () => {
    const marker = 'SECRET-NAME';
    for (const rel of [
      `../${marker}`,
      `C:${marker}`,
      `${marker}:x`,
      `${marker}.`,
      `\\\\${marker}`,
    ]) {
      const problem = checkRelPath(rel);
      expect(problem).toBeDefined();
      expect(problem?.message).not.toContain(marker);
    }
  });

  it('knows the reserved device names', () => {
    expect(isReservedWindowsName('CONIN$')).toBe(true);
    expect(isReservedWindowsName('prn.txt')).toBe(true);
    expect(isReservedWindowsName('com\u00b9')).toBe(true);
    expect(isReservedWindowsName('cons')).toBe(false);
  });
});

describe('findCaseCollisions', () => {
  it('groups paths that differ only by case', () => {
    expect(findCaseCollisions(['audio/A/0.wav', 'audio/a/0.wav', 'audio/b/0.wav'])).toEqual([
      ['audio/A/0.wav', 'audio/a/0.wav'],
    ]);
    expect(findCaseCollisions(['x', 'x', 'y'])).toEqual([]);
  });
});

/** Directory link: a junction on Windows (no admin needed), a symlink elsewhere. */
function linkDir(target: string, link: string): boolean {
  if (process.platform === 'win32') {
    const result = spawnSync('cmd', ['/c', 'mklink', '/J', link, target], { encoding: 'utf8' });
    return result.status === 0;
  }
  symlinkSync(target, link, 'dir');
  return true;
}

function linkFile(target: string, link: string): boolean {
  try {
    symlinkSync(target, link, 'file');
    return true;
  } catch {
    return false; // Windows without Developer Mode / admin
  }
}

describe('resolveInsidePackage (on disk)', () => {
  let pkg: TempPackage;
  let realRoot: string;

  beforeEach(async () => {
    pkg = makePackage();
    realRoot = await realPackageRoot(pkg.root);
    mkdirSync(path.join(pkg.base, 'outside'));
    writeFileSync(path.join(pkg.base, 'outside', 'secret.wav'), 'outside');
  });
  afterEach(() => {
    pkg.cleanup();
  });

  it('resolves existing and missing files inside the root', async () => {
    const existing = await resolveInsidePackage(realRoot, 'audio/gm/0.wav');
    expect(existing.exists).toBe(true);
    expect(existing.real).toBe(path.join(realRoot, 'audio', 'gm', '0.wav'));
    const missing = await resolveInsidePackage(realRoot, 'transcript/x/segments.jsonl');
    expect(missing.exists).toBe(false);
    expect(missing.real).toBeUndefined();
  });

  it('rejects lexically unsafe paths before touching the disk', async () => {
    await expect(resolveInsidePackage(realRoot, '../outside/secret.wav')).rejects.toThrow(
      UnsafePathError,
    );
    await expect(resolveInsidePackage(realRoot, 'C:outside')).rejects.toMatchObject({
      code: 'PATH_DRIVE',
    });
  });

  it('rejects a junction / directory symlink that escapes the root', async (ctx) => {
    const link = path.join(pkg.root, 'audio', 'escape');
    if (!linkDir(path.join(pkg.base, 'outside'), link)) {
      ctx.skip('could not create a junction with `cmd /c mklink /J`; skipping the escape test');
      return;
    }
    await expect(resolveInsidePackage(realRoot, 'audio/escape/secret.wav')).rejects.toMatchObject({
      code: 'PATH_ESCAPES_ROOT',
    });
    // Also for a file that does not exist behind the link: the existing ancestor escapes.
    await expect(resolveInsidePackage(realRoot, 'audio/escape/new.wav')).rejects.toMatchObject({
      code: 'PATH_ESCAPES_ROOT',
    });
  });

  it('allows a directory link that stays inside the root', async (ctx) => {
    const link = path.join(pkg.root, 'audio', 'alias');
    if (!linkDir(path.join(pkg.root, 'audio', 'gm'), link)) {
      ctx.skip('could not create a junction with `cmd /c mklink /J`; skipping');
      return;
    }
    const resolved = await resolveInsidePackage(realRoot, 'audio/alias/0.wav');
    expect(resolved.real).toBe(path.join(realRoot, 'audio', 'gm', '0.wav'));
  });

  it('rejects a file symlink that escapes the root', async (ctx) => {
    const link = path.join(pkg.root, 'audio', 'gm', 'link.wav');
    if (!linkFile(path.join(pkg.base, 'outside', 'secret.wav'), link)) {
      ctx.skip('file symlinks need Developer Mode or admin on Windows; skipping');
      return;
    }
    await expect(resolveInsidePackage(realRoot, 'audio/gm/link.wav')).rejects.toMatchObject({
      code: 'PATH_ESCAPES_ROOT',
    });
  });

  it('rejects a dangling symlink', async (ctx) => {
    const link = path.join(pkg.root, 'audio', 'gm', 'dangling.wav');
    if (!linkFile(path.join(pkg.base, 'nowhere.wav'), link)) {
      ctx.skip('file symlinks need Developer Mode or admin on Windows; skipping');
      return;
    }
    await expect(resolveInsidePackage(realRoot, 'audio/gm/dangling.wav')).rejects.toMatchObject({
      code: 'PATH_ESCAPES_ROOT',
    });
  });

  it.runIf(process.platform === 'win32' || process.platform === 'darwin')(
    'rejects a path whose case differs from the file on disk',
    async () => {
      await expect(resolveInsidePackage(realRoot, 'audio/GM/0.wav')).rejects.toMatchObject({
        code: 'PATH_CASE_MISMATCH',
      });
    },
  );
});
