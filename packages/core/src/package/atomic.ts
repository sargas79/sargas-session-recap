/**
 * Atomic finalization (ADR-006, plan section 5 risk 1).
 *
 * A file is written to a temp name in the destination directory, flushed with `fsync` on its own
 * handle, and only then renamed over the destination. Readers therefore see either the previous
 * file or the complete new one, never a partial write, even if the process dies mid-way. A crash
 * leaves at most a stray temp file whose name starts with a dot and ends in `.tmp`; those names
 * can never be valid package paths, so validators ignore them (and report them as leftovers).
 *
 * Windows specifics:
 * - `rename` over an existing file can fail with EPERM, EBUSY or EACCES while antivirus, the search
 *   indexer or a media player briefly holds a handle. The rename is retried with bounded backoff.
 * - Directories are not fsynced on Windows. Node/libuv cannot open a directory handle there
 *   (`open` fails with EISDIR/EPERM), and NTFS journals metadata operations such as rename, so a
 *   completed rename survives a crash without it. On POSIX the parent directory is fsynced after
 *   the rename so the new directory entry itself is durable.
 *
 * Only Node built-ins are used, so the module can be loaded directly by Node's type stripping
 * (the interrupted-write test runs it in a child process).
 */
import { randomBytes } from 'node:crypto';
import { open, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** Backoff between rename attempts. Bounded: about 1.6 s in total before giving up. */
export const RENAME_RETRY_DELAYS_MS: readonly number[] = Object.freeze([
  25, 50, 100, 200, 400, 800,
]);

const RETRYABLE_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** Test seams. Production code never passes these. */
export interface AtomicHooks {
  /** Runs after the temp file is complete and fsynced, right before the rename. */
  readonly beforeRename?: (temp: string, target: string) => void | Promise<void>;
  /** Replaces `fs.rename` (to simulate transient Windows locks). */
  readonly rename?: (from: string, to: string) => Promise<void>;
}

export interface AtomicOptions {
  readonly hooks?: AtomicHooks | undefined;
  /** Delays between rename attempts; defaults to {@link RENAME_RETRY_DELAYS_MS}. */
  readonly retryDelaysMs?: readonly number[] | undefined;
}

/** Name of a temp sibling of `target`: `.<name>.<pid>.<random>.tmp` in the same directory. */
export function tempPathFor(target: string): string {
  const abs = path.resolve(target);
  return path.join(
    path.dirname(abs),
    `.${path.basename(abs)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
  );
}

/** True for names produced by {@link tempPathFor} / {@link tempDirFor}. */
export function isAtomicTempName(name: string): boolean {
  return /^\..+\.\d+\.[0-9a-f]{8}\.tmp$/.test(name);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * `rename(from, to)`, retried with bounded backoff on the transient Windows errors EPERM, EBUSY
 * and EACCES. Other errors, and the last retryable one, are thrown unchanged.
 */
export async function renameWithRetry(
  from: string,
  to: string,
  options: AtomicOptions = {},
): Promise<void> {
  const doRename = options.hooks?.rename ?? rename;
  const delays = options.retryDelaysMs ?? RENAME_RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await doRename(from, to);
      return;
    } catch (error) {
      const wait = delays[attempt];
      if (!RETRYABLE_RENAME.has(errorCode(error) ?? '') || wait === undefined) throw error;
      await delay(wait);
    }
  }
}

/**
 * fsyncs a directory so a rename inside it is durable. A no-op on Windows (see the module comment).
 * On POSIX filesystems that refuse directory fsync (EINVAL, EISDIR, ENOTSUP) it is best effort.
 */
export async function fsyncDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  let handle;
  try {
    handle = await open(dir, 'r');
    await handle.sync();
  } catch (error) {
    const code = errorCode(error);
    if (code !== 'EINVAL' && code !== 'EISDIR' && code !== 'ENOTSUP' && code !== 'EPERM') {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

/** fsyncs an existing regular file. Opened `r+` because Windows needs write access to flush. */
export async function fsyncFile(file: string): Promise<void> {
  const handle = await open(file, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeQuietly(target: string): Promise<void> {
  // A handle may linger for a moment on Windows; never let cleanup mask the original error.
  await rm(target, { force: true, recursive: true, maxRetries: 3, retryDelay: 100 }).catch(
    () => undefined,
  );
}

/**
 * Moves a complete temp file (for example one written by ffmpeg) over `target`: fsync, rename with
 * retry, fsync the directory. `temp` must be in the same directory as `target` so the rename is
 * atomic. On failure the temp file is removed and `target` is untouched.
 */
export async function commitFileAtomic(
  temp: string,
  target: string,
  options: AtomicOptions = {},
): Promise<void> {
  const from = path.resolve(temp);
  const to = path.resolve(target);
  if (path.dirname(from) !== path.dirname(to)) {
    throw new Error('atomic commit requires the temp file to be in the target directory');
  }
  try {
    await fsyncFile(from);
    await options.hooks?.beforeRename?.(from, to);
    await renameWithRetry(from, to, options);
  } catch (error) {
    await removeQuietly(from);
    throw error;
  }
  await fsyncDirectory(path.dirname(to));
}

/**
 * Atomically replaces `target` with `data`. The parent directory must exist. On any failure
 * (including a simulated crash in the `beforeRename` hook) the previous `target` is untouched and
 * the temp file is removed.
 */
export async function writeFileAtomic(
  target: string,
  data: string | Uint8Array,
  options: AtomicOptions = {},
): Promise<void> {
  const to = path.resolve(target);
  const temp = tempPathFor(to);
  try {
    // `wx`: never reuse or follow an existing entry with the temp name.
    const handle = await open(temp, 'wx');
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await options.hooks?.beforeRename?.(temp, to);
    await renameWithRetry(temp, to, options);
  } catch (error) {
    await removeQuietly(temp);
    throw error;
  }
  await fsyncDirectory(path.dirname(to));
}

/** Temp sibling for a run directory that will be finalized with {@link finalizeDirectory}. */
export function tempDirFor(finalDir: string): string {
  return tempPathFor(finalDir);
}

async function fsyncTree(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await fsyncTree(full);
      await fsyncDirectory(full);
    } else if (entry.isFile()) {
      await fsyncFile(full);
    }
  }
}

/**
 * Renames a fully written run directory (ADR-006: `transcript/<run>/`, `classify/<run>/`,
 * `recap/<revision>/`) into place. Every file in it is fsynced first. Runs are immutable
 * (ADR-004), so an existing `finalDir` is an error, never overwritten.
 */
export async function finalizeDirectory(
  tempDir: string,
  finalDir: string,
  options: AtomicOptions = {},
): Promise<void> {
  const from = path.resolve(tempDir);
  const to = path.resolve(finalDir);
  if (path.dirname(from) !== path.dirname(to)) {
    throw new Error('atomic finalize requires the temp directory to be next to the final one');
  }
  const exists = await stat(to).then(
    () => true,
    (error: unknown) => {
      if (errorCode(error) === 'ENOENT') return false;
      throw error;
    },
  );
  if (exists) {
    throw Object.assign(new Error('run directory already exists; runs are never overwritten'), {
      code: 'EEXIST',
    });
  }
  await fsyncTree(from);
  await fsyncDirectory(from);
  await options.hooks?.beforeRename?.(from, to);
  await renameWithRetry(from, to, options);
  await fsyncDirectory(path.dirname(to));
}
