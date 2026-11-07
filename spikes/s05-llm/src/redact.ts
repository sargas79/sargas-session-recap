/**
 * Secret redaction helper.
 *
 * Two layers:
 *  1. Exact-value redaction: every secret the process knows about (registered
 *     explicitly, or read from a known env var) is replaced wherever it
 *     appears, including common encodings (URL-encoded, JSON-escaped, base64).
 *  2. Pattern redaction: anything that *looks* like an Anthropic key or a
 *     bearer token is masked even if it was never registered.
 *
 * Use `redact()` on every string that leaves the process (logs, error
 * messages, results files). Use `redactError()` before logging/re-throwing an
 * error whose message or stack might embed a key (e.g. SDK/HTTP errors).
 */

export const REDACTED = "[REDACTED]";

/** Env vars whose values are always treated as secrets. */
export const SECRET_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_IDENTITY_TOKEN",
] as const;

const PATTERNS: RegExp[] = [
  // Anthropic API / admin / OAuth style keys: sk-ant-<kind>NN-<base64url...>
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  // Generic "sk-" prefixed secrets of meaningful length.
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  // Authorization headers / bearer tokens.
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
  // x-api-key header values in serialized requests.
  /(x-api-key["']?\s*[:=]\s*["']?)[^\s"',}]{8,}/gi,
];

const MIN_SECRET_LEN = 8;

export class Redactor {
  private readonly secrets = new Set<string>();

  constructor(secrets: Iterable<string | undefined> = []) {
    for (const s of secrets) this.add(s);
  }

  /** Register a secret value. Short/empty values are ignored (too noisy). */
  add(secret: string | undefined): this {
    if (!secret || secret.length < MIN_SECRET_LEN) return this;
    for (const variant of encodings(secret)) this.secrets.add(variant);
    return this;
  }

  /** Register the values of SECRET_ENV_VARS from the given env. */
  addFromEnv(env: NodeJS.ProcessEnv = process.env): this {
    for (const name of SECRET_ENV_VARS) this.add(env[name]);
    return this;
  }

  redact(text: string): string {
    let out = text;
    // Longest first so a secret that contains another is fully masked.
    const sorted = [...this.secrets].sort((a, b) => b.length - a.length);
    for (const s of sorted) out = out.split(s).join(REDACTED);
    for (const re of PATTERNS) {
      out = out.replace(re, (match, prefix?: unknown) =>
        typeof prefix === "string" && match.startsWith(prefix) ? `${prefix}${REDACTED}` : REDACTED,
      );
    }
    return out;
  }

  /** Deep-redact any JSON-like value (strings inside objects/arrays). */
  redactValue<T>(value: T): T {
    return JSON.parse(this.redact(JSON.stringify(value) ?? "null")) as T;
  }

  /**
   * Return a new Error whose message/stack/cause are redacted. The original
   * error object is NOT returned (SDK errors may carry headers/request data).
   */
  redactError(err: unknown): Error {
    if (err instanceof Error) {
      const safe = new Error(this.redact(err.message));
      safe.name = err.name;
      if (err.stack) safe.stack = this.redact(err.stack);
      else delete safe.stack;
      if (err.cause !== undefined) {
        safe.cause = this.redact(String(err.cause instanceof Error ? err.cause.message : err.cause));
      }
      return safe;
    }
    return new Error(this.redact(String(err)));
  }
}

function encodings(secret: string): string[] {
  const variants = new Set<string>([secret]);
  variants.add(encodeURIComponent(secret));
  variants.add(JSON.stringify(secret).slice(1, -1));
  variants.add(Buffer.from(secret, "utf8").toString("base64"));
  variants.add(Buffer.from(secret, "utf8").toString("base64url"));
  return [...variants].filter((v) => v.length >= MIN_SECRET_LEN);
}

/** Process-wide default redactor, seeded from the environment. */
export const defaultRedactor = new Redactor().addFromEnv();

export function redact(text: string): string {
  return defaultRedactor.redact(text);
}

/**
 * Minimal logger that redacts everything it writes. The spike uses this for
 * all output; transcript text must never be passed to it.
 */
export function createSafeLogger(
  redactor: Redactor = defaultRedactor,
  sink: (line: string) => void = (l) => process.stderr.write(l + "\n"),
) {
  const write = (level: string, msg: string, fields?: Record<string, unknown>) => {
    const line = JSON.stringify({ level, msg, ...(fields ?? {}) });
    sink(redactor.redact(line));
  };
  return {
    info: (msg: string, fields?: Record<string, unknown>) => write("info", msg, fields),
    warn: (msg: string, fields?: Record<string, unknown>) => write("warn", msg, fields),
    error: (msg: string, fields?: Record<string, unknown>) => write("error", msg, fields),
  };
}
