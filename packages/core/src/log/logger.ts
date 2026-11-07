/**
 * Minimal structured logger with a redaction allowlist.
 *
 * Only fields whose names are explicitly allowed are emitted. Everything else
 * (transcript text, prompts, API keys, tokens, file contents, ...) is dropped
 * before serialization, so it can never reach a log sink by accident. Only
 * primitive values are emitted for allowed fields; nested objects and arrays
 * are dropped too, because they could carry unlisted data.
 *
 * The record envelope (`ts`, `level`, `event`) is always present. When fields
 * are dropped, only their count is recorded (`redacted`), never their names or
 * values.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogValue = string | number | boolean | null;

export type LogFields = Readonly<Record<string, unknown>>;

export interface LogRecord {
  readonly ts: string;
  readonly level: LogLevel;
  readonly event: string;
  readonly redacted?: number;
  readonly [field: string]: LogValue | undefined;
}

export type LogSink = (line: string) => void;

export interface LoggerOptions {
  /** Field names allowed in addition to {@link DEFAULT_ALLOWED_FIELDS}. */
  readonly allow?: readonly string[];
  /** Minimum level to emit. Defaults to `info`. */
  readonly level?: LogLevel;
  /** Where serialized JSON lines go. Defaults to stderr. */
  readonly sink?: LogSink;
  /** Clock override for tests. */
  readonly now?: () => Date;
}

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** Returns a logger whose allowlist additionally contains `allow`. */
  child(allow: readonly string[]): Logger;
}

/**
 * Fields considered safe everywhere: identifiers, counts, durations, states and
 * error codes. Never add free-text or content-bearing fields here.
 */
export const DEFAULT_ALLOWED_FIELDS: readonly string[] = Object.freeze([
  'campaignId',
  'sessionId',
  'runId',
  'jobId',
  'stage',
  'command',
  'status',
  'attempt',
  'count',
  'durationMs',
  'errorCode',
]);

/** Envelope keys that callers cannot override via fields. */
const RESERVED_FIELDS = new Set(['ts', 'level', 'event', 'redacted']);

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function isLogValue(value: unknown): value is LogValue {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

const defaultSink: LogSink = (line) => {
  process.stderr.write(`${line}\n`);
};

/**
 * Builds the record that would be emitted for `fields`, applying the allowlist.
 * Exported for tests and for sinks that need the structured form.
 */
export function redact(
  level: LogLevel,
  event: string,
  fields: LogFields | undefined,
  allowed: ReadonlySet<string>,
  now: Date,
): LogRecord {
  const record: Record<string, LogValue | undefined> = {
    ts: now.toISOString(),
    level,
    event,
  };
  let redacted = 0;
  if (fields !== undefined) {
    for (const [key, value] of Object.entries(fields)) {
      if (!RESERVED_FIELDS.has(key) && allowed.has(key) && isLogValue(value)) {
        record[key] = value;
      } else {
        redacted += 1;
      }
    }
  }
  if (redacted > 0) {
    record['redacted'] = redacted;
  }
  return record as LogRecord;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const allowed = new Set([...DEFAULT_ALLOWED_FIELDS, ...(options.allow ?? [])]);
  const minLevel = LEVEL_ORDER[options.level ?? 'info'];
  const sink = options.sink ?? defaultSink;
  const now = options.now ?? (() => new Date());

  const emit = (level: LogLevel, event: string, fields?: LogFields): void => {
    if (LEVEL_ORDER[level] < minLevel) {
      return;
    }
    sink(JSON.stringify(redact(level, event, fields, allowed, now())));
  };

  return {
    debug: (event, fields) => {
      emit('debug', event, fields);
    },
    info: (event, fields) => {
      emit('info', event, fields);
    },
    warn: (event, fields) => {
      emit('warn', event, fields);
    },
    error: (event, fields) => {
      emit('error', event, fields);
    },
    child: (allow) =>
      createLogger({
        ...options,
        allow: [...(options.allow ?? []), ...allow],
      }),
  };
}
