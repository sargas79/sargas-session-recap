/**
 * Safe resolution of package-relative paths (ADR-006, plan section 5 risk 2).
 *
 * Contracts store artifact paths as package-relative POSIX strings. Before any of them touches the
 * disk it goes through two layers:
 *
 * 1. {@link checkRelPath}: a purely lexical check. It rejects traversal, absolute, drive-relative,
 *    UNC and device paths, backslashes, alternate data streams, reserved Windows device names
 *    (with or without an extension), trailing dots or spaces, and anything else outside the
 *    contract pattern. It runs the same way on every OS, so a package that is safe on Linux is
 *    also safe when copied to Windows.
 * 2. {@link resolveInsidePackage}: resolves the path under the realpath of the package root and
 *    then realpaths the result (or its deepest existing ancestor), so junctions and symlinks that
 *    point outside the root are rejected.
 *
 * Problems are reported with a stable code and a message that never repeats the offending path:
 * an unsafe path may be arbitrary text from a hostile or corrupted manifest.
 *
 * There is an unavoidable check-then-use window between resolving and opening a file. The tool
 * runs locally on the operator's own data root, so that window is accepted; nothing here is a
 * sandbox against a concurrent local attacker.
 */
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { REL_PATH_PATTERN } from '@sargas-recap/contracts';

export type PathProblemCode =
  | 'PATH_EMPTY'
  | 'PATH_TOO_LONG'
  | 'PATH_ABSOLUTE'
  | 'PATH_DRIVE'
  | 'PATH_UNC'
  | 'PATH_DEVICE'
  | 'PATH_BACKSLASH'
  | 'PATH_TRAVERSAL'
  | 'PATH_EMPTY_SEGMENT'
  | 'PATH_STREAM'
  | 'PATH_RESERVED_NAME'
  | 'PATH_TRAILING_DOT_OR_SPACE'
  | 'PATH_INVALID_CHARS'
  | 'PATH_CASE_COLLISION'
  | 'PATH_CASE_MISMATCH'
  | 'PATH_ESCAPES_ROOT';

export interface PathProblem {
  readonly code: PathProblemCode;
  /** Explains the rule that was broken. Never contains the path itself. */
  readonly message: string;
}

/** Same limit as the `RelPath` contract. */
export const MAX_REL_PATH_LENGTH = 240;

const REL_PATH = new RegExp(REL_PATH_PATTERN);

/**
 * Win32 device names. They are reserved in every directory and with any extension (`nul.txt`,
 * `com1.tar.gz`), and Windows ignores trailing spaces before the extension (`CON .wav`).
 * The superscript digits (`COM¹`) are reserved too; they never pass the ASCII contract pattern.
 */
const RESERVED_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9¹²³]|lpt[0-9¹²³])$/i;

function problem(code: PathProblemCode, message: string): PathProblem {
  return { code, message };
}

/** True when `segment` names a reserved Win32 device, with or without an extension. */
export function isReservedWindowsName(segment: string): boolean {
  const stem = segment.split('.')[0] ?? '';
  return RESERVED_NAME.test(stem.replace(/[ ]+$/, ''));
}

/**
 * Lexically checks a package-relative path. Returns `undefined` when the path is safe, otherwise
 * the first rule it breaks. Order matters: the more specific explanation wins.
 */
export function checkRelPath(rel: string): PathProblem | undefined {
  if (rel.length === 0) return problem('PATH_EMPTY', 'path is empty');
  if (rel.length > MAX_REL_PATH_LENGTH) {
    return problem('PATH_TOO_LONG', `path is longer than ${MAX_REL_PATH_LENGTH} characters`);
  }
  if (rel.startsWith('\\\\?\\') || rel.startsWith('\\\\.\\') || rel.startsWith('//?/')) {
    return problem(
      'PATH_DEVICE',
      'Win32 device and long-path prefixes (\\\\?\\, \\\\.\\) are not allowed',
    );
  }
  if (rel.startsWith('\\\\') || rel.startsWith('//')) {
    return problem('PATH_UNC', 'UNC paths (\\\\server\\share) are not allowed');
  }
  if (/^[A-Za-z]:/.test(rel)) {
    return problem(
      'PATH_DRIVE',
      rel.length > 2 && (rel[2] === '\\' || rel[2] === '/')
        ? 'absolute drive paths (C:\\...) are not allowed'
        : 'drive-relative paths (C:foo) are not allowed',
    );
  }
  if (rel.startsWith('/') || rel.startsWith('\\')) {
    return problem('PATH_ABSOLUTE', 'path must be relative to the package root');
  }
  if (rel.includes('\\')) {
    return problem('PATH_BACKSLASH', 'use forward slashes; backslashes are not allowed');
  }
  const segments = rel.split('/');
  for (const segment of segments) {
    if (segment === '..' || segment === '.') {
      return problem('PATH_TRAVERSAL', '`.` and `..` segments are not allowed');
    }
  }
  for (const segment of segments) {
    if (segment.length === 0) return problem('PATH_EMPTY_SEGMENT', 'path has an empty segment');
    if (segment.includes(':')) {
      return problem(
        'PATH_STREAM',
        'colons (NTFS alternate data streams such as a.wav:x) are not allowed',
      );
    }
    if (isReservedWindowsName(segment)) {
      return problem(
        'PATH_RESERVED_NAME',
        'reserved Windows device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9), with or without an extension, are not allowed',
      );
    }
    if (segment.endsWith('.') || segment.endsWith(' ')) {
      return problem(
        'PATH_TRAILING_DOT_OR_SPACE',
        'segments may not end with a dot or a space (Windows strips them)',
      );
    }
  }
  if (!REL_PATH.test(rel)) {
    return problem(
      'PATH_INVALID_CHARS',
      'segments may only contain A-Z a-z 0-9 . _ - and may not start with a dot',
    );
  }
  return undefined;
}

