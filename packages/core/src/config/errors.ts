/**
 * Typed errors for campaign/glossary config and consent.
 *
 * Messages never echo config values: they carry the file path the operator passed, a JSON Pointer
 * (unknown keys masked as `<key>`), an optional line/column and a message derived from the schema.
 * Speaker, provider and stage identifiers are slugs from the config's own vocabulary and are shown
 * so the operator knows what to fix.
 */
import type { ConsentPurpose } from '@sargas-recap/contracts';

export type ConfigKind = 'campaign-config' | 'glossary';

export type ConfigErrorCode =
  | 'CONFIG_READ_FAILED'
  | 'CONFIG_TOO_LARGE'
  | 'CONFIG_NOT_UTF8'
  | 'CONFIG_YAML_SYNTAX'
  | 'CONFIG_YAML_FORBIDDEN'
  | 'CONFIG_INVALID';

export interface ConfigIssue {
  /** JSON Pointer into the document, e.g. `/entries/3/type`; `''` for the whole document. */
  readonly path: string;
  /** JSON Schema keyword, a YAML error code, or a semantic rule name (`unique`, `order`). */
  readonly keyword: string;
  readonly message: string;
  /** 1-based position in the YAML source, when known. */
  readonly line?: number;
  readonly col?: number;
}

export class ConfigError extends Error {
  readonly code: ConfigErrorCode;
  readonly kind: ConfigKind;
  /** The path the caller passed (or a label for in-memory sources). */
  readonly file: string;
  readonly issues: readonly ConfigIssue[];

  constructor(
    code: ConfigErrorCode,
    kind: ConfigKind,
    file: string,
    issues: readonly ConfigIssue[],
    options: { cause?: unknown } = {},
  ) {
    super(formatConfigError(kind, file, issues), options.cause === undefined ? undefined : options);
    this.name = 'ConfigError';
    this.code = code;
    this.kind = kind;
    this.file = file;
    this.issues = issues;
  }
}

function where(file: string, issue: ConfigIssue): string {
  const pos = issue.line === undefined ? '' : `:${String(issue.line)}:${String(issue.col ?? 1)}`;
  return `${file}${pos}`;
}

function formatConfigError(kind: ConfigKind, file: string, issues: readonly ConfigIssue[]): string {
  const head = `invalid ${kind} file ${file} (${String(issues.length)} problem${issues.length === 1 ? '' : 's'})`;
  const lines = issues.map(
    (i) => `  ${where(file, i)}: ${i.path === '' ? '/' : i.path}: ${i.message}`,
  );
  return [head, ...lines].join('\n');
}

export function isConfigError(value: unknown): value is ConfigError {
  return value instanceof ConfigError;
}

export type ConsentErrorCode =
  /** At least one included speaker has no active consent for this provider and purpose. */
  | 'CONSENT_MISSING'
  /** The provider is not the one configured for this stage in campaign.yaml. */
  | 'CONSENT_PROVIDER_NOT_CONFIGURED'
  /** No speakers were passed: fail closed instead of silently allowing the call. */
  | 'CONSENT_NO_SPEAKERS';

export type ConsentRefusalReason =
  'unknown-speaker' | 'no-record' | 'withdrawn' | 'not-yet-granted' | 'no-recording-consent';

export interface ConsentRefusal {
  readonly speaker_id: string;
  readonly reason: ConsentRefusalReason;
}

const REASON_TEXT: Readonly<Record<ConsentRefusalReason, string>> = {
  'unknown-speaker': 'not a speaker in campaign.yaml',
  'no-record': 'no consent record for this provider and purpose',
  withdrawn: 'consent for this provider and purpose was withdrawn',
  'not-yet-granted': 'consent for this provider and purpose starts later',
  'no-recording-consent': 'no active recording consent',
};

export class ConsentError extends Error {
  readonly code: ConsentErrorCode;
  readonly stage: ConsentPurpose;
  readonly provider: string;
  readonly refusals: readonly ConsentRefusal[];

  constructor(
    code: ConsentErrorCode,
    stage: ConsentPurpose,
    provider: string,
    refusals: readonly ConsentRefusal[],
    detail: string,
  ) {
    const who = refusals.map((r) => `${r.speaker_id} (${REASON_TEXT[r.reason]})`).join(', ');
    super(
      `consent check refused stage ${stage} with provider ${provider}: ${detail}${who === '' ? '' : `: ${who}`}`,
    );
    this.name = 'ConsentError';
    this.code = code;
    this.stage = stage;
    this.provider = provider;
    this.refusals = refusals;
  }
}

export function isConsentError(value: unknown): value is ConsentError {
  return value instanceof ConsentError;
}
