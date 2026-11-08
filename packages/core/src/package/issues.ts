/**
 * Package validation issues. Every issue names the file and the field (JSON Pointer) it is about,
 * and its message is built only from rules and schema text. Issues never contain field VALUES:
 * values can be transcript text, player names or arbitrary bytes from a corrupted file
 * (AGENTS.md section 3). File names are echoed only after they passed the safe-path check.
 */
import type { LifecycleState } from '@sargas-recap/contracts';

export type IssueSeverity = 'error' | 'warning';

export type PackageIssueCode =
  /** The package directory or manifest.json is missing or unreadable. */
  | 'PACKAGE_NOT_FOUND'
  | 'FILE_MISSING'
  | 'FILE_UNREADABLE'
  | 'FILE_NOT_REGULAR'
  /** A JSON document or JSONL line is not valid JSON. */
  | 'INVALID_JSON'
  /** A record fails its contract schema. */
  | 'CONTRACT'
  /** A path is unsafe (traversal, Windows edge cases, link escaping the root). */
  | 'UNSAFE_PATH'
  | 'CASE_COLLISION'
  | 'DUPLICATE'
  /** Two fields that must agree do not (ADR-004 cross-field rules, manifest scope). */
  | 'INCONSISTENT'
  /** A sealed artifact is missing and was not purged. */
  | 'ARTIFACT_MISSING'
  /** A sealed artifact's bytes or hash changed after sealing. */
  | 'ARTIFACT_MODIFIED'
  /** A source artifact exists on disk but is not in the seal. */
  | 'ARTIFACT_UNSEALED'
  | 'ARTIFACT_KIND'
  /** Purge provenance does not match the seal. */
  | 'PURGE_MISMATCH'
  /** Purge was recorded but some purged files are still on disk (rerun purge-audio). */
  | 'PURGE_INCOMPLETE'
  /** A fragment points at audio that is not there (and was not purged). */
  | 'FRAGMENT_AUDIO_MISSING'
  /** An audio file no fragment refers to. */
  | 'AUDIO_UNREFERENCED'
  /** A temp file or directory left behind by an interrupted atomic write. */
  | 'TEMP_LEFTOVER'
  /** Too many issues; the rest were not reported. */
  | 'TRUNCATED';

/** Codes that mean the package's sealed content no longer matches what was sealed. */
export const INTEGRITY_CODES: ReadonlySet<PackageIssueCode> = new Set<PackageIssueCode>([
  'ARTIFACT_MISSING',
  'ARTIFACT_MODIFIED',
  'ARTIFACT_UNSEALED',
]);

export interface PackageIssue {
  readonly severity: IssueSeverity;
  readonly code: PackageIssueCode;
  /** Package-relative POSIX path of the file the issue is about (`.` for the package itself). */
  readonly file: string;
  /** 1-based line for JSON Lines files. */
  readonly line?: number;
  /** JSON Pointer of the field inside the record, `''` for the whole file or record. */
  readonly field: string;
  readonly message: string;
}

/**
 * Overall verdict. A valid package reports its lifecycle state (so a purged package reads
 * `audio-purged`, not corrupt). `corrupt`: sealed content changed or went missing. `invalid`:
 * anything else (contract violations, unsafe paths, inconsistent records).
 */
export type PackageState = LifecycleState | 'corrupt' | 'invalid';

/** Renders one issue as `<severity> <file>[:<line>] <field>: <message>`. Safe to print and log. */
export function formatIssue(issue: PackageIssue): string {
  const where = issue.line === undefined ? issue.file : `${issue.file}:${issue.line}`;
  const field = issue.field === '' ? '' : ` ${issue.field}`;
  return `${issue.severity.padEnd(7)} ${where}${field}: ${issue.message}`;
}

export class PackageError extends Error {
  readonly code: string;
  readonly issues: readonly PackageIssue[];

  constructor(code: string, message: string, issues: readonly PackageIssue[] = []) {
    super(message);
    this.name = 'PackageError';
    this.code = code;
    this.issues = issues;
  }
}