/** Case-folding key used to detect paths that collide on case-insensitive filesystems. */
export function caseKey(rel: string): string {
  return rel.normalize('NFC').toLowerCase();
}

/**
 * Groups of paths that are distinct strings but name the same file on Windows/macOS defaults.
 * Exact duplicates are not collisions (callers report those separately if they care).
 */
export function findCaseCollisions(paths: Iterable<string>): string[][] {
  const groups = new Map<string, Set<string>>();
  for (const p of paths) {
    const key = caseKey(p);
    let group = groups.get(key);
    if (group === undefined) {
      group = new Set();
      groups.set(key, group);
    }
    group.add(p);
  }
  return [...groups.values()].filter((g) => g.size > 1).map((g) => [...g].sort());
}

export class UnsafePathError extends Error {
  readonly code: PathProblemCode;

  constructor(problemValue: PathProblem) {
    super(problemValue.message);
    this.name = 'UnsafePathError';
    this.code = problemValue.code;
  }
}

function samePathCase(a: string, b: string): boolean {
  return process.platform === 'win32' || process.platform === 'darwin'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

/** True when `child` is `parent` or inside it (both absolute, already real). */
export function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false; // different drive on Windows
  const first = rel.split(path.sep)[0];
  return first !== '..';
}

export interface ResolvedPackagePath {
  /** Absolute path under the (real) package root, built from the requested segments. */
  readonly absolute: string;
  /** Realpath of the file, or `undefined` when it does not exist (yet). */
  readonly real: string | undefined;
  /** Whether the entry exists. */
  readonly exists: boolean;
}

function isNotFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Realpath of the package root. Every resolution is anchored on it. */
export async function realPackageRoot(root: string): Promise<string> {
  return realpath(path.resolve(root));
}

/**
 * Resolves `rel` under `realRoot` (from {@link realPackageRoot}) and proves the result stays under
 * the root after following junctions and symlinks. A missing target is fine (callers decide
 * whether that is an error); a missing target whose existing ancestor escapes is not.
 *
 * Throws {@link UnsafePathError} for unsafe paths. Other I/O errors propagate.
 */
export async function resolveInsidePackage(
  realRoot: string,
  rel: string,
): Promise<ResolvedPackagePath> {
  const lexical = checkRelPath(rel);
  if (lexical !== undefined) throw new UnsafePathError(lexical);
  const segments = rel.split('/');
  const absolute = path.join(realRoot, ...segments);

  // Walk up to the deepest existing ancestor and realpath it.
  let probe = absolute;
  let missing = 0;
  let real: string | undefined;
  for (;;) {
    try {
      real = await realpath(probe);
      break;
    } catch (error) {
      if (!isNotFound(error)) {
        // A dangling symlink: lstat sees it, realpath does not. Treat it as an escape: we cannot
        // prove where it points.
        const isLink = await lstat(probe).then(
          (info) => info.isSymbolicLink(),
          () => false,
        );
        if (isLink) {
          throw new UnsafePathError(
            problem(
              'PATH_ESCAPES_ROOT',
              'path goes through a link whose target cannot be resolved',
            ),
          );
        }
        throw error;
      }
      const isLink = await lstat(probe).then(
        (info) => info.isSymbolicLink(),
        () => false,
      );
      if (isLink) {
        throw new UnsafePathError(
          problem('PATH_ESCAPES_ROOT', 'path goes through a link whose target does not exist'),
        );
      }
      const parent = path.dirname(probe);
      if (parent === probe) throw error;
      probe = parent;
      missing += 1;
    }
  }
  if (!isWithin(realRoot, real)) {
    throw new UnsafePathError(
      problem('PATH_ESCAPES_ROOT', 'path resolves outside the package root (symlink or junction)'),
    );
  }
  if (missing === 0) {
    // Same file, but the on-disk spelling differs only by case: the package would break on a
    // case-sensitive filesystem and two such paths could alias each other on Windows.
    const relReal = path.relative(realRoot, real).split(path.sep).join('/');
    const requested = path.relative(realRoot, absolute).split(path.sep).join('/');
    if (relReal !== requested && samePathCase(relReal, requested)) {
      throw new UnsafePathError(
        problem('PATH_CASE_MISMATCH', 'path differs in letter case from the file on disk'),
      );
    }
  }
  return { absolute, real: missing === 0 ? real : undefined, exists: missing === 0 };
}
