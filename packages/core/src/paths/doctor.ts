import { existsSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import path from 'node:path';
import { readSchemaStatus, type SchemaStatus } from '../db/index.ts';
import { PathsError } from './errors.ts';
import { createDataPaths } from './layout.ts';
import { findEnclosingGit, type ExistsFn } from './repo-guard.ts';
import { resolveDataRoot, type DataRootInputs, type DataRootSource } from './resolve.ts';

/** Below this, doctor adds a note: one multitrack session can take several GiB. */
export const LOW_DISK_BYTES = 2 * 1024 ** 3;

export interface DataRootCheckOptions extends DataRootInputs {
  readonly allowInRepo?: boolean | undefined;
  readonly exists?: ExistsFn | undefined;
  /** Test seam: migrations to compare the DB against. */
  readonly migrationsDir?: string | undefined;
}

export interface DataRootCheck {
  /** False when the data root is refused/unusable or the DB cannot be used. */
  readonly ok: boolean;
  readonly lines: string[];
  readonly root: string | undefined;
  readonly source: DataRootSource | undefined;
  readonly freeBytes: number | undefined;
  readonly schema: SchemaStatus | undefined;
}

const SOURCE_LABEL: Readonly<Record<DataRootSource, string>> = {
  flag: '--data-root',
  env: 'RECAP_DATA_ROOT',
  config: 'config',
  default: 'default',
};

const LABEL_WIDTH = 12;
const label = (name: string): string => `  ${name}:`.padEnd(LABEL_WIDTH);
const indent = ' '.repeat(LABEL_WIDTH);

export function formatBytes(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  return gib >= 1 ? `${gib.toFixed(1)} GiB` : `${(bytes / 1024 ** 2).toFixed(0)} MiB`;
}

/** Nearest existing directory at or above `p`, so a not-yet-created root can be measured. */
function nearestExisting(p: string): string {
  let dir = path.resolve(p);
  while (!existsSync(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return dir;
}

async function freeSpace(root: string): Promise<{ bytes: number; at: string } | undefined> {
  const at = nearestExisting(root);
  try {
    const st = await statfs(at);
    return { bytes: st.bavail * st.bsize, at };
  } catch {
    return undefined;
  }
}

function schemaLines(schema: SchemaStatus, dbFile: string): { ok: boolean; lines: string[] } {
  const where = `${indent}path: ${dbFile}`;
  switch (schema.state) {
    case 'missing':
      return {
        ok: true,
        lines: [
          `${label('db')}not initialized (created at schema v${schema.codeVersion} on first use)`,
          where,
        ],
      };
    case 'uninitialized':
      return {
        ok: true,
        lines: [
          `${label('db')}not initialized (empty file; schema v${schema.codeVersion} on first use)`,
          where,
        ],
      };
    case 'ok':
      return { ok: true, lines: [`${label('db')}ok schema v${schema.version}`, where] };
    case 'outdated':
      return {
        ok: true,
        lines: [
          `${label('db')}ok schema v${schema.version} (v${schema.codeVersion} pending: migrated with a backup on next use)`,
          where,
        ],
      };
    case 'too-new':
      return {
        ok: false,
        lines: [
          `${label('db')}UNUSABLE - schema v${schema.version} is newer than this recap (v${schema.codeVersion}) [DB_SCHEMA_TOO_NEW]`,
          where,
          `${indent}fix: update recap; downgrades are not supported`,
        ],
      };
    case 'error':
      return {
        ok: false,
        lines: [`${label('db')}UNUSABLE - ${schema.message} [${schema.code}]`, where],
      };
  }
}

/**
 * `recap doctor` checks for the data root: where it is and why, whether it is
 * refused (inside a git working tree), free disk space, and the DB schema
 * version. Read-only: never creates the data root or the database.
 */
export async function checkDataRoot(options: DataRootCheckOptions = {}): Promise<DataRootCheck> {
  let resolved;
  try {
    resolved = resolveDataRoot(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof PathsError ? error.code : 'PATHS_DATA_ROOT_INVALID';
    const lines = [`${label('data')}UNUSABLE - ${message} [${code}]`];
    if (error instanceof PathsError && error.hint !== undefined) {
      lines.push(`${indent}fix: ${error.hint}`);
    }
    return {
      ok: false,
      lines,
      root: undefined,
      source: undefined,
      freeBytes: undefined,
      schema: undefined,
    };
  }

  const { root, source } = resolved;
  const paths = createDataPaths(root);
  let ok = true;
  const lines = [
    `${label('data')}${root} (from ${SOURCE_LABEL[source]})`,
    `${indent}${existsSync(root) ? 'exists' : 'not created yet'}`,
  ];

  const git = findEnclosingGit(root, options.exists);
  if (git !== undefined) {
    if (options.allowInRepo === true) {
      lines.push(`${indent}note: inside a git working tree (${git}), allowed by --allow-in-repo`);
    } else {
      ok = false;
      lines[0] = `${label('data')}REFUSED - ${root} (from ${SOURCE_LABEL[source]}) is inside a git working tree (${git}) [PATHS_DATA_ROOT_IN_REPO]`;
      lines.push(
        `${indent}fix: choose a data root outside the repository, or pass --allow-in-repo`,
      );
    }
  }

  const free = await freeSpace(root);
  if (free === undefined) {
    lines.push(`${label('disk')}unknown (statfs failed)`);
  } else {
    lines.push(`${label('disk')}${formatBytes(free.bytes)} free (at ${free.at})`);
    if (free.bytes < LOW_DISK_BYTES) {
      lines.push(`${indent}note: low disk space; one multitrack session can take several GiB`);
    }
  }

  const schema = readSchemaStatus(paths.dbFile, { migrationsDir: options.migrationsDir });
  const db = schemaLines(schema, paths.dbFile);
  lines.push(...db.lines);
  ok &&= db.ok;

  return { ok, lines, root, source, freeBytes: free?.bytes, schema };
}
