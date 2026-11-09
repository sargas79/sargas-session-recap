export type ReviewErrorCode =
  /** Bad command-line usage. */
  | 'REVIEW_USAGE'
  /** The session has no finished transcription yet. */
  | 'REVIEW_NO_TRANSCRIPT'
  /** A run file is missing, unreadable, malformed or differs from what its job recorded. */
  | 'REVIEW_RUN_INVALID'
  /** The segment is not part of the active transcription run. */
  | 'REVIEW_SEGMENT_NOT_FOUND'
  | 'REVIEW_OVERRIDE_NOT_FOUND'
  /** The override change does not fit the contract. */
  | 'REVIEW_INVALID_OVERRIDE'
  /** The override is still attached, or was already handled. */
  | 'REVIEW_NOT_RECONCILABLE'
  /** The target segment already has an override. */
  | 'REVIEW_TARGET_TAKEN';

/** Messages name IDs and contract paths only, never transcript text or GM override text. */
export class ReviewError extends Error {
  readonly code: ReviewErrorCode;
  readonly hint: string | undefined;

  constructor(
    code: ReviewErrorCode,
    message: string,
    options: { hint?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ReviewError';
    this.code = code;
    this.hint = options.hint;
  }
}

export function isReviewError(value: unknown): value is ReviewError {
  return value instanceof ReviewError;
}
