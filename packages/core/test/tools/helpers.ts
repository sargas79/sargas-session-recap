/** Local-only test fixtures for T23: fake files, a loopback HTTP server, hand-built zips. */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import type { ToolsLock } from '@sargas-recap/contracts';
import { createDataPaths, type DataPaths } from '../../src/paths/index.ts';

export function sha(data: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

export interface Workspace {
  readonly dir: string;
  readonly paths: DataPaths;
  cleanup(): void;
}

export function workspace(): Workspace {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'recap tools ü '));
  return {
    dir,
    paths: createDataPaths(path.join(dir, 'data')),
    cleanup() {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

export type Route =
  | { readonly kind: 'ok'; readonly body: Buffer }
  /** Declares the full length, sends half, then kills the connection. */
  | { readonly kind: 'dropped'; readonly body: Buffer }
  /** Chunked encoding, ends cleanly after sending only `body`. */
  | { readonly kind: 'chunked'; readonly body: Buffer }
  | { readonly kind: 'status'; readonly status: number };

export interface FixtureServer {
  url(pathname: string): string;
  readonly requests: string[];
  close(): Promise<void>;
}

/** HTTP server on 127.0.0.1 serving fixed routes; records every request it gets. */
export async function fixtureServer(routes: Record<string, Route>): Promise<FixtureServer> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    const pathname = req.url ?? '';
    requests.push(pathname);
    const route = routes[pathname];
    if (route === undefined) {
      res.writeHead(404).end();
    } else if (route.kind === 'status') {
      res.writeHead(route.status).end();
    } else if (route.kind === 'ok') {
      res.writeHead(200, { 'content-length': route.body.length }).end(route.body);
    } else if (route.kind === 'chunked') {
      res.writeHead(200);
      res.end(route.body);
    } else {
      res.writeHead(200, { 'content-length': route.body.length });
      res.write(route.body.subarray(0, Math.floor(route.body.length / 2)), () => {
        res.destroy();
      });
    }
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: (pathname) => `http://127.0.0.1:${String(port)}${pathname}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

export interface ZipEntrySpec {
  readonly name: string;
  readonly data?: Buffer;
  /** Stored as a symbolic link (POSIX mode in the external attributes). */
  readonly symlink?: boolean;
}

/** Builds a zip by hand so tests can produce entry names no sane zip tool would write. */
export function makeZip(entries: readonly ZipEntrySpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = entry.data ?? Buffer.alloc(0);
    const compressed = deflateRawSync(data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4); // made by UNIX
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((entry.symlink === true ? 0o120777 : 0o100644) * 0x10000, 38);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, compressed);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

export const EXE = Buffer.from('fake whisper-cli binary');
export const DLL = Buffer.from('fake whisper.dll');
export const MODEL_A = Buffer.from('fake model A contents');
export const MODEL_B = Buffer.from('fake model B, a different file');

export const CURRENT_PLATFORM = `${process.platform}-${process.arch}`;

const REPOSITORY = 'https://github.com/ggml-org/whisper.cpp';

/** A lock for a local build of `whisper-cli` + `whisper.dll` with two models served by `server`. */
export function localBuildLock(server: Pick<FixtureServer, 'url'>): ToolsLock {
  return {
    schema_version: 1,
    whisper: {
      version: 'v1.9.5',
      commit: 'd1be6fde11ac6e0407606b4e42fe72d34add8037',
      binary: {
        source: 'local-build',
        platform: CURRENT_PLATFORM,
        install_dir: 'v1.9.5-vulkan',
        executable: 'whisper-cli',
        files: [
          { path: 'whisper-cli', sha256: sha(EXE) },
          { path: 'whisper.dll', sha256: sha(DLL) },
        ],
        build: { repository: REPOSITORY, flags: ['-DGGML_VULKAN=ON'] },
      },
      active_model: 'model-a',
      models: [
        {
          id: 'model-a',
          file: 'ggml-a.bin',
          url: server.url('/ggml-a.bin'),
          sha256: sha(MODEL_A),
          bytes: MODEL_A.length,
        },
        {
          id: 'model-b',
          file: 'ggml-b.bin',
          url: server.url('/ggml-b.bin'),
          sha256: sha(MODEL_B),
          bytes: MODEL_B.length,
        },
      ],
    },
  };
}

/** The same lock, but the binary comes from a zip at `/bin.zip`. */
export function archiveLock(server: Pick<FixtureServer, 'url'>, zip: Buffer): ToolsLock {
  const lock = localBuildLock(server);
  const { platform, install_dir, executable, files } = lock.whisper.binary;
  return {
    ...lock,
    whisper: {
      ...lock.whisper,
      binary: {
        source: 'archive',
        platform,
        install_dir,
        executable,
        files,
        archive: { url: server.url('/bin.zip'), sha256: sha(zip), bytes: zip.length },
      },
    },
  };
}
