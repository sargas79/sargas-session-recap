import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { downloadVerified, type DownloadTarget } from '../../src/tools/index.ts';
import {
  fixtureServer,
  MODEL_A,
  sha,
  workspace,
  type FixtureServer,
  type Workspace,
} from './helpers.ts';

let ws: Workspace;
let server: FixtureServer;
let dest: string;

const target = (pathname: string, override: Partial<DownloadTarget> = {}): DownloadTarget => ({
  url: server.url(pathname),
  dest,
  sha256: sha(MODEL_A),
  bytes: MODEL_A.length,
  ...override,
});

beforeEach(async () => {
  ws = workspace();
  dest = path.join(ws.dir, 'sub', 'ggml.bin');
  server = await fixtureServer({
    '/good': { kind: 'ok', body: MODEL_A },
    '/corrupt': { kind: 'ok', body: Buffer.alloc(MODEL_A.length, 0x41) },
    '/huge': { kind: 'ok', body: Buffer.alloc(MODEL_A.length * 4, 0x41) },
    '/dropped': { kind: 'dropped', body: MODEL_A },
    '/short': { kind: 'chunked', body: MODEL_A.subarray(0, 5) },
    '/missing': { kind: 'status', status: 404 },
  });
});

afterEach(async () => {
  await server.close();
  ws.cleanup();
});

function leftovers(): string[] {
  const dir = path.dirname(dest);
  return existsSync(dir) ? readdirSync(dir) : [];
}

async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    return (error as { code: string }).code;
  }
  throw new Error('expected a rejection');
}

describe('downloadVerified', () => {
  it('stores a file with the pinned size and hash', async () => {
    const progress: number[] = [];
    await downloadVerified(target('/good'), {
      onProgress: (received) => {
        progress.push(received);
      },
    });
    expect(readFileSync(dest).equals(MODEL_A)).toBe(true);
    expect(leftovers()).toEqual(['ggml.bin']);
    expect(progress.at(-1)).toBe(MODEL_A.length);
  });

  it.each([
    ['a corrupt body', '/corrupt', 'TOOLS_HASH_MISMATCH'],
    ['more bytes than pinned', '/huge', 'TOOLS_DOWNLOAD_TOO_LARGE'],
    ['a connection dropped mid-body', '/dropped', 'TOOLS_DOWNLOAD_INCOMPLETE'],
    ['a clean end before the pinned size', '/short', 'TOOLS_DOWNLOAD_INCOMPLETE'],
    ['an HTTP error', '/missing', 'TOOLS_DOWNLOAD_FAILED'],
  ])('rejects %s and leaves nothing behind', async (_name, pathname, code) => {
    expect(await rejection(downloadVerified(target(pathname)))).toBe(code);
    expect(leftovers()).toEqual([]);
  });

  it('refuses a plain-http URL that is not loopback, without any request', async () => {
    let called = false;
    const code = await rejection(
      downloadVerified(target('/good', { url: 'http://example.com/m.bin' }), {
        fetch: () => {
          called = true;
          return Promise.reject(new Error('should not be called'));
        },
      }),
    );
    expect(code).toBe('TOOLS_DOWNLOAD_FAILED');
    expect(called).toBe(false);
  });

  it('refuses a redirect that ended on a non-https URL', async () => {
    const response = new Response(MODEL_A);
    Object.defineProperty(response, 'url', { value: 'http://example.com/m.bin' });
    const code = await rejection(
      downloadVerified(target('/good'), { fetch: () => Promise.resolve(response) }),
    );
    expect(code).toBe('TOOLS_DOWNLOAD_FAILED');
    expect(leftovers()).toEqual([]);
  });

  it('overwrites a stale partial file left by a killed process', async () => {
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(`${dest}.partial`, 'left over from an interrupted run, and longer than the file');
    await downloadVerified(target('/good'));
    expect(readFileSync(dest).equals(MODEL_A)).toBe(true);
    expect(leftovers()).toEqual(['ggml.bin']);
  });
});
