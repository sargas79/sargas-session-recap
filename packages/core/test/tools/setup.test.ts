import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ToolsLock } from '@sargas-recap/contracts';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  confirmOnTerminal,
  registerSetupCommands,
  runWhisperSetup,
  type PlannedDownload,
} from '../../src/tools/index.ts';
import {
  archiveLock,
  DLL,
  EXE,
  fixtureServer,
  localBuildLock,
  makeZip,
  MODEL_A,
  sha,
  workspace,
  type FixtureServer,
  type Workspace,
} from './helpers.ts';

let ws: Workspace;
let server: FixtureServer;

const ZIP = makeZip([
  { name: 'whisper-cli', data: EXE },
  { name: 'whisper.dll', data: DLL },
]);

async function serve(routes: Parameters<typeof fixtureServer>[0]): Promise<void> {
  await server.close();
  server = await fixtureServer(routes);
}

beforeEach(async () => {
  ws = workspace();
  server = await fixtureServer({
    '/ggml-a.bin': { kind: 'ok', body: MODEL_A },
    '/bin.zip': { kind: 'ok', body: ZIP },
  });
});

afterEach(async () => {
  await server.close();
  ws.cleanup();
  process.exitCode = undefined;
});

const yes = (): Promise<boolean> => Promise.resolve(true);

/** A GM build directory holding the pinned files. */
function buildDir(exe: Buffer = EXE): string {
  const dir = path.join(ws.dir, 'wvk', 'bin', 'Release');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'whisper-cli'), exe);
  writeFileSync(path.join(dir, 'whisper.dll'), DLL);
  return dir;
}

function tree(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    return (error as { code: string }).code;
  }
  throw new Error('expected a rejection');
}

describe('confirmation gate', () => {
  it('downloads nothing and makes no request when declined', async () => {
    let seen: readonly PlannedDownload[] = [];
    const result = await runWhisperSetup({
      lock: localBuildLock(server),
      paths: ws.paths,
      confirm: (downloads) => {
        seen = downloads;
        return Promise.resolve(false);
      },
    });
    expect(result.status).toBe('declined');
    expect(server.requests).toEqual([]);
    expect(existsSync(ws.paths.whisperModelsDir)).toBe(false);
    // What the prompt shows: file, source and size.
    expect(seen).toEqual([
      expect.objectContaining({
        fileName: 'ggml-a.bin',
        url: server.url('/ggml-a.bin'),
        bytes: MODEL_A.length,
        replaces: false,
      }),
    ]);
  });

  it('does not ask when everything is already in place', async () => {
    const lock = localBuildLock(server);
    await runWhisperSetup({ lock, paths: ws.paths, fromBuild: buildDir(), confirm: yes });
    const requests = server.requests.length;
    let asked = false;
    const result = await runWhisperSetup({
      lock,
      paths: ws.paths,
      confirm: () => {
        asked = true;
        return Promise.resolve(true);
      },
    });
    expect(result.status).toBe('ready');
    expect(asked).toBe(false);
    expect(server.requests.length).toBe(requests);
  });

  it('terminal confirmation is No without a TTY, and accepts only y/yes on one', async () => {
    const errors: string[] = [];
    const io = {
      out: () => undefined,
      err: (text: string) => {
        errors.push(text);
      },
    };
    const piped = new PassThrough();
    piped.end('yes\n');
    expect(await confirmOnTerminal(io, piped)).toBe(false);
    expect(errors.join('')).toContain('interactive terminal');

    const ask = async (answer: string): Promise<boolean> => {
      const stream = new PassThrough();
      Object.defineProperty(stream, 'isTTY', { value: true });
      const result = confirmOnTerminal(io, stream);
      stream.write(`${answer}\n`);
      return result;
    };
    expect(await ask('y')).toBe(true);
    expect(await ask('YES')).toBe(true);
    expect(await ask('')).toBe(false);
    expect(await ask('nope')).toBe(false);
  });
});

describe('local-build binary', () => {
  it('downloads the model and reports the build as a manual step', async () => {
    const result = await runWhisperSetup({
      lock: localBuildLock(server),
      paths: ws.paths,
      confirm: yes,
    });
    expect(result.status).toBe('binary-needs-build');
    expect(readFileSync(ws.paths.whisperModelFile('ggml-a.bin')).equals(MODEL_A)).toBe(true);
  });

  it('adopts a build that matches the pin', async () => {
    const lock = localBuildLock(server);
    const result = await runWhisperSetup({
      lock,
      paths: ws.paths,
      fromBuild: buildDir(),
      confirm: yes,
    });
    expect(result.status).toBe('ready');
    expect(tree(ws.paths.whisperBuildDir('v1.9.5-vulkan'))).toEqual(['whisper-cli', 'whisper.dll']);
  });

  it('refuses a rebuild with a new hash and prints the block to repin it', async () => {
    const rebuilt = Buffer.from('a rebuild that differs');
    let hint: string;
    try {
      await runWhisperSetup({
        lock: localBuildLock(server),
        paths: ws.paths,
        fromBuild: buildDir(rebuilt),
        confirm: yes,
      });
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as { code: string }).code).toBe('TOOLS_BUILD_MISMATCH');
      hint = (error as { hint: string }).hint;
    }
    expect(hint).toContain(sha(rebuilt));
    expect(tree(ws.paths.whisperDir)).toEqual([]);
  });

  it('refuses a build directory that lacks a pinned file', async () => {
    const dir = path.join(ws.dir, 'empty');
    mkdirSync(dir);
    expect(
      await code(
        runWhisperSetup({
          lock: localBuildLock(server),
          paths: ws.paths,
          fromBuild: dir,
          confirm: yes,
        }),
      ),
    ).toBe('TOOLS_BUILD_MISMATCH');
  });
});

