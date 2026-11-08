import { statSync } from 'node:fs';
import path from 'node:path';
import { PathsError } from './errors.ts';

/** Reports whether `p` exists; injectable for tests. */
export type ExistsFn = (p: string) => boolean;

const defaultExists: ExistsFn = (p) => {
  try {
    // A `.git` directory (normal checkout) or a `.git` file (worktree, submodule).
    const st = statSync(p);
    return st.isDirectory() || st.isFile();
  } catch {
    return false;
  }
};

/**
 * Walks up from `start` (inclusive) to the filesystem root and returns the first
 * `.git` entry found, or `undefined`. `start` does not need to exist yet, so a
 * not-yet-created data root inside a checkout is still detected.
 */
export function findEnclosingGit(
  start: string,
  exists: ExistsFn = defaultExists,
): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, '.git');
    if (exists(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/**
 * Refuses a data root inside a git working tree (it would put private session
 * data one `git add -A` away from a commit) unless `allowInRepo` is set.
 */
export function assertDataRootOutsideRepo(
  root: string,
  allowInRepo: boolean,
  exists: ExistsFn = defaultExists,
): void {
  if (allowInRepo) {
    return;
  }
  const git = findEnclosingGit(root, exists);
  if (git !== undefined) {
    throw new PathsError(
      'PATHS_DATA_ROOT_IN_REPO',
      `data root ${root} is inside a git working tree (${git})`,
      'choose a data root outside the repository, or pass --allow-in-repo if you are sure',
    );
  }
}
