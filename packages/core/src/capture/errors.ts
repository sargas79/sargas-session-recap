/**
 * Typed errors for `recap import` (T05).
 *
 * Messages name what is wrong and where (an option, a mapping JSON Pointer, a package path) and
 * how to fix it. They never contain audio bytes, config values or consent evidence. Speaker IDs
 * are slugs from campaign.yaml and are shown so the operator knows what to fix.
 */

export type ImportErrorCode =
  /** The import directory does not exist or is not a directory. */
  | 'IMPORT_DIR_NOT_FOUND'
  /** No mapping file was found next to the tracks, or more than one. */
  | 'IMPORT_MAPPING_NOT_FOUND'
  | 'IMPORT_MAPPING_AMBIGUOUS'
  /** campaign.yaml's campaign_id differs from --campaign. */
  | 'IMPORT_CAMPAIGN_MISMATCH'
  /** A track listed in the mapping is not in the import directory (or is not a regular file). */
  | 'IMPORT_TRACK_MISSING'
  /** A track's codec, sample rate or channel count is not supported by the fragment contract. */
  | 'IMPORT_TRACK_UNSUPPORTED'
  /** Nothing is left to import after excluding refused speakers. */
  | 'IMPORT_NO_TRACKS'
  /** A source file changed while it was being imported, or the copy differs from it. */
  | 'IMPORT_SOURCE_CHANGED'
  /** The session already has a package and --replace was not given. */
  | 'IMPORT_SESSION_EXISTS'
  /** The existing package holds derived work (transcripts, classification, recaps) or is purged. */
  | 'IMPORT_SESSION_IN_USE'
  /** The produced package does not validate (a bug; the session directory is left untouched). */
  | 'IMPORT_PACKAGE_INVALID';

export class ImportError extends Error {
  readonly code: ImportErrorCode;
  readonly hint: string | undefined;

  constructor(code: ImportErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
    this.hint = hint;
  }

  /** Message plus fix hint, for printing to the operator. */
  toUserMessage(): string {
    return this.hint === undefined ? this.message : `${this.message}\n  fix: ${this.hint}`;
  }
}

export function isImportError(value: unknown): value is ImportError {
  return value instanceof ImportError;
}
