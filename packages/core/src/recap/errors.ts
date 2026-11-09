export type RecapEditorialErrorCode =
  | 'RECAP_REVISION_NOT_FOUND'
  | 'RECAP_TARGET_NOT_FOUND'
  | 'RECAP_EDIT_INVALID'
  | 'RECAP_STALE'
  | 'RECAP_BAD_STATE'
  | 'RECAP_BLOCKED'
  | 'RECAP_SPOILERS_NOT_ACKNOWLEDGED'
  | 'RECAP_HASH_MISMATCH'
  | 'RECAP_NOT_APPROVED';

/** A refusal by the editorial services (T15). Messages name IDs and states, never recap text. */
export class RecapEditorialError extends Error {
  readonly code: RecapEditorialErrorCode;
  readonly hint: string | undefined;

  constructor(code: RecapEditorialErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'RecapEditorialError';
    this.code = code;
    this.hint = hint;
  }
}

export function isRecapEditorialError(error: unknown): error is RecapEditorialError {
  return error instanceof RecapEditorialError;
}
