/**
 * `recap setup whisper` (T23): installs the pinned binary and active model into
 * `<data-root>/tools/whisper/`.
 *
 * Nothing is fetched until the caller's `confirm` returns true for the exact list of files. The lock
 * says how the binary is obtained: an `archive` is downloaded and extracted; a `local-build` (no
 * prebuilt Vulkan binary exists for Windows) is built by the GM and adopted with `--from-build`,
 * which copies the files only if they match the pin.
 */
import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { ToolsLock } from '@sargas-recap/contracts';
import { renameWithRetry, tempDirFor } from '../package/atomic.ts';
import { sha256File } from '../package/hash.ts';
import type { DataPaths } from '../paths/index.ts';
import { extractZip } from './archive.ts';
import { downloadVerified, type DownloadOptions } from './download.ts';
import { ToolsError } from './errors.ts';
import { inspectWhisper, type InspectOptions, type WhisperInspection } from './inspect.ts';
import { activeModel } from './lock.ts';

export interface PlannedDownload {
  readonly kind: 'binary-archive' | 'model';
  /** Shown to the operator. */
  readonly fileName: string;
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly dest: string;
  /** True when a file at the destination failed verification and will be replaced. */
  readonly replaces: boolean;
}

export interface SetupOptions extends InspectOptions, DownloadOptions {
  readonly lock: ToolsLock;
  readonly paths: DataPaths;
  /** Directory holding a GM-built binary to adopt (normally `<build>\bin\Release`). */
  readonly fromBuild?: string | undefined;
  /** Shows the operator what will be downloaded; only `true` lets a download start. */
  readonly confirm: (downloads: readonly PlannedDownload[]) => Promise<boolean>;
  /** Called after each step completes, for progress output. */
  readonly onStep?: ((message: string) => void) | undefined;
}

export type SetupStatus =
  /** Binary and model verified; nothing else to do. */
  | 'ready'
  /** The operator declined; nothing was downloaded. */
  | 'declined'
  /** The model is in place, but the local-build binary is still to be built. */
  | 'binary-needs-build';

export interface SetupResult {
  readonly status: SetupStatus;
  readonly inspection: WhisperInspection;
}

function urlFileName(url: string): string {
  return path.posix.basename(new URL(url).pathname);
}

function planDownloads(inspection: WhisperInspection, paths: DataPaths): PlannedDownload[] {
  const { lock, binary, model } = inspection;
  const downloads: PlannedDownload[] = [];
  const pin = lock.whisper.binary;
  if (
    pin.source === 'archive' &&
    binary.state !== 'ok' &&
    binary.state !== 'unsupported-platform'
  ) {
    downloads.push({
      kind: 'binary-archive',
      fileName: urlFileName(pin.archive.url),
      url: pin.archive.url,
      bytes: pin.archive.bytes,
      sha256: pin.archive.sha256,
      dest: `${paths.whisperBuildDir(pin.install_dir)}.archive`,
      replaces: binary.state === 'mismatch',
    });
  }
  if (model.state !== 'ok') {
    const locked = activeModel(lock);
    downloads.push({
      kind: 'model',
      fileName: locked.file,
      url: locked.url,
      bytes: locked.bytes,
      sha256: locked.sha256,
      dest: paths.whisperModelFile(locked.file),
      replaces: model.state === 'mismatch',
    });
  }
  return downloads;
}

/** Verifies every extracted or copied file in `dir`, then swaps `dir` into the install location. */
async function commitInstall(lock: ToolsLock, paths: DataPaths, dir: string): Promise<void> {
  const { binary } = lock.whisper;
  for (const file of binary.files) {
    const { hash } = await sha256File(path.join(dir, ...file.path.split('/')));
    if (hash !== file.sha256) {
      throw new ToolsError('TOOLS_HASH_MISMATCH', `${file.path} does not match tools.lock.json`);
    }
  }
  const target = paths.whisperBuildDir(binary.install_dir);
  await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  await renameWithRetry(dir, target);
}

