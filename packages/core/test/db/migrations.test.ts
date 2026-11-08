import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DbError,
  DEFAULT_MIGRATIONS_DIR,
  loadMigrations,
  openDatabase,
  openStateDatabase,
  readSchemaStatus,
  type OpenedDatabase,
} from '../../src/db/index.ts';
import { openDataRoot } from '../../src/paths/index.ts';

// Synthetic, test-only migrations layered on top of the shipped 0001_init.
const EXTRA = {
  '0002_add_notes.sql':
    "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);\nINSERT INTO notes (body) VALUES ('synthetic');\n",
  '0003_add_tags.sql':
    'CREATE TABLE tags (id INTEGER PRIMARY KEY, note_id INTEGER NOT NULL REFERENCES notes (id));\n',
};
const BROKEN_0003 = {
  '0003_broken.sql':
    'CREATE TABLE tags (id INTEGER PRIMARY KEY);\nINSERT INTO table_that_does_not_exist VALUES (1);\n',
};

const dirs: string[] = [];
const open: OpenedDatabase[] = [];

afterEach(() => {
  for (const o of open.splice(0)) {
    if (o.db.open) o.db.close();
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tmp(prefix = 'recap-db-'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A migrations dir with the shipped 0001 plus the given extra files. */
function migrationsDir(extra: Record<string, string> = {}): string {
  const dir = tmp('recap-mig-');
  copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, '0001_init.sql'), path.join(dir, '0001_init.sql'));
  for (const [name, sql] of Object.entries(extra)) {
    writeFileSync(path.join(dir, name), sql);
  }
  return dir;
}

function subset(count: number): Record<string, string> {
  return Object.fromEntries(Object.entries(EXTRA).slice(0, count - 1));
}

async function openTracked(file: string, options: Parameters<typeof openDatabase>[1]) {
  const opened = await openDatabase(file, options);
  open.push(opened);
  return opened;
}

function closeAll(): void {
  for (const o of open) if (o.db.open) o.db.close();
}

function versionOnDisk(file: string): number {
  const db = new Database(file, { readonly: true });
  try {
    const row = db.prepare('SELECT max(version) AS v FROM schema_migrations').get() as {
      v: number;
    };
    return row.v;
  } finally {
    db.close();
  }
}

function tables(file: string): string[] {
  const db = new Database(file, { readonly: true });
  try {
    return (
      db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
  } finally {
    db.close();
  }
}

async function expectDbError(promise: Promise<unknown>, code: string): Promise<DbError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DbError);
  expect((error as DbError).code).toBe(code);
  return error as DbError;
}

describe('shipped migrations', () => {
  it('load as a contiguous list starting at 0001_init', () => {
    const migrations = loadMigrations();
    expect(migrations[0]?.name).toBe('0001_init');
    migrations.forEach((m, i) => {
      expect(m.version).toBe(i + 1);
      expect(m.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    });
  });

  it('are copied into dist by the build', () => {
    const dist = fileURLToPath(new URL('../../dist/db/migrations/', import.meta.url));
    if (!existsSync(path.dirname(dist))) return; // build has not run
    const src = readdirSync(DEFAULT_MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
    expect(readdirSync(dist).filter((f) => f.endsWith('.sql'))).toEqual(src);
    for (const f of src) {
      expect(readFileSync(path.join(dist, f), 'utf8')).toBe(
        readFileSync(path.join(DEFAULT_MIGRATIONS_DIR, f), 'utf8'),
      );
    }
  });

  it('checksums ignore CRLF vs LF', () => {
    const lf = migrationsDir({ '0002_x.sql': 'CREATE TABLE x (a);\nCREATE TABLE y (b);\n' });
    const crlf = migrationsDir({ '0002_x.sql': 'CREATE TABLE x (a);\r\nCREATE TABLE y (b);\r\n' });
    expect(loadMigrations(crlf)[1]?.checksum).toBe(loadMigrations(lf)[1]?.checksum);
  });

  it.each<[Record<string, string>, string]>([
    [{ '0003_gap.sql': 'SELECT 1;' }, 'gap'],
    [{ '0001_dup.sql': 'SELECT 1;' }, 'duplicate'],
    [{ 'bad-name.sql': 'SELECT 1;' }, 'bad name'],
  ])('rejects a malformed directory (%#: %s)', (extra) => {
    expect(() => loadMigrations(migrationsDir(extra))).toThrow(DbError);
  });
});

describe('openDatabase', () => {
  it('migrates an empty database to the latest version with WAL, foreign_keys and busy_timeout', async () => {
    const file = path.join(tmp(), 'state', 'recap.sqlite');
    const o = await openTracked(file, { migrationsDir: migrationsDir(EXTRA), busyTimeoutMs: 1234 });
    expect(o.previousVersion).toBe(0);
    expect(o.schemaVersion).toBe(3);
    expect(o.applied).toEqual([1, 2, 3]);
    expect(o.backupFile).toBeUndefined(); // nothing to back up in a new DB
    expect(o.db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(o.db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(o.db.pragma('busy_timeout', { simple: true })).toBe(1234);
    closeAll();
    expect(versionOnDisk(file)).toBe(3);
    expect(tables(file)).toEqual(['notes', 'schema_migrations', 'tags']);
  });

  it('opens the shipped migrations on a fresh data root', async () => {
    const o = await openTracked(path.join(tmp(), 'recap.sqlite'), {});
    expect(o.schemaVersion).toBe(loadMigrations().length);
  });

  it.each([1, 2])('migrates from prior version v%i to the latest, with a backup', async (from) => {
    const file = path.join(tmp(), 'recap.sqlite');
    const first = await openTracked(file, { migrationsDir: migrationsDir(subset(from)) });
    expect(first.schemaVersion).toBe(from);
    first.db.close();

    const backupDir = path.join(tmp(), 'backups');
    const o = await openTracked(file, {
      migrationsDir: migrationsDir(EXTRA),
      backupDir,
      now: () => new Date('2026-11-07T10:15:00.123Z'),
    });
    expect(o.previousVersion).toBe(from);
    expect(o.applied).toEqual([1, 2, 3].filter((v) => v > from));
    expect(o.backupFile).toBe(
      path.join(backupDir, `recap-v000${String(from)}-20261107T101500123Z.sqlite`),
    );
    closeAll();
    expect(versionOnDisk(file)).toBe(3);
    expect(versionOnDisk(o.backupFile ?? '')).toBe(from);
  });

  it('is idempotent: re-opening applies nothing and takes no backup', async () => {
    const file = path.join(tmp(), 'recap.sqlite');
    const dir = migrationsDir(EXTRA);
    const backupDir = path.join(tmp(), 'backups');
    (await openTracked(file, { migrationsDir: dir, backupDir })).db.close();
    const again = await openTracked(file, { migrationsDir: dir, backupDir });
    expect(again.applied).toEqual([]);
    expect(again.previousVersion).toBe(3);
    expect(again.backupFile).toBeUndefined();
    const rows = again.db.prepare('SELECT count(*) AS n FROM notes').get() as { n: number };
    expect(rows.n).toBe(1); // 0002's INSERT ran exactly once
    expect(existsSync(backupDir)).toBe(false);
  });

  it('a failure mid-migration leaves the DB at the previous version, with the backup present', async () => {
    const file = path.join(tmp(), 'recap.sqlite');
    (await openTracked(file, { migrationsDir: migrationsDir() })).db.close();
    expect(versionOnDisk(file)).toBe(1);

    const backupDir = path.join(tmp(), 'backups');
    // 0002 succeeds, 0003 fails halfway (its CREATE TABLE ran, its INSERT fails).
    const error = await expectDbError(
      openDatabase(file, {
        migrationsDir: migrationsDir({ ...subset(2), ...BROKEN_0003 }),
        backupDir,
      }),
      'DB_MIGRATION_FAILED',
    );
    expect(error.message).toContain('0003_broken');
    expect(error.message).toContain('stays at schema v1');

    expect(versionOnDisk(file)).toBe(1);
    expect(tables(file)).toEqual(['schema_migrations']); // neither notes nor tags survived
    const backups = readdirSync(backupDir);
    expect(backups).toHaveLength(1);
    expect(versionOnDisk(path.join(backupDir, backups[0] ?? ''))).toBe(1);

    // After fixing the migration, the next open succeeds from v1.
    const fixed = await openTracked(file, { migrationsDir: migrationsDir(EXTRA), backupDir });
    expect(fixed.previousVersion).toBe(1);
    expect(fixed.applied).toEqual([2, 3]);
  });

  it('refuses a database newer than the code and leaves it untouched', async () => {
    const file = path.join(tmp(), 'recap.sqlite');
    (await openTracked(file, { migrationsDir: migrationsDir(EXTRA) })).db.close();
    const before = readFileSync(file);
    const error = await expectDbError(
      openDatabase(file, { migrationsDir: migrationsDir(subset(2)) }),
      'DB_SCHEMA_TOO_NEW',
    );
    expect(error.message).toContain('schema v3');
    expect(error.message).toContain('up to v2');
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it('refuses when an applied migration was edited', async () => {
    const file = path.join(tmp(), 'recap.sqlite');
    (await openTracked(file, { migrationsDir: migrationsDir(subset(2)) })).db.close();
    const edited = migrationsDir({
      '0002_add_notes.sql': 'CREATE TABLE notes (id INTEGER PRIMARY KEY);\n',
    });
    await expectDbError(openDatabase(file, { migrationsDir: edited }), 'DB_MIGRATION_MODIFIED');
  });

  it('refuses a SQLite file that recap did not create', async () => {
    const file = path.join(tmp(), 'other.sqlite');
    const db = new Database(file);
    db.exec('CREATE TABLE foreign_stuff (a)');
    db.close();
    await expectDbError(openDatabase(file, { migrationsDir: migrationsDir() }), 'DB_NOT_RECAP');
  });

  it('works under a data root with spaces and non-ASCII characters', async () => {
    const home = tmp('recap Usuário José Ñúñez 李 ');
    const env = {
      LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      XDG_DATA_HOME: path.join(home, 'xdg'),
    };
    const { paths, source } = openDataRoot({ env, homedir: home });
    expect(source).toBe('default');
    expect(paths.root.startsWith(home)).toBe(true);
    const o = await openStateDatabase(paths);
    open.push(o);
    expect(o.schemaVersion).toBe(loadMigrations().length);
    expect(existsSync(paths.dbFile)).toBe(true);
    const session = paths.sessionDir('campaign-1', 's01');
    mkdirSync(session, { recursive: true });
    expect(existsSync(session)).toBe(true);
  });
});

describe('readSchemaStatus (doctor)', () => {
  it('reports a missing database without creating it', () => {
    const file = path.join(tmp(), 'state', 'recap.sqlite');
    expect(readSchemaStatus(file)).toEqual({
      state: 'missing',
      codeVersion: loadMigrations().length,
    });
    expect(existsSync(file)).toBe(false);
    expect(existsSync(path.dirname(file))).toBe(false);
  });

  it('reports ok, outdated and too-new', async () => {
    const file = path.join(tmp(), 'recap.sqlite');
    (await openTracked(file, { migrationsDir: migrationsDir(subset(2)) })).db.close();
    expect(readSchemaStatus(file, { migrationsDir: migrationsDir(subset(2)) })).toEqual({
      state: 'ok',
      version: 2,
      codeVersion: 2,
    });
    expect(readSchemaStatus(file, { migrationsDir: migrationsDir(EXTRA) })).toMatchObject({
      state: 'outdated',
      version: 2,
      codeVersion: 3,
    });
    expect(readSchemaStatus(file, { migrationsDir: migrationsDir() })).toMatchObject({
      state: 'too-new',
      version: 2,
      codeVersion: 1,
    });
    expect(versionOnDisk(file)).toBe(2); // read-only: nothing migrated
  });
});
