import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  JOB_INPUT_KINDS,
  JOB_STAGES,
  JOB_STATUSES,
  validateJobRecord,
} from '@sargas-recap/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_MIGRATIONS_DIR, loadMigrations, openDatabase } from '../../src/db/index.ts';
import {
  canTransition,
  createJob,
  getJob,
  JOB_INPUT_KIND_VALUES,
  JOB_STAGE_VALUES,
  JOB_STATUS_VALUES,
  JOB_TRANSITIONS,
  JobError,
  monotonicUlid,
  nextAttempt,
  StageError,
  toJobRecord,
  transitionJob,
  ULID_RE,
  type Job,
  type JobStatus,
} from '../../src/jobs/index.ts';
import { openFixture, sha, type Fixture } from './helpers.ts';

let fx: Fixture;
const ids = monotonicUlid();

beforeEach(async () => {
  fx = await openFixture();
});

afterEach(() => {
  fx.cleanup();
});

function newJob(maxAttempts = 3): string {
  const jobId = ids();
  createJob(fx.db, {
    jobId,
    campaignId: 'synthetic-vaults',
    sessionId: 's01',
    stage: 'transcribe',
    maxAttempts,
    inputs: [{ kind: 'artifact', ref: 'fragments.jsonl', hash: sha('a') }],
    now: new Date('2026-11-08T10:00:00Z'),
  });
  return jobId;
}

const NOW = { now: new Date('2026-11-08T10:01:00Z') };
const ERR = { code: 'provider-timeout', message: 'timed out', retryable: true };

/** Drives a fresh job into `status` through allowed transitions. */
function jobIn(status: JobStatus): string {
  const id = newJob();
  if (status === 'pending') return id;
  if (status === 'cancelled') {
    transitionJob(fx.db, id, 'pending', 'cancelled', NOW);
    return id;
  }
  transitionJob(fx.db, id, 'pending', 'running', { ...NOW, owner: { pid: 1, token: 't' } });
  if (status === 'running') return id;
  transitionJob(fx.db, id, 'running', status, {
    ...NOW,
    error: status === 'failed' ? ERR : undefined,
  });
  return id;
}

describe('contract alignment', () => {
  it('runtime enums match the job-record contract', () => {
    expect([...JOB_STATUS_VALUES]).toEqual([...JOB_STATUSES]);
    expect([...JOB_STAGE_VALUES]).toEqual([...JOB_STAGES]);
    expect([...JOB_INPUT_KIND_VALUES]).toEqual([...JOB_INPUT_KINDS]);
  });

  it.each(JOB_STATUS_VALUES)('a %s row projects to a valid job record', (status) => {
    const id = jobIn(status);
    const record = toJobRecord(getJobImpl(fx.db, id));
    const result = validateJobRecord(record);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(record.status).toBe(status);
  });
});

function getJobImpl(db: Fixture['db'], jobId: string): Job {
  const job = getJob(db, jobId);
  if (job === undefined) throw new Error('missing job');
  return job;
}