async function installArchive(
  lock: ToolsLock,
  paths: DataPaths,
  archive: string,
  options: SetupOptions,
): Promise<void> {
  const { binary } = lock.whisper;
  const staging = tempDirFor(paths.whisperBuildDir(binary.install_dir));
  await mkdir(staging, { recursive: true });
  try {
    await extractZip(
      archive,
      staging,
      binary.files.map((f) => f.path),
      binary.executable,
    );
    await commitInstall(lock, paths, staging);
    options.onStep?.(`installed ${binary.executable}`);
  } finally {
    await rm(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(
      () => undefined,
    );
  }
}

/** The `files` block for tools.lock.json, ready to paste, after a deliberate rebuild. */
function lockFilesBlock(lock: ToolsLock, hashes: ReadonlyMap<string, string>): string {
  const files = lock.whisper.binary.files.map((f) => ({
    path: f.path,
    sha256: hashes.get(f.path) ?? f.sha256,
  }));
  return JSON.stringify({ files }, null, 2);
}

/**
 * Adopts a GM-built binary: hashes the files in `buildDir`, and only if every one matches the lock
 * copies them into place. A mismatch installs nothing and reports the new hashes, because a rebuild
 * is not byte-reproducible and repinning it is a decision to record in git.
 */
async function installFromBuild(
  lock: ToolsLock,
  paths: DataPaths,
  buildDir: string,
  options: SetupOptions,
): Promise<void> {
  const { binary } = lock.whisper;
  const source = (rel: string): string => path.join(buildDir, ...rel.split('/'));
  const hashes = new Map<string, string>();
  const mismatched: string[] = [];
  for (const file of binary.files) {
    let hash: string;
    try {
      ({ hash } = await sha256File(source(file.path)));
    } catch (cause) {
      throw new ToolsError(
        'TOOLS_BUILD_MISMATCH',
        `${file.path} is not in ${buildDir}`,
        'point --from-build at the directory holding whisper-cli and its DLLs (build\\bin\\Release)',
        cause,
      );
    }
    hashes.set(file.path, hash);
    if (hash !== file.sha256) mismatched.push(file.path);
  }
  if (mismatched.length > 0) {
    throw new ToolsError(
      'TOOLS_BUILD_MISMATCH',
      `these files do not match tools.lock.json: ${mismatched.join(', ')}; nothing was installed`,
      `if you rebuilt deliberately, replace "files" in whisper.binary of tools.lock.json with the block below, commit it and re-run:\n${lockFilesBlock(lock, hashes)}`,
    );
  }
  const staging = tempDirFor(paths.whisperBuildDir(binary.install_dir));
  await mkdir(staging, { recursive: true });
  try {
    for (const file of binary.files) {
      const target = path.join(staging, ...file.path.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source(file.path), target);
    }
    await commitInstall(lock, paths, staging);
    options.onStep?.(`installed the local build from ${buildDir}`);
  } finally {
    await rm(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(
      () => undefined,
    );
  }
}

/**
 * Brings the install in line with the lock. Overrides play no part here: setup manages only the
 * locked location. Throws a `ToolsError` when a download or install is rejected.
 */
export async function runWhisperSetup(options: SetupOptions): Promise<SetupResult> {
  const { lock, paths } = options;
  await mkdir(paths.whisperDir, { recursive: true });

  if (options.fromBuild !== undefined) {
    await installFromBuild(lock, paths, path.resolve(options.fromBuild), options);
  }

  const before = await inspectWhisper(lock, paths, {}, options);
  const downloads = planDownloads(before, paths);
  if (downloads.length > 0) {
    if (!(await options.confirm(downloads))) {
      return { status: 'declined', inspection: before };
    }
    for (const item of downloads) {
      await downloadVerified(item, options);
      options.onStep?.(`verified ${item.fileName}`);
      if (item.kind === 'binary-archive') {
        try {
          await installArchive(lock, paths, item.dest, options);
        } finally {
          await rm(item.dest, { force: true, maxRetries: 3, retryDelay: 100 }).catch(
            () => undefined,
          );
        }
      }
    }
  }

  const inspection = await inspectWhisper(lock, paths, {}, options);
  const { binary, model } = inspection;
  if (model.state !== 'ok') {
    throw new ToolsError('TOOLS_TAMPERED', `model is ${model.state} after setup`);
  }
  if (binary.state === 'ok' || binary.state === 'unsupported-platform') {
    return { status: 'ready', inspection };
  }
  if (lock.whisper.binary.source === 'local-build') {
    return { status: 'binary-needs-build', inspection };
  }
  throw new ToolsError('TOOLS_TAMPERED', `binary is ${binary.state} after setup`);
}
