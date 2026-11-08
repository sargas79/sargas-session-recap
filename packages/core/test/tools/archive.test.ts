import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractZip } from '../../src/tools/index.ts';
import { DLL, EXE, makeZip, workspace, type Workspace } from './helpers.ts';

let ws: Workspace;
let dest: string;

beforeEach(() => {
  ws = workspace();
  dest = path.join(ws.dir, 'staging');
  mkdirSync(dest);
});

afterEach(() => {
  ws.cleanup();
});

function zipFile(bytes: Buffer): string {
  const file = path.join(ws.dir, 'bin.zip');
  writeFileSync(file, bytes);
  return file;
}

const EXECUTABLE = 'bin/whisper-cli';
const WANTED = [EXECUTABLE, 'bin/whisper.dll'];
const GOOD = [
  { name: 'bin/whisper-cli', data: EXE },
  { name: 'bin/whisper.dll', data: DLL },
];

async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    return (error as { code: string }).code;
  }
  throw new Error('expected a rejection');
}

describe('extractZip', () => {
  it('extracts only the wanted files, keeping their relative paths', async () => {
    const zip = makeZip([...GOOD, { name: 'bin/bench.exe', data: Buffer.from('unrelated') }]);
    await extractZip(zipFile(zip), dest, WANTED, EXECUTABLE);
    expect(readFileSync(path.join(dest, 'bin', 'whisper-cli')).equals(EXE)).toBe(true);
    expect(readFileSync(path.join(dest, 'bin', 'whisper.dll')).equals(DLL)).toBe(true);
    expect(existsSync(path.join(dest, 'bin', 'bench.exe'))).toBe(false);
  });

  it.each([
    ['parent traversal', '../evil.dll'],
    ['nested traversal', 'bin/../../evil.dll'],
    ['backslash traversal', '..\\evil.dll'],
    ['absolute POSIX path', '/tmp/evil.dll'],
    ['drive path', 'C:\\Windows\\evil.dll'],
    ['alternate data stream', 'bin/a.dll:evil'],
    ['reserved device name', 'bin/nul.dll'],
  ])('rejects %s, writing nothing', async (_name, entry) => {
    const zip = makeZip([...GOOD, { name: entry, data: Buffer.from('evil') }]);
    expect(await rejection(extractZip(zipFile(zip), dest, WANTED, EXECUTABLE))).toBe(
      'TOOLS_ARCHIVE_UNSAFE',
    );
    expect(existsSync(path.join(dest, 'bin'))).toBe(false);
    expect(existsSync(path.join(ws.dir, 'evil.dll'))).toBe(false);
  });

  it('rejects a symlink entry', async () => {
    const zip = makeZip([...GOOD, { name: 'bin/link', data: Buffer.from('/etc'), symlink: true }]);
    expect(await rejection(extractZip(zipFile(zip), dest, WANTED, EXECUTABLE))).toBe(
      'TOOLS_ARCHIVE_UNSAFE',
    );
    expect(existsSync(path.join(dest, 'bin'))).toBe(false);
  });

  it('rejects duplicate entry names', async () => {
    const zip = makeZip([...GOOD, { name: 'bin/whisper.dll', data: Buffer.from('second') }]);
    expect(await rejection(extractZip(zipFile(zip), dest, WANTED, EXECUTABLE))).toBe(
      'TOOLS_ARCHIVE_UNSAFE',
    );
  });

  it('rejects an archive missing a wanted file', async () => {
    const zip = makeZip([{ name: 'bin/whisper-cli', data: EXE }]);
    expect(await rejection(extractZip(zipFile(zip), dest, WANTED, EXECUTABLE))).toBe(
      'TOOLS_ARCHIVE_INVALID',
    );
  });

  it('rejects a file that is not a zip', async () => {
    expect(
      await rejection(extractZip(zipFile(Buffer.from('not a zip')), dest, WANTED, EXECUTABLE)),
    ).toBe('TOOLS_ARCHIVE_INVALID');
  });
});