describe('state machine', () => {
  const all = JOB_STATUS_VALUES;
  const allowed = new Set([
    'pending->running',
    'pending->cancelled',
    'running->succeeded',
    'running->failed',
    'running->cancelled',
  ]);

  it.each(all.flatMap((from) => all.map((to) => [from, to] as const)))(
    '%s -> %s follows the transition table',
    (from, to) => {
      expect(canTransition(from, to)).toBe(allowed.has(`${from}->${to}`));
    },
  );

  it('terminal states have no way out', () => {
    expect(JOB_TRANSITIONS.succeeded).toEqual([]);
    expect(JOB_TRANSITIONS.failed).toEqual([]);
    expect(JOB_TRANSITIONS.cancelled).toEqual([]);
  });

  it.each(all.flatMap((from) => all.map((to) => [from, to] as const)))(
    'the store enforces %s -> %s',
    (from, to) => {
      const id = jobIn(from);
      const patch = {
        ...NOW,
        owner: { pid: 2, token: 'u' },
        error: to === 'failed' ? ERR : undefined,
      };
      if (allowed.has(`${from}->${to}`)) {
        const job = transitionJob(fx.db, id, from, to, patch);
        expect(job.status).toBe(to);
        if (to === 'running') expect(job.startedAt).toBe(NOW.now.toISOString());
        if (to !== 'running') expect(job.finishedAt).toBe(NOW.now.toISOString());
      } else {
        expect(() => transitionJob(fx.db, id, from, to, patch)).toThrow(JobError);
        expect(getJobImpl(fx.db, id).status).toBe(from);
      }
    },
  );

  it('is compare-and-set: a stale `from` is refused', () => {
    const id = jobIn('running');
    transitionJob(fx.db, id, 'running', 'cancelled', NOW);
    expect(() => transitionJob(fx.db, id, 'running', 'succeeded', NOW)).toThrow(/is cancelled/);
  });

  it('a failed job needs an error', () => {
    const id = jobIn('running');
    expect(() => transitionJob(fx.db, id, 'running', 'failed', NOW)).toThrow(JobError);
  });

  it('SQLite CHECK constraints back the contract rules even for raw SQL', () => {
    const id = jobIn('running');
    expect(() =>
      fx.db.prepare("UPDATE jobs SET status = 'failed' WHERE job_id = ?").run(id),
    ).toThrow(/CHECK constraint/);
    expect(() =>
      fx.db.prepare("UPDATE jobs SET status = 'paused' WHERE job_id = ?").run(id),
    ).toThrow(/CHECK constraint/);
    expect(() =>
      fx.db
        .prepare('UPDATE jobs SET input_tokens = 1.5, output_tokens = 1 WHERE job_id = ?')
        .run(id),
    ).toThrow();
  });

  it('bounds attempts by max_attempts', () => {
    const id = newJob(2);
    transitionJob(fx.db, id, 'pending', 'running', { ...NOW, owner: { pid: 1, token: 't' } });
    expect(nextAttempt(fx.db, id)).toBe(2);
    expect(() => nextAttempt(fx.db, id)).toThrow(JobError);
  });

  it('rejects malformed inputs', () => {
    const base = {
      campaignId: 'synthetic-vaults',
      sessionId: 's01',
      stage: 'transcribe' as const,
      maxAttempts: 1,
      now: new Date(),
    };
    expect(() =>
      createJob(fx.db, {
        ...base,
        jobId: ids(),
        inputs: [{ kind: 'config', ref: 'x', hash: 'md5:1' }],
      }),
    ).toThrow(/sha256/);
    expect(() =>
      createJob(fx.db, {
        ...base,
        jobId: ids(),
        inputs: [
          { kind: 'config', ref: 'x', hash: sha('1') },
          { kind: 'config', ref: 'x', hash: sha('2') },
        ],
      }),
    ).toThrow(/twice/);
    expect(() =>
      createJob(fx.db, {
        ...base,
        jobId: ids(),
        inputs: [{ kind: 'secret' as 'config', ref: 'x', hash: sha('1') }],
      }),
    ).toThrow(/unknown kind/);
  });

  it('StageError codes must be slugs', () => {
    expect(() => new StageError('Not A Slug', 'x')).toThrow(TypeError);
    expect(new StageError('provider-timeout', 'x').retryable).toBe(false);
  });
});

describe('ulid', () => {
  it('is a valid, monotonic ULID even within one millisecond', () => {
    const make = monotonicUlid();
    const list = Array.from({ length: 1000 }, () => make(1_700_000_000_000));
    for (const id of list) expect(id).toMatch(ULID_RE);
    expect([...list].sort()).toEqual(list);
    expect(new Set(list).size).toBe(list.length);
    expect(make(1_699_999_999_999) > (list.at(-1) ?? '')).toBe(true); // clock stepped back
  });
});

describe('migration 0002_jobs', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('applies on top of 0001 with a backup, and creates the job tables', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'recap-mig2-'));
    dirs.push(dir);
    const only1 = path.join(dir, 'm1');
    mkdirSync(only1);
    copyFileSync(
      path.join(DEFAULT_MIGRATIONS_DIR, '0001_init.sql'),
      path.join(only1, '0001_init.sql'),
    );

    const file = path.join(dir, 'state', 'recap.sqlite');
    const v1 = await openDatabase(file, { migrationsDir: only1 });
    expect(v1.schemaVersion).toBe(1);
    v1.db.close();

    const backupDir = path.join(dir, 'state', 'backups');
    const v2 = await openDatabase(file, { backupDir });
    expect(v2.previousVersion).toBe(1);
    expect(v2.applied).toEqual(
      loadMigrations()
        .slice(1)
        .map((m) => m.version),
    );
    expect(v2.applied[0]).toBe(2);
    expect(v2.backupFile).toBeDefined();
    expect(existsSync(v2.backupFile ?? '')).toBe(true);
    const tables = (
      v2.db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'job_inputs',
        'job_outputs',
        'jobs',
        'schema_migrations',
        'session_locks',
      ]),
    );
    v2.db.close();

    const backup = new Database(v2.backupFile ?? '', { readonly: true });
    try {
      const names = (
        backup.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as {
          name: string;
        }[]
      ).map((r) => r.name);
      expect(names).toEqual(['schema_migrations']);
    } finally {
      backup.close();
    }
  });

  it('puts the database under the data root state directory, not in the repository', () => {
    expect(fx.paths.dbFile).toBe(path.join(fx.paths.root, 'state', 'recap.sqlite'));
    expect(existsSync(fx.paths.dbFile)).toBe(true);
    expect(fx.paths.sessionLockFile('synthetic-vaults', 's01')).toBe(
      path.join(fx.paths.root, 'state', 'locks', 'synthetic-vaults', 's01.lock'),
    );
  });
});
