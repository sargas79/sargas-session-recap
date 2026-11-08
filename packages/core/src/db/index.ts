import type { DataPaths } from '../paths/index.ts';
import { openDatabase, type OpenDatabaseOptions, type OpenedDatabase } from './open.ts';

export { DbError, type DbErrorCode } from './errors.ts';
export {
  DEFAULT_MIGRATIONS_DIR,
  loadMigrations,
  migrationChecksum,
  type Migration,
} from './migrations.ts';
export {
  DEFAULT_BUSY_TIMEOUT_MS,
  openDatabase,
  readSchemaStatus,
  type OpenDatabaseOptions,
  type OpenedDatabase,
  type SchemaStatus,
  type SqliteDatabase,
} from './open.ts';

/** Opens `<root>/state/recap.sqlite`, migrating it, with backups in `<root>/state/backups/`. */
export function openStateDatabase(
  paths: DataPaths,
  options: Omit<OpenDatabaseOptions, 'backupDir'> = {},
): Promise<OpenedDatabase> {
  return openDatabase(paths.dbFile, { ...options, backupDir: paths.backupsDir });
}
