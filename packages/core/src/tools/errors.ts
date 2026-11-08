export type ToolsErrorCode =
  | 'TOOLS_LOCK_INVALID'
  | 'TOOLS_OVERRIDES_INVALID'
  | 'TOOLS_DOWNLOAD_FAILED'
  /** The stream ended before the size pinned in the lock. */
  | 'TOOLS_DOWNLOAD_INCOMPLETE'
  /** The server sent more bytes than the size pinned in the lock. */
  | 'TOOLS_DOWNLOAD_TOO_LARGE'
  | 'TOOLS_HASH_MISMATCH'
  /** An archive entry would escape the install directory or is a link. */
  | 'TOOLS_ARCHIVE_UNSAFE'
  | 'TOOLS_ARCHIVE_INVALID'
  /** `--from-build` does not contain the pinned files, or they fail the pin. */
  | 'TOOLS_BUILD_MISMATCH'
  /** A binary or model is not installed. */
  | 'TOOLS_NOT_PROVISIONED'
  /** An installed binary or model does not match the lock. */
  | 'TOOLS_TAMPERED';

/** Error raised while provisioning or verifying tools. `hint` is what the operator should do. */
export class ToolsError extends Error {
  readonly code: ToolsErrorCode;
  readonly hint: string | undefined;

  constructor(code: ToolsErrorCode, message: string, hint?: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ToolsError';
    this.code = code;
    this.hint = hint;
  }
}

export function isToolsError(value: unknown): value is ToolsError {
  return value instanceof ToolsError;
}
