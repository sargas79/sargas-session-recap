import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DbError } from './errors.ts';

/**
 * Shipped migrations. Resolves to `src/db/migrations/` when running from source
 * and `dist/db/migrations/` in the build (copied by `scripts/copy-migrations.js`).
 */
export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

/** `0001_init.sql`: four-digit version, underscore, lowercase snake-case name. */
const FILE_RE = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;

export interface Migration {
  readonly version: number;
  /** File name without extension, e.g. `0001_init`. */
  readonly name: string;
  readonly sql: string;
  /** `sha256:<hex>` of the SQL with line endings normalized to LF. */
  readonly checksum: string;
}

export function migrationChecksum(sql: string): string {
  return `sha256:${createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex')}`;
}

/**
 * Loads `NNNN_name.sql` files sorted by version. Versions must be contiguous from
 * 1 with no duplicates; any other `.sql` file is an error so a typo cannot be
 * skipped silently.
 */
export function loadMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): Migration[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    throw new DbError('DB_MIGRATIONS_INVALID', `cannot read migrations directory ${dir}`, {
      hint: 'rebuild recap (`npm run build`); the migrations are copied into dist/',
      cause: error,
    });
  }
  const migrations: Migration[] = [];
  for (const file of entries.filter((f) => f.toLowerCase().endsWith('.sql'))) {
    const match = FILE_RE.exec(file);
    if (match?.[1] === undefined) {
      throw new DbError(
        'DB_MIGRATIONS_INVALID',
        `migration file name ${file} is not NNNN_name.sql`,
      );
    }
    const sql = readFileSync(path.join(dir, file), 'utf8');
    migrations.push({
      version: Number(match[1]),
      name: file.slice(0, -'.sql'.length),
      sql,
      checksum: migrationChecksum(sql),
    });
  }
  migrations.sort((a, b) => a.version - b.version);
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new DbError(
        'DB_MIGRATIONS_INVALID',
        `migrations must be numbered 0001, 0002, ... without gaps or duplicates; found ${m.name} at position ${i + 1}`,
      );
    }
  });
  if (migrations.length === 0) {
    throw new DbError('DB_MIGRATIONS_INVALID', `no migrations found in ${dir}`);
  }
  return migrations;
}
