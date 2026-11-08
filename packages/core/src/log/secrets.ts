/**
 * Secret redaction (T10, design in docs/spikes/S05-llm-backends.md section 9).
 *
 * Two layers:
 * 1. Exact values: every secret the process knows (registered with `add`, or read from a known env
 *    var) is masked wherever it appears, including its URL-encoded, JSON-escaped and base64 forms.
 * 2. Patterns: anything that looks like an Anthropic key or a bearer token is masked even if it was
 *    never registered.
 *
 * {@link secretRedactor} is the one per-process instance: the logger applies it to every record and
 * the LLM adapters seed it with each key they resolve.
 */

export const REDACTED = '[REDACTED]';

/** Env vars whose values are always treated as secrets. */
export const SECRET_ENV_VARS: readonly string[] = Object.freeze([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_IDENTITY_TOKEN',
]);

const PATTERNS: readonly RegExp[] = [
  // Anthropic API, admin and OAuth keys: sk-ant-<kind>NN-<base64url...>
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  // Other sk- prefixed secrets of meaningful length.
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  // Authorization headers and bearer tokens.
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
  // x-api-key values in serialized requests. The prefix tolerates JSON-escaped quotes; the value
  // excludes `\` so a following escaped quote stays intact and JSON stays parseable.
  /(x-api-key\\?["']?\s*[:=]\s*\\?["']?)[^\s"',}\\]{8,}/gi,
];

/** Shorter values are too likely to match ordinary text. */
const MIN_SECRET_LENGTH = 8;

function encodings(secret: string): string[] {
  return [
    secret,
    encodeURIComponent(secret),
    JSON.stringify(secret).slice(1, -1),
    Buffer.from(secret, 'utf8').toString('base64'),
    Buffer.from(secret, 'utf8').toString('base64url'),
  ].filter((v) => v.length >= MIN_SECRET_LENGTH);
}

export class SecretRedactor {
  readonly #secrets = new Set<string>();

  add(secret: string | undefined): this {
    if (secret === undefined || secret.length < MIN_SECRET_LENGTH) return this;
    for (const variant of encodings(secret)) this.#secrets.add(variant);
    return this;
  }

  addFromEnv(env: Readonly<Record<string, string | undefined>>): this {
    for (const name of SECRET_ENV_VARS) this.add(env[name]);
    return this;
  }

  redact(text: string): string {
    let out = text;
    // Longest first, so a secret that contains another is fully masked.
    for (const secret of [...this.#secrets].sort((a, b) => b.length - a.length)) {
      out = out.split(secret).join(REDACTED);
    }
    for (const pattern of PATTERNS) {
      out = out.replace(pattern, (match: string, prefix?: unknown) =>
        typeof prefix === 'string' && match.startsWith(prefix) ? `${prefix}${REDACTED}` : REDACTED,
      );
    }
    return out;
  }

  /** Deep-redacts a JSON value. */
  redactValue<T>(value: T): T {
    return JSON.parse(this.redact(JSON.stringify(value))) as T;
  }
}

/** The per-process redactor, seeded from the environment. */
export const secretRedactor = new SecretRedactor().addFromEnv(process.env);
