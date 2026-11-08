export type PathsErrorCode =
  /** A campaign or session ID is not a valid ADR-004 slug. */
  | 'PATHS_INVALID_ID'
  /** The resolved data root is inside a git working tree and `--allow-in-repo` was not given. */
  | 'PATHS_DATA_ROOT_IN_REPO'
  /** No data root could be derived (no flag, env, config, home or LOCALAPPDATA). */
  | 'PATHS_NO_DEFAULT'
  /** A data root value is empty or otherwise unusable. */
  | 'PATHS_DATA_ROOT_INVALID';

/** Error raised by the paths service. Messages never contain file contents. */
export class PathsError extends Error {
  readonly code: PathsErrorCode;
  readonly hint: string | undefined;

  constructor(code: PathsErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'PathsError';
    this.code = code;
    this.hint = hint;
  }
}
