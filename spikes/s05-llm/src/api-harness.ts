/**
 * Claude API fallback harness (`@anthropic-ai/sdk`), spike quality.
 *
 * NEVER imported by unit tests (it would need a key). Only `scripts/live-check.ts`
 * uses it, and only when the GM runs that script manually.
 *
 *  - Model id is explicit and comes from config (default `claude-sonnet-5-5`;
 *    availability on the GM's account must be verified live).
 *  - Key: read from ONE env var (default ANTHROPIC_API_KEY) for the spike and
 *    passed explicitly to the client. If unset, the harness refuses to run
 *    rather than letting the SDK fall back to other credential sources
 *    (auth tokens / CLI profiles), so what is billed is unambiguous.
 *    Production design: OS credential store via `@napi-rs/keyring`
 *    (see docs/spikes/S05-llm-backends.md).
 *  - Structured output via `output_config.format = { type: "json_schema" }`;
 *    the response is still validated locally with Ajv (never trusted).
 *  - Usage fields captured verbatim from `response.usage`.
 *  - Errors, usage, validated output and validation errors are redacted with a
 *    request-local redactor (which knows the exact key) before they leave this module.
 */
import Anthropic from "@anthropic-ai/sdk";
import { Redactor } from "./redact.js";

export interface ApiConfig {
  model: string;
  apiKeyEnvVar: string;
  maxTokens: number;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMs: number;
  maxRetries: number;
}

export function defaultApiConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    model: "claude-sonnet-5-5",
    apiKeyEnvVar: "ANTHROPIC_API_KEY",
    maxTokens: 16_000,
    effort: "medium",
    timeoutMs: 120_000,
    maxRetries: 2,
    ...overrides,
  };
}

export type ApiRunStatus = "ok" | "schema_invalid" | "non_json" | "refusal" | "max_tokens" | "api_error" | "no_key" | "cancelled";

export interface ApiRunResult<T> {
  status: ApiRunStatus;
  model?: string;
  requestId?: string | null;
  stopReason?: string | null;
  usage?: Record<string, unknown>;
  output?: T;
  validationErrors?: string[];
  detail?: string;
  durationMs: number;
}

export async function runClaudeApi<T>(opts: {
  config: ApiConfig;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  validate: (v: unknown) => { valid: true; value: T } | { valid: false; errors: string[] };
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}): Promise<ApiRunResult<T>> {
  const { config, system, user, schema, validate, signal, env = process.env } = opts;
  const started = Date.now();
  const apiKey = env[config.apiKeyEnvVar];
  if (!apiKey) {
    return { status: "no_key", detail: `env var ${config.apiKeyEnvVar} is not set`, durationMs: 0 };
  }
  const redactor = new Redactor([apiKey]).addFromEnv(env);

  const client = new Anthropic({ apiKey, timeout: config.timeoutMs, maxRetries: config.maxRetries });
  try {
    const response = await client.messages
      .create(
        {
          model: config.model,
          max_tokens: config.maxTokens,
          system,
          messages: [{ role: "user", content: user }],
          output_config: { effort: config.effort, format: { type: "json_schema", schema } },
        },
        signal ? { signal } : {},
      )
      .withResponse();
    return interpretApiResponse({
      message: response.data,
      requestId: response.request_id ?? null,
      validate,
      redactor,
      durationMs: Date.now() - started,
    });
  } catch (e) {
    const durationMs = Date.now() - started;
    if (e instanceof Anthropic.APIUserAbortError) return { status: "cancelled", durationMs };
    const safe = redactor.redactError(e);
    const status = e instanceof Anthropic.APIError ? ` status=${String(e.status)}` : "";
    return { status: "api_error", detail: `${safe.name}${status}: ${safe.message}`, durationMs };
  }
}

/** The subset of an SDK `Message` that the harness reads. */
export interface ApiMessageLike {
  model: string;
  stop_reason: string | null;
  usage: unknown;
  content: readonly { type: string; text?: string }[];
}

/**
 * Turn a Messages API response into a run result. Pure (no network), so it is
 * unit-tested directly. Everything that leaves this function — usage, the
 * validated output and validation errors — passes through the request-local
 * redactor, which knows the exact key in use (including a custom env var).
 */
export function interpretApiResponse<T>(o: {
  message: ApiMessageLike;
  requestId: string | null;
  validate: (v: unknown) => { valid: true; value: T } | { valid: false; errors: string[] };
  redactor: Redactor;
  durationMs: number;
}): ApiRunResult<T> {
  const { message: msg, requestId, validate, redactor, durationMs } = o;
  const common = {
    model: redactor.redact(msg.model),
    requestId,
    stopReason: msg.stop_reason,
    usage: redactor.redactValue(msg.usage as Record<string, unknown>),
    durationMs,
  };
  if (msg.stop_reason === "refusal") return { ...common, status: "refusal" };
  if (msg.stop_reason === "max_tokens") return { ...common, status: "max_tokens" };
  const text = msg.content.flatMap((b) => (b.type === "text" && typeof b.text === "string" ? [b.text] : [])).join("");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ...common, status: "non_json", detail: `response text not JSON (${text.length} chars)` };
  }
  const v = validate(parsed);
  if (!v.valid) {
    return { ...common, status: "schema_invalid", validationErrors: redactor.redactValue(v.errors) };
  }
  return { ...common, status: "ok", output: redactor.redactValue(v.value) };
}
