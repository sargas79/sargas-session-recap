export type DbErrorCode =
  /** The database was migrated by a newer recap than this one. */
  | 'DB_SCHEMA_TOO_NEW'
  /** The migrations directory is malformed (gap, duplicate, bad file name). */
  | 'DB_MIGRATIONS_INVALID'
  /** An already-applied migration file changed since it was applied. */
  | 'DB_MIGRATION_MODIFIED'
  /** A migration failed; the database was rolled back to its previous version. */
  | 'DB_MIGRATION_FAILED'
  /** The file is a SQLite database that recap did not create. */
  | 'DB_NOT_RECAP'
  /** WAL journal mode could not be enabled (for example on a network share). */
  | 'DB_WAL_UNAVAILABLE'
  /** The database file could not be opened or read. */
  | 'DB_OPEN_FAILED';

/** Error raised by the state database layer. Messages never contain row data. */
export class DbError extends Error {
  readonly code: DbErrorCode;
  readonly hint: string | undefined;

  constructor(
    code: DbErrorCode,
    message: string,
    options: { hint?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DbError';
    this.code = code;
    this.hint = options.hint;
  }
}
