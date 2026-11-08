import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Logger } from '../log/index.ts';
import { DbError } from './errors.ts';
import { loadMigrations, type Migration } from './migrations.ts';

/** The connection type handed to stage modules (T07 jobs, T12 overrides). */
export type SqliteDatabase = Database.Database;

export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

export interface OpenDatabaseOptions {
  /** Directory with `NNNN_name.sql` files. Defaults to the shipped migrations. */
  readonly migrationsDir?: string | undefined;
  /** Pre-loaded migrations (wins over `migrationsDir`). */
  readonly migrations?: readonly Migration[] | undefined;
  /** Where pre-migration backups go. Defaults to `<dir of file>/backups`. */
  readonly backupDir?: string | undefined;
  /** SQLite `busy_timeout`; how long to wait for another writer. */
  readonly busyTimeoutMs?: number | undefined;
  /** Clock override for tests (backup names, `applied_at`). */
  readonly now?: (() => Date) | undefined;
  readonly logger?: Logger | undefined;
}

export interface OpenedDatabase {
  readonly db: SqliteDatabase;
  /** Schema version after opening (always the latest known migration). */
  readonly schemaVersion: number;
  /** Schema version found on disk before opening (`0` for a new database). */
  readonly previousVersion: number;
  /** Versions applied by this open, in order. Empty when already current. */
  readonly applied: readonly number[];
  /** Backup taken before migrating, if any. */
  readonly backupFile: string | undefined;
}

interface VersionRow {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

function latestVersion(migrations: readonly Migration[]): number {
  return migrations.at(-1)?.version ?? 0;
}

function hasMigrationsTable(db: SqliteDatabase): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'")
      .get() !== undefined
  );
}

/**
 * Reads the on-disk schema version and checks it against the code: refuses a
 * database newer than the code, one whose applied migrations were edited, and
 * a non-empty database that recap did not create.
 */
function inspectVersion(
  db: SqliteDatabase,
  file: string,
  migrations: readonly Migration[],
): number {
  if (!hasMigrationsTable(db)) {
    const row = db
      .prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
      .get() as { n: number };
    if (row.n > 0) {
      throw new DbError('DB_NOT_RECAP', `${file} is a SQLite database that recap did not create`, {
        hint: 'point --data-root at a recap data root, or move this file away',
      });
    }
    return 0;
  }
  const rows = db
    .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
    .all() as VersionRow[];
  const version = rows.at(-1)?.version ?? 0;
  const known = latestVersion(migrations);
  if (version > known) {
    throw new DbError(
      'DB_SCHEMA_TOO_NEW',
      `${file} has schema v${version}, but this recap only knows up to v${known}`,
      {
        hint: 'update recap to the version that last opened this data root; downgrades are not supported',
      },
    );
  }
  rows.forEach((row, i) => {
    const migration = migrations[i];
    if (row.version !== i + 1 || migration === undefined) {
      throw new DbError(
        'DB_MIGRATION_MODIFIED',
        `${file}: schema_migrations has a gap at v${i + 1}`,
      );
    }
    if (migration.checksum !== row.checksum) {
      throw new DbError(
        'DB_MIGRATION_MODIFIED',
        `migration ${migration.name} changed after it was applied to ${file}`,
        {
          hint: 'migrations are forward-only: restore the original file and add a new migration instead',
        },
      );
    }
  });
  return version;
}

function configure(db: SqliteDatabase, busyTimeoutMs: number): void {
  db.pragma(`busy_timeout = ${String(Math.max(0, Math.trunc(busyTimeoutMs)))}`);
  const mode = db.pragma('journal_mode = WAL', { simple: true });
  if (mode !== 'wal') {
    throw new DbError('DB_WAL_UNAVAILABLE', `could not enable WAL mode (got ${String(mode)})`, {
      hint: 'keep the data root on a local disk; WAL does not work on network shares',
    });
  }
  // NORMAL is durable across application crashes in WAL mode and much faster than FULL.
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
}

function stamp(date: Date): string {
  // 2026-11-07T10:15:00.123Z -> 20261107T101500123Z (safe in Windows file names)
  return date.toISOString().replace(/[-:.]/g, '');
}

async function backupBeforeMigrating(
  db: SqliteDatabase,
  file: string,
  backupDir: string,
  fromVersion: number,
  now: () => Date,
): Promise<string> {
  mkdirSync(backupDir, { recursive: true });
  const ext = path.extname(file);
  const base = path.basename(file, ext);
  const target = path.join(
    backupDir,
    `${base}-v${String(fromVersion).padStart(4, '0')}-${stamp(now())}${ext}`,
  );
  // Online backup API: a consistent copy including pages still in the WAL.
  await db.backup(target);
  return target;
}

