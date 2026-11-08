import { createDataPaths, type DataPaths } from './layout.ts';
import { assertDataRootOutsideRepo, type ExistsFn } from './repo-guard.ts';
import { resolveDataRoot, type DataRootInputs, type DataRootSource } from './resolve.ts';

export { PathsError, type PathsErrorCode } from './errors.ts';
export { assertSlug, isSlug, SLUG_PATTERN, type SlugKind } from './slug.ts';
export {
  APP_DIR_NAME,
  DATA_ROOT_ENV,
  defaultDataRoot,
  resolveDataRoot,
  type DataRootInputs,
  type DataRootSource,
  type ResolvedDataRoot,
} from './resolve.ts';
export { assertDataRootOutsideRepo, findEnclosingGit, type ExistsFn } from './repo-guard.ts';
export { createDataPaths, DB_FILE_NAME, type DataPaths } from './layout.ts';
export {
  checkDataRoot,
  formatBytes,
  LOW_DISK_BYTES,
  type DataRootCheck,
  type DataRootCheckOptions,
} from './doctor.ts';

export interface DataRootOptions extends DataRootInputs {
  /** `--allow-in-repo`: accept a data root inside a git working tree. */
  readonly allowInRepo?: boolean | undefined;
  /** Test seam for the `.git` lookup. */
  readonly exists?: ExistsFn | undefined;
}

export interface DataRoot {
  readonly paths: DataPaths;
  readonly source: DataRootSource;
}

/**
 * The entry point for commands: resolves the data root (ADR-009 precedence),
 * refuses one inside a git working tree unless allowed, and returns the layout.
 */
export function openDataRoot(options: DataRootOptions = {}): DataRoot {
  const { root, source } = resolveDataRoot(options);
  assertDataRootOutsideRepo(root, options.allowInRepo === true, options.exists);
  return { paths: createDataPaths(root), source };
}
