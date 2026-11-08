/**
 * Safe zip extraction (T23). Runs only on an archive whose sha256 already matched the lock; the
 * checks below are the second line of defence.
 *
 * The whole central directory is read and every entry validated before anything is written, so one
 * bad entry rejects the archive with nothing extracted. Refused: traversal, absolute, drive, UNC and
 * backslash names, reserved Windows names, symlinks, encrypted entries and duplicate names. Only the
 * files the lock lists are written.
 */
import { createWriteStream } from 'node:fs';
import { chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { open as openZip, type Entry, type ZipFile } from 'yauzl';
import { checkRelPath, findCaseCollisions } from '../package/safe-path.ts';
import { ToolsError } from './errors.ts';

/** Larger than any real whisper.cpp archive; caps a malformed one. */
const MAX_ENTRIES = 20_000;
const MAX_EXTRACTED_BYTES = 8 * 1024 ** 3;

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/** yauzl's own filename rejections. Anything else it reports is a corrupt zip. */
const YAUZL_UNSAFE = /invalid relative path|absolute path|invalid characters in fileName/;

function asArchiveError(error: unknown): ToolsError {
  if (error instanceof ToolsError) return error;
  const message = error instanceof Error ? error.message : '';
  return YAUZL_UNSAFE.test(message)
    ? new ToolsError('TOOLS_ARCHIVE_UNSAFE', 'archive has an entry with an unsafe path')
    : new ToolsError('TOOLS_ARCHIVE_INVALID', 'archive is corrupt or unreadable', undefined, error);
}

function openArchive(file: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    openZip(
      file,
      { lazyEntries: true, autoClose: false, validateEntrySizes: true },
      (error, zip) => {
        if (error !== null) reject(error);
        else resolve(zip);
      },
    );
  });
}

function readEntries(zip: ZipFile): Promise<Entry[]> {
  return new Promise((resolve, reject) => {
    const entries: Entry[] = [];
    zip.on('entry', (entry: Entry) => {
      entries.push(entry);
      if (entries.length > MAX_ENTRIES) {
        reject(new ToolsError('TOOLS_ARCHIVE_INVALID', 'archive has too many entries'));
        return;
      }
      zip.readEntry();
    });
    zip.once('end', () => {
      resolve(entries);
    });
    zip.once('error', reject);
    zip.readEntry();
  });
}

function openEntry(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error !== null) reject(error);
      else resolve(stream);
    });
  });
}

function assertEntrySafe(entry: Entry): void {
  const isDirectory = entry.fileName.endsWith('/');
  const name = isDirectory ? entry.fileName.slice(0, -1) : entry.fileName;
  if (checkRelPath(name) !== undefined) {
    throw new ToolsError('TOOLS_ARCHIVE_UNSAFE', 'archive has an entry with an unsafe path');
  }
  // POSIX mode bits live in the high half of the external attributes.
  if (((entry.externalFileAttributes >>> 16) & S_IFMT) === S_IFLNK) {
    throw new ToolsError('TOOLS_ARCHIVE_UNSAFE', 'archive contains a symbolic link');
  }
  if (entry.isEncrypted()) {
    throw new ToolsError('TOOLS_ARCHIVE_UNSAFE', 'archive contains an encrypted entry');
  }
}

/**
 * Extracts the `wanted` files from `archive` into `destDir`, keeping their relative paths.
 * `executable` gets the execute bit on POSIX. Throws a `TOOLS_ARCHIVE_*` error for a bad archive or
 * a wanted file it does not contain; the caller removes `destDir` on failure.
 */
export async function extractZip(
  archive: string,
  destDir: string,
  wanted: readonly string[],
  executable: string,
): Promise<void> {
  let zip: ZipFile | undefined;
  try {
    zip = await openArchive(archive);
    const entries = await readEntries(zip);
    for (const entry of entries) assertEntrySafe(entry);
    const names = entries.map((e) => e.fileName);
    if (new Set(names).size !== names.length || findCaseCollisions(names).length > 0) {
      throw new ToolsError('TOOLS_ARCHIVE_UNSAFE', 'archive lists an entry name more than once');
    }

    const selected = wanted.map((rel) => {
      const entry = entries.find((e) => e.fileName === rel);
      if (entry === undefined) {
        throw new ToolsError('TOOLS_ARCHIVE_INVALID', `archive does not contain ${rel}`);
      }
      return entry;
    });
    const total = selected.reduce((sum, e) => sum + e.uncompressedSize, 0);
    if (total > MAX_EXTRACTED_BYTES) {
      throw new ToolsError('TOOLS_ARCHIVE_INVALID', 'archive is implausibly large');
    }

    for (const entry of selected) {
      const target = path.join(destDir, ...entry.fileName.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      const stream = await openEntry(zip, entry);
      // `wx`: a duplicate or a planted entry can never write through an existing path.
      await pipeline(stream, createWriteStream(target, { flags: 'wx' }));
      if (entry.fileName === executable && process.platform !== 'win32') {
        await chmod(target, 0o755);
      }
    }
  } catch (error) {
    throw asArchiveError(error);
  } finally {
    zip?.close();
  }
}