function applyPending(
  db: SqliteDatabase,
  file: string,
  migrations: readonly Migration[],
  now: () => Date,
): { from: number; applied: number[] } {
  const record = (m: Migration): void => {
    db.prepare(
      'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
    ).run(m.version, m.name, m.checksum, now().toISOString());
  };
  const run = db.transaction(() => {
    // Re-read under the write lock: another process may have migrated meanwhile.
    const from = inspectVersion(db, file, migrations);
    const pending = migrations.filter((m) => m.version > from);
    for (const m of pending) {
      try {
        db.exec(m.sql);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new DbError(
          'DB_MIGRATION_FAILED',
          `migration ${m.name} failed (${reason}); ${file} stays at schema v${from}`,
          { cause: error },
        );
      }
      if (!db.inTransaction) {
        throw new DbError(
          'DB_MIGRATION_FAILED',
          `migration ${m.name} ended the transaction itself; migrations must not contain BEGIN/COMMIT`,
        );
      }
      record(m);
    }
    const violations = db.pragma('foreign_key_check') as unknown[];
    if (violations.length > 0) {
      throw new DbError(
        'DB_MIGRATION_FAILED',
        `migrations left ${String(violations.length)} foreign key violation(s); ${file} stays at schema v${from}`,
      );
    }
    return { from, applied: pending.map((m) => m.version) };
  });
  // IMMEDIATE takes the write lock up front, so concurrent openers serialize here.
  return run.immediate();
}

/**
 * Opens (creating if needed) the state database and brings it to the latest
 * schema: WAL, `foreign_keys=ON`, `busy_timeout`; refuses a newer schema; backs
 * up an existing database before migrating; applies all pending migrations in
 * one transaction, so a failure leaves the previous version intact.
 */
export async function openDatabase(
  file: string,
  options: OpenDatabaseOptions = {},
): Promise<OpenedDatabase> {
  const migrations = options.migrations ?? loadMigrations(options.migrationsDir);
  const known = latestVersion(migrations);
  const now = options.now ?? (() => new Date());
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;

  mkdirSync(path.dirname(file), { recursive: true });
  let db: SqliteDatabase;
  try {
    db = new Database(file, { timeout: busyTimeoutMs });
  } catch (error) {
    throw new DbError('DB_OPEN_FAILED', `cannot open ${file}`, { cause: error });
  }
  try {
    configure(db, busyTimeoutMs);
    const before = inspectVersion(db, file, migrations);
    let backupFile: string | undefined;
    if (before > 0 && before < known) {
      backupFile = await backupBeforeMigrating(
        db,
        file,
        options.backupDir ?? path.join(path.dirname(file), 'backups'),
        before,
        now,
      );
    }
    const started = Date.now();
    const { from, applied } =
      before < known ? applyPending(db, file, migrations, now) : { from: before, applied: [] };
    if (applied.length > 0) {
      options.logger?.child(['fromVersion', 'toVersion']).info('db.migrated', {
        fromVersion: from,
        toVersion: known,
        count: applied.length,
        durationMs: Date.now() - started,
      });
    }
    return { db, schemaVersion: known, previousVersion: before, applied, backupFile };
  } catch (error) {
    db.close();
    throw error;
  }
}

export type SchemaStatus =
  | { readonly state: 'missing'; readonly codeVersion: number }
  | { readonly state: 'uninitialized'; readonly codeVersion: number }
  | { readonly state: 'ok'; readonly version: number; readonly codeVersion: number }
  | { readonly state: 'outdated'; readonly version: number; readonly codeVersion: number }
  | { readonly state: 'too-new'; readonly version: number; readonly codeVersion: number }
  | {
      readonly state: 'error';
      readonly code: string;
      readonly message: string;
      readonly codeVersion: number | undefined;
    };

/**
 * Reports the schema version without creating or migrating anything (for
 * `recap doctor`). A missing file stays missing; an existing one is opened
 * read-only.
 */
export function readSchemaStatus(
  file: string,
  options: Pick<OpenDatabaseOptions, 'migrations' | 'migrationsDir'> = {},
): SchemaStatus {
  let migrations: readonly Migration[];
  try {
    migrations = options.migrations ?? loadMigrations(options.migrationsDir);
  } catch (error) {
    return toErrorStatus(error, undefined);
  }
  const codeVersion = latestVersion(migrations);
  if (!existsSync(file)) {
    return { state: 'missing', codeVersion };
  }
  let db: SqliteDatabase | undefined;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const version = inspectVersion(db, file, migrations);
    if (version === 0) {
      return { state: 'uninitialized', codeVersion };
    }
    return { state: version < codeVersion ? 'outdated' : 'ok', version, codeVersion };
  } catch (error) {
    if (error instanceof DbError && error.code === 'DB_SCHEMA_TOO_NEW' && db !== undefined) {
      const row = db.prepare('SELECT max(version) AS v FROM schema_migrations').get() as {
        v: number;
      };
      return { state: 'too-new', version: row.v, codeVersion };
    }
    return toErrorStatus(error, codeVersion);
  } finally {
    db?.close();
  }
}

function toErrorStatus(error: unknown, codeVersion: number | undefined): SchemaStatus {
  if (error instanceof DbError) {
    return { state: 'error', code: error.code, message: error.message, codeVersion };
  }
  return {
    state: 'error',
    code: 'DB_OPEN_FAILED',
    message: error instanceof Error ? error.message : String(error),
    codeVersion,
  };
}
