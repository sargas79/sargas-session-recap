import { StageError } from '../jobs/errors.ts';
import type { JobUsage } from '../jobs/store.ts';

export type LlmErrorCode =
  /** campaign.yaml names a provider for this stage that has no adapter. */
  | 'llm-provider-unsupported'
  /** campaign.yaml has no `llm_model` for this stage. */
  | 'llm-model-not-configured'
  /** A caller passed a prompt that does not belong to the method it called. */
  | 'llm-invalid-request'
  | 'llm-binary-not-found'
  | 'llm-spawn-failed'
  | 'llm-not-logged-in'
  | 'llm-invalid-model'
  | 'llm-cli-error'
  | 'llm-exit-nonzero'
  | 'llm-non-json'
  | 'llm-schema-invalid'
  | 'llm-timeout'
  | 'llm-cancelled'
  | 'llm-output-too-large'
  /** The disposable working directory was written to: a tool ran although tools are disabled. */
  | 'llm-tools-not-disabled'
  | 'llm-no-api-key'
  | 'llm-api-auth'
  | 'llm-api-rejected'
  | 'llm-api-error'
  | 'llm-refusal'
  | 'llm-max-tokens';

export interface LlmErrorOptions {
  readonly retryable?: boolean | undefined;
  /** Tokens spent by the failed call(s), when the provider reported them. */
  readonly usage?: JobUsage | undefined;
  readonly attempts?: number | undefined;
  /** Redacted diagnostics. In memory only: job records keep `code` and `message`. */
  readonly detail?: string | undefined;
}

/**
 * A failed provider call. The message is recorded on the job, so it is built from fixed text and
 * identifiers only: never provider output, stderr, prompts or transcript. It deliberately has no
 * `cause`, because SDK and spawn errors carry request headers and the argument list.
 */
export class LlmError extends StageError {
  override readonly code: LlmErrorCode;
  readonly usage: JobUsage | undefined;
  readonly attempts: number;
  readonly detail: string | undefined;

  constructor(code: LlmErrorCode, message: string, options: LlmErrorOptions = {}) {
    super(code, message, { retryable: options.retryable ?? false });
    this.name = 'LlmError';
    this.code = code;
    this.usage = options.usage;
    this.attempts = options.attempts ?? 1;
    this.detail = options.detail;
  }
}

export function isLlmError(value: unknown): value is LlmError {
  return value instanceof LlmError;
}
