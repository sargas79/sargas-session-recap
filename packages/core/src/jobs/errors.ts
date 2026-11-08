export type JobErrorCode =
  /** Another live process holds the per-session lock. */
  | 'JOB_SESSION_LOCKED'
  /** The lock row disappeared or changed owner while this process was running. */
  | 'JOB_LOCK_LOST'
  /** `recap run <stage>` named a stage that is not registered. */
  | 'JOB_UNKNOWN_STAGE'
  /** The stage graph has a cycle or an upstream stage that is not registered. */
  | 'JOB_STAGE_GRAPH_INVALID'
  /** A state change that the execution state machine does not allow. */
  | 'JOB_INVALID_TRANSITION'
  /** A stage declared an input that is not a valid `{kind, ref, sha256:}` triple. */
  | 'JOB_INVALID_INPUT'
  /** A stage returned outputs or usage that do not fit the job-record contract. */
  | 'JOB_INVALID_OUTPUT'
  /** A stage needs campaign config (`--config`) that was not given, or that does not match. */
  | 'JOB_CONFIG_REQUIRED';

/** Error raised by the job runner itself. Messages never contain transcript or prompt content. */
export class JobError extends Error {
  readonly code: JobErrorCode;
  readonly hint: string | undefined;

  constructor(
    code: JobErrorCode,
    message: string,
    options: { hint?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'JobError';
    this.code = code;
    this.hint = options.hint;
  }
}

export function isJobError(value: unknown): value is JobError {
  return value instanceof JobError;
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * Error a stage throws to fail its job with a recorded code and message. `retryable` decides
 * whether the runner tries again (bounded, with backoff). Any other thrown value fails the job as
 * `stage-error` without retry, and its message is NOT recorded, because it might carry content.
 *
 * The message is stored in SQLite and printed by `recap status`: keep it actionable and free of
 * transcript, prompt and secret content.
 */
export class StageError extends Error {
  /** Lowercase slug, e.g. `provider-timeout` (job-record `error.code`). */
  readonly code: string;
  readonly retryable: boolean;

  constructor(
    code: string,
    message: string,
    options: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    if (!SLUG.test(code)) {
      throw new TypeError(`StageError code must be a lowercase slug, got ${JSON.stringify(code)}`);
    }
    this.name = 'StageError';
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

export function isStageError(value: unknown): value is StageError {
  return value instanceof StageError;
}
