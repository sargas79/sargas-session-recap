import { isJobError } from '../jobs/errors.ts';
import { isRecapEditorialError, type RecapEditorialErrorCode } from '../recap/errors.ts';
import { isReviewError, type ReviewErrorCode } from '../review/errors.ts';

/** A refusal the page can show. Messages name IDs and fields only, never session text. */
export class ReviewUiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly hint: string | undefined;

  constructor(status: number, code: string, message: string, hint?: string) {
    super(message);
    this.name = 'ReviewUiError';
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}

const STATUS_BY_CODE: Readonly<Record<ReviewErrorCode, number>> = {
  REVIEW_USAGE: 400,
  REVIEW_INVALID_OVERRIDE: 400,
  REVIEW_SEGMENT_NOT_FOUND: 404,
  REVIEW_OVERRIDE_NOT_FOUND: 404,
  REVIEW_NOT_RECONCILABLE: 409,
  REVIEW_TARGET_TAKEN: 409,
  REVIEW_NO_TRANSCRIPT: 409,
  REVIEW_RUN_INVALID: 500,
};

const EDITORIAL_STATUS: Readonly<Record<RecapEditorialErrorCode, number>> = {
  RECAP_REVISION_NOT_FOUND: 404,
  RECAP_TARGET_NOT_FOUND: 404,
  RECAP_EDIT_INVALID: 400,
  RECAP_STALE: 409,
  RECAP_BAD_STATE: 409,
  RECAP_BLOCKED: 409,
  RECAP_SPOILERS_NOT_ACKNOWLEDGED: 409,
  RECAP_HASH_MISMATCH: 409,
  RECAP_NOT_APPROVED: 409,
};

/** The same refusals the CLI prints. Anything unexpected returns `undefined`: it stays private. */
export function refusalOf(error: unknown): ReviewUiError | undefined {
  if (error instanceof ReviewUiError) return error;
  if (isReviewError(error)) {
    return new ReviewUiError(STATUS_BY_CODE[error.code], error.code, error.message, error.hint);
  }
  if (isRecapEditorialError(error)) {
    return new ReviewUiError(EDITORIAL_STATUS[error.code], error.code, error.message, error.hint);
  }
  if (isJobError(error)) return new ReviewUiError(409, error.code, error.message, error.hint);
  return undefined;
}