describe('archive binary', () => {
  it('downloads, verifies, extracts, installs and removes the archive', async () => {
    const lock = archiveLock(server, ZIP);
    const result = await runWhisperSetup({ lock, paths: ws.paths, confirm: yes });
    expect(result.status).toBe('ready');
    expect(tree(ws.paths.whisperBuildDir('v1.9.5-vulkan'))).toEqual(['whisper-cli', 'whisper.dll']);
    expect(tree(ws.paths.whisperDir)).toEqual(['models', 'v1.9.5-vulkan']);
  });

  it('rejects and deletes a tampered archive before extracting it', async () => {
    const tampered = makeZip([
      { name: 'whisper-cli', data: Buffer.from('evil') },
      { name: 'whisper.dll', data: DLL },
    ]);
    await serve({ '/bin.zip': { kind: 'ok', body: tampered } });
    const lock = archiveLock(server, ZIP);
    expect(await code(runWhisperSetup({ lock, paths: ws.paths, confirm: yes }))).toBe(
      'TOOLS_DOWNLOAD_INCOMPLETE',
    );
    expect(tree(ws.paths.whisperDir)).toEqual([]);
  });

  it('rejects a pinned archive with a traversal entry and cleans up', async () => {
    const evil = makeZip([
      { name: 'whisper-cli', data: EXE },
      { name: 'whisper.dll', data: DLL },
      { name: '../../evil', data: Buffer.from('x') },
    ]);
    await serve({
      '/bin.zip': { kind: 'ok', body: evil },
      '/ggml-a.bin': { kind: 'ok', body: MODEL_A },
    });
    const lock = archiveLock(server, evil);
    expect(await code(runWhisperSetup({ lock, paths: ws.paths, confirm: yes }))).toBe(
      'TOOLS_ARCHIVE_UNSAFE',
    );
    expect(tree(ws.paths.whisperDir)).toEqual([]);
    expect(existsSync(path.join(ws.paths.toolsDir, 'evil'))).toBe(false);
  });

  it('replaces a tampered install after confirmation', async () => {
    const lock = archiveLock(server, ZIP);
    await runWhisperSetup({ lock, paths: ws.paths, confirm: yes });
    writeFileSync(path.join(ws.paths.whisperBuildDir('v1.9.5-vulkan'), 'whisper.dll'), 'tampered');
    let replaces: boolean | undefined;
    const result = await runWhisperSetup({
      lock,
      paths: ws.paths,
      confirm: (downloads) => {
        replaces = downloads[0]?.replaces;
        return Promise.resolve(true);
      },
    });
    expect(replaces).toBe(true);
    expect(result.status).toBe('ready');
    expect(
      readFileSync(path.join(ws.paths.whisperBuildDir('v1.9.5-vulkan'), 'whisper.dll')).equals(DLL),
    ).toBe(true);
  });
});

describe('recap setup whisper (CLI)', () => {
  function run(lock: ToolsLock, confirm: () => Promise<boolean>, args: string[] = []) {
    const out: string[] = [];
    const err: string[] = [];
    const lockFile = path.join(ws.dir, 'tools.lock.json');
    writeFileSync(lockFile, JSON.stringify(lock));
    const program = new Command();
    registerSetupCommands(
      program,
      {
        out: (t) => {
          out.push(t);
        },
        err: (t) => {
          err.push(t);
        },
      },
      { lockFile, confirm },
    );
    return program
      .parseAsync(['setup', 'whisper', '--data-root', ws.paths.root, ...args], { from: 'user' })
      .then(() => ({ out: out.join(''), err: err.join('') }));
  }

  it('shows file, source and size, then exits 1 when declined', async () => {
    const { out } = await run(localBuildLock(server), () => Promise.resolve(false));
    expect(out).toContain('ggml-a.bin');
    expect(out).toContain(server.url('/ggml-a.bin'));
    expect(out).toContain(`${String(MODEL_A.length)} bytes`);
    expect(out).toContain('nothing was downloaded');
    expect(process.exitCode).toBe(1);
    expect(server.requests).toEqual([]);
  });

  it('prints the manual build step when only the binary is left', async () => {
    const { err } = await run(localBuildLock(server), yes);
    expect(err).toContain('manual step');
    expect(err).toContain('-DGGML_VULKAN=ON');
    expect(err).toContain('--from-build');
    expect(process.exitCode).toBe(1);
  });

  it('finishes with exit 0 once binary and model verify', async () => {
    const { out } = await run(localBuildLock(server), yes, ['--from-build', buildDir()]);
    expect(out).toContain('model:  ok model-a');
    expect(out).toContain('binary: ok v1.9.5');
    expect(process.exitCode).toBeUndefined();
  });

  it('reports a rejected download with its code and exit 1', async () => {
    await serve({ '/ggml-a.bin': { kind: 'ok', body: Buffer.alloc(MODEL_A.length, 0x41) } });
    const { err } = await run(localBuildLock(server), yes);
    expect(err).toContain('[TOOLS_HASH_MISMATCH]');
    expect(process.exitCode).toBe(1);
    expect(tree(ws.paths.whisperModelsDir)).toEqual([]);
  });
});
