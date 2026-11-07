/**
 * Parsing of the `claude -p --output-format json` result envelope.
 *
 * The envelope shape is NOT assumed to be stable. Field names below are what
 * the harness looks for; which ones are actually present in the installed CLI
 * version must be recorded by the GM in docs/spikes/S05-llm-backends.md.
 * Unknown fields are preserved in `raw` (after redaction by the caller).
 *
 * Expected (to verify) shape, single JSON object on stdout:
 *   { type: "result", subtype: "success" | "error_...", is_error: boolean,
 *     result: string, structured_output?: unknown, session_id?: string,
 *     duration_ms?: number, duration_api_ms?: number, num_turns?: number,
 *     total_cost_usd?: number, usage?: {...}, modelUsage?: {...} }
 */

export interface CliUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  /** Any other numeric/string usage fields the CLI reports. */
  extra: Record<string, unknown>;
}

export interface CliEnvelope {
  type?: string;
  subtype?: string;
  isError: boolean;
  /** Text result (may itself be JSON when no structured output field exists). */
  result?: string;
  /** Structured output object, if the CLI reports one separately. */
  structuredOutput?: unknown;
  sessionId?: string;
  durationMs?: number;
  durationApiMs?: number;
  numTurns?: number;
  totalCostUsd?: number;
  usage?: CliUsage;
  modelUsage?: Record<string, unknown>;
  /** Field names present in the envelope, for the evidence table. */
  fieldsPresent: string[];
  raw: Record<string, unknown>;
}

export type EnvelopeParse =
  | { ok: true; envelope: CliEnvelope }
  | { ok: false; reason: "empty" | "not_json" | "not_object"; detail: string };

const USAGE_KNOWN = [
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
] as const;

export function parseEnvelope(stdout: string): EnvelopeParse {
  const text = stdout.trim();
  if (!text) return { ok: false, reason: "empty", detail: "stdout was empty" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Some CLI modes emit JSON lines; accept the last line that parses as a
    // `type: "result"` object, otherwise report not_json.
    const last = lastResultLine(text);
    if (!last) return { ok: false, reason: "not_json", detail: `stdout is not JSON (${text.length} chars)` };
    parsed = last;
  }
  if (Array.isArray(parsed)) {
    const found = [...parsed].reverse().find(isResultObject);
    if (!found) return { ok: false, reason: "not_object", detail: "JSON array without a result object" };
    parsed = found;
  }
  if (!isRecord(parsed)) return { ok: false, reason: "not_object", detail: `JSON ${typeof parsed}` };

  const r = parsed;
  const env: CliEnvelope = {
    isError: r["is_error"] === true || (typeof r["subtype"] === "string" && r["subtype"] !== "success"),
    fieldsPresent: Object.keys(r).sort(),
    raw: r,
  };
  setStr(env, "type", r["type"]);
  setStr(env, "subtype", r["subtype"]);
  setStr(env, "result", r["result"]);
  setStr(env, "sessionId", r["session_id"]);
  setNum(env, "durationMs", r["duration_ms"]);
  setNum(env, "durationApiMs", r["duration_api_ms"]);
  setNum(env, "numTurns", r["num_turns"]);
  setNum(env, "totalCostUsd", r["total_cost_usd"] ?? r["cost_usd"]);
  if ("structured_output" in r) env.structuredOutput = r["structured_output"];
  if (isRecord(r["usage"])) env.usage = parseUsage(r["usage"]);
  if (isRecord(r["modelUsage"])) env.modelUsage = r["modelUsage"];
  return { ok: true, envelope: env };
}

function parseUsage(u: Record<string, unknown>): CliUsage {
  const usage: CliUsage = { extra: {} };
  for (const [k, v] of Object.entries(u)) {
    if ((USAGE_KNOWN as readonly string[]).includes(k) && typeof v === "number") {
      usage[k as (typeof USAGE_KNOWN)[number]] = v;
    } else {
      usage.extra[k] = v;
    }
  }
  return usage;
}

/**
 * Extract the structured payload: prefer `structured_output`; otherwise try
 * to parse `result` as JSON. Code fences are NOT stripped: if the model wraps
 * JSON in prose/fences that is reported as invalid structured output.
 */
export function extractStructured(
  env: CliEnvelope,
): { ok: true; value: unknown; source: "structured_output" | "result" } | { ok: false; detail: string } {
  if (env.structuredOutput !== undefined && env.structuredOutput !== null) {
    return { ok: true, value: env.structuredOutput, source: "structured_output" };
  }
  if (typeof env.result === "string") {
    try {
      return { ok: true, value: JSON.parse(env.result), source: "result" };
    } catch {
      return { ok: false, detail: "result field is not JSON and no structured_output present" };
    }
  }
  return { ok: false, detail: "envelope has neither structured_output nor result" };
}

function lastResultLine(text: string): Record<string, unknown> | undefined {
  const lines = text.split(/\r?\n/).reverse();
  for (const line of lines) {
    try {
      const v: unknown = JSON.parse(line);
      if (isResultObject(v)) return v;
    } catch {
      /* keep looking */
    }
  }
  return undefined;
}

function isResultObject(v: unknown): v is Record<string, unknown> {
  return isRecord(v) && v["type"] === "result";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

type StrKeys = "type" | "subtype" | "result" | "sessionId";
type NumKeys = "durationMs" | "durationApiMs" | "numTurns" | "totalCostUsd";
function setStr(env: CliEnvelope, k: StrKeys, v: unknown) {
  if (typeof v === "string") env[k] = v;
}
function setNum(env: CliEnvelope, k: NumKeys, v: unknown) {
  if (typeof v === "number" && Number.isFinite(v)) env[k] = v;
}
