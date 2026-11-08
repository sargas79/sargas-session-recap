import type { JobUsage } from '../jobs/store.ts';

/** One provider request. `user` holds the rendered prompt, with transcript in its data block. */
export interface AdapterRequest {
  readonly model: string;
  readonly system: string;
  readonly user: string;
  /** JSON Schema of the output, reduced to what the provider's structured output accepts. */
  readonly schema: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
}

export interface AdapterResponse {
  /** Parsed and redacted, not yet validated against the contract. */
  readonly output: unknown;
  readonly usage: JobUsage;
}

/**
 * A provider transport. Internal to this module: only `createLlmBackend` calls adapters, because
 * that is where `assertConsent()` runs. Failures are thrown as `LlmError`.
 */
export interface LlmAdapter {
  call(request: AdapterRequest): Promise<AdapterResponse>;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Provider `usage` as a job usage. Cached input counts as input. Cost is left to the caller. */
export function usageFrom(usage: unknown): JobUsage {
  const u = (typeof usage === 'object' && usage !== null ? usage : {}) as Record<string, unknown>;
  return {
    input_tokens:
      count(u['input_tokens']) +
      count(u['cache_creation_input_tokens']) +
      count(u['cache_read_input_tokens']),
    output_tokens: count(u['output_tokens']),
  };
}

export function addUsage(a: JobUsage, b: JobUsage | undefined): JobUsage {
  if (b === undefined) return a;
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
  };
}
