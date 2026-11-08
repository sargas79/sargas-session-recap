/**
 * SQLite `jobs`, `job_inputs` and `job_outputs` (migration 0002). The only code that reads or
 * writes those tables. Every state change goes through {@link transitionJob}, which enforces the
 * state machine with a compare-and-set on `status`.
 */
import type { JobRecord } from '@sargas-recap/contracts';
import type { SqliteDatabase } from '../db/index.ts';
import { JobError } from './errors.ts';
import {
  assertTransition,
  JOB_INPUT_KIND_VALUES,
  type JobInputKind,
  type JobStage,
  type JobStatus,
} from './state.ts';
import { ULID_RE } from '../ids/ulid.ts';

const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const REL_PATH_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const MAX_MESSAGE = 500;

/** One input of a job: a named thing (`kind` + `ref`) and the hash of the version that was used. */
export interface JobInput {
  readonly kind: JobInputKind;
  /** Path, name or model ID (1-240 chars). `kind` + `ref` is the input's name. */
  readonly ref: string;
  /** `sha256:<64 hex>`. */
  readonly hash: string;
}

/** `dependency` inputs decide invalidation; `receipt` inputs are recorded for traceability only. */
export type InputRole = 'dependency' | 'receipt';

export interface StoredInput extends JobInput {
  readonly role: InputRole;
}

export interface JobOutput {
  /** Package-relative POSIX path. */
  readonly path: string;
  readonly hash: string;
}

/** Integer token counts and integer micro-USD (no floats). */
export interface JobUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cost_micro_usd?: number;
}

export interface JobFailure {
  /** Lowercase slug. */
  readonly code: string;
  /** Actionable, content-free, at most 500 chars. */
  readonly message: string;
  readonly retryable: boolean;
}

export interface Job {
  readonly jobId: string;
  readonly campaignId: string;
  readonly sessionId: string;
  readonly stage: JobStage;
  readonly status: JobStatus;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly inputs: readonly StoredInput[];
  readonly outputs: readonly JobOutput[];
  readonly outputRunId: string | undefined;
  readonly outputRecapRevision: number | undefined;
  readonly usage: JobUsage | undefined;
  readonly error: JobFailure | undefined;
  readonly recoveredFromJobId: string | undefined;
  readonly ownerPid: number | undefined;
  readonly ownerToken: string | undefined;
  /** Unix ms of the owner's last heartbeat while running. */
  readonly heartbeatAt: number | undefined;
  readonly createdAt: string;
  readonly startedAt: string | undefined;
  readonly finishedAt: string | undefined;
}

interface JobRow {
  job_id: string;
  campaign_id: string;
  session_id: string;
  stage: string;
  status: string;
  attempt: number;
  max_attempts: number;
  output_run_id: string | null;
  output_recap_revision: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_micro_usd: number | null;
  error_code: string | null;
  error_message: string | null;
  error_retryable: number | null;
  recovered_from_job_id: string | null;
  owner_pid: number | null;
  owner_token: string | null;
  heartbeat_at: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const opt = <T>(value: T | null): T | undefined => value ?? undefined;

export function inputKey(input: Pick<JobInput, 'kind' | 'ref'>): string {
  return `${input.kind}:${input.ref}`;
}

/** Throws `JOB_INVALID_INPUT` unless every input is well-formed and named once. */
export function validateInputs(inputs: readonly JobInput[], stage: string): void {
  const seen = new Map<string, string>();
  for (const input of inputs) {
    if (!(JOB_INPUT_KIND_VALUES as readonly string[]).includes(input.kind)) {
      throw new JobError(
        'JOB_INVALID_INPUT',
        `stage ${stage} declared an input of unknown kind ${JSON.stringify(input.kind)}`,
      );
    }
    if (typeof input.ref !== 'string' || input.ref.length < 1 || input.ref.length > 240) {
      throw new JobError(
        'JOB_INVALID_INPUT',
        `stage ${stage} declared a ${input.kind} input whose ref is not 1-240 characters`,
      );
    }
    if (!HASH_RE.test(input.hash)) {
      throw new JobError(
        'JOB_INVALID_INPUT',
        `stage ${stage} input ${inputKey(input)} has no sha256:<hex> hash`,
      );
    }
    const key = inputKey(input);
    const previous = seen.get(key);
    if (previous !== undefined && previous !== input.hash) {
      throw new JobError(
        'JOB_INVALID_INPUT',
        `stage ${stage} declared input ${key} twice with different hashes`,
      );
    }
    seen.set(key, input.hash);
  }
}

/** Removes exact duplicates (same name and hash), keeping the first occurrence. */
export function dedupeInputs(inputs: readonly JobInput[]): JobInput[] {
  const seen = new Set<string>();
  return inputs.filter((input) => {
    const key = inputKey(input);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_SAFE;
}

/** Throws `JOB_INVALID_OUTPUT` unless the stage result fits the job-record contract. */
export function validateResult(
  stage: string,
  result: {
    outputs?: readonly JobOutput[] | undefined;
    usage?: JobUsage | undefined;
    outputRunId?: string | undefined;
    outputRecapRevision?: number | undefined;
  },
): void {
  const fail = (what: string): never => {
    throw new JobError('JOB_INVALID_OUTPUT', `stage ${stage} returned ${what}`);
  };
  const paths = new Set<string>();
  for (const output of result.outputs ?? []) {
    if (
      typeof output.path !== 'string' ||
      output.path.length > 240 ||
      !REL_PATH_RE.test(output.path)
    ) {
      fail('an output path that is not a package-relative POSIX path');
    }
    if (!HASH_RE.test(output.hash)) fail(`output ${output.path} without a sha256:<hex> hash`);
    if (paths.has(output.path)) fail(`output ${output.path} twice`);
    paths.add(output.path);
  }
  const usage = result.usage;
  if (usage !== undefined) {
    if (!isCount(usage.input_tokens) || !isCount(usage.output_tokens)) {
      fail('token usage that is not a non-negative integer');
    }
    if (usage.cost_micro_usd !== undefined && !isCount(usage.cost_micro_usd)) {
      fail('a cost that is not a non-negative integer of micro-USD');
    }
  }
  if (result.outputRunId !== undefined && !ULID_RE.test(result.outputRunId)) {
    fail('an output run ID that is not a ULID');
  }
  if (
    result.outputRecapRevision !== undefined &&
    (!Number.isInteger(result.outputRecapRevision) || result.outputRecapRevision < 1)
  ) {
    fail('a recap revision that is not a positive integer');
  }
}

/** Clips a failure message to the contract limit; never empty. */
export function clipMessage(message: string): string {
  const flat = message.replace(/\s+/g, ' ').trim();
  if (flat === '') return 'the stage failed without a message';
  return flat.length > MAX_MESSAGE ? `${flat.slice(0, MAX_MESSAGE - 3)}...` : flat;
}

function readInputs(db: SqliteDatabase, jobId: string): StoredInput[] {
  return db
    .prepare('SELECT kind, ref, hash, role FROM job_inputs WHERE job_id = ? ORDER BY kind, ref')
    .all(jobId) as StoredInput[];
}

function readOutputs(db: SqliteDatabase, jobId: string): JobOutput[] {
  return db
    .prepare('SELECT path, hash FROM job_outputs WHERE job_id = ? ORDER BY path')
    .all(jobId) as JobOutput[];
}

function toJob(db: SqliteDatabase, row: JobRow): Job {
  return {
    jobId: row.job_id,
    campaignId: row.campaign_id,
    sessionId: row.session_id,
    stage: row.stage as JobStage,
    status: row.status as JobStatus,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    inputs: readInputs(db, row.job_id),
    outputs: readOutputs(db, row.job_id),
    outputRunId: opt(row.output_run_id),
    outputRecapRevision: opt(row.output_recap_revision),
    usage:
      row.input_tokens === null || row.output_tokens === null
        ? undefined
        : {
            input_tokens: row.input_tokens,
            output_tokens: row.output_tokens,
            ...(row.cost_micro_usd === null ? {} : { cost_micro_usd: row.cost_micro_usd }),
          },
    error:
      row.error_code === null || row.error_message === null
        ? undefined
        : {
            code: row.error_code,
            message: row.error_message,
            retryable: row.error_retryable === 1,
          },
    recoveredFromJobId: opt(row.recovered_from_job_id),
    ownerPid: opt(row.owner_pid),
    ownerToken: opt(row.owner_token),
    heartbeatAt: opt(row.heartbeat_at),
    createdAt: row.created_at,
    startedAt: opt(row.started_at),
    finishedAt: opt(row.finished_at),
  };
}

export interface CreateJobInput {
  readonly jobId: string;
  readonly campaignId: string;
  readonly sessionId: string;
  readonly stage: JobStage;
  readonly maxAttempts: number;
  readonly inputs: readonly JobInput[];
  readonly recoveredFromJobId?: string | undefined;
  readonly now: Date;
}

/** Inserts a `pending` job with its dependency inputs (one transaction). */
export function createJob(db: SqliteDatabase, input: CreateJobInput): Job {
  validateInputs(input.inputs, input.stage);
  db.transaction(() => {
    db.prepare(
      `INSERT INTO jobs (job_id, campaign_id, session_id, stage, status, attempt, max_attempts,
         recovered_from_job_id, created_at)
       VALUES (?, ?, ?, ?, 'pending', 1, ?, ?, ?)`,
    ).run(
      input.jobId,
      input.campaignId,
      input.sessionId,
      input.stage,
      input.maxAttempts,
      input.recoveredFromJobId ?? null,
      input.now.toISOString(),
    );
    insertInputs(db, input.jobId, dedupeInputs(input.inputs), 'dependency');
  })();
  return getJobOrThrow(db, input.jobId);
}

function insertInputs(
  db: SqliteDatabase,
  jobId: string,
  inputs: readonly JobInput[],
  role: InputRole,
): void {
  const insert = db.prepare(
    'INSERT INTO job_inputs (job_id, kind, ref, hash, role) VALUES (?, ?, ?, ?, ?)',
  );
  for (const i of inputs) insert.run(jobId, i.kind, i.ref, i.hash, role);
}

/** Records more inputs on a job, e.g. the consent receipt (`role: 'receipt'`). */
export function addJobInputs(
  db: SqliteDatabase,
  jobId: string,
  inputs: readonly JobInput[],
  role: InputRole,
): void {
  const job = getJobOrThrow(db, jobId);
  validateInputs([...job.inputs, ...inputs], job.stage);
  db.transaction(() => {
    insertInputs(db, jobId, inputs, role);
  })();
}

export function getJob(db: SqliteDatabase, jobId: string): Job | undefined {
  const row = db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId) as JobRow | undefined;
  return row === undefined ? undefined : toJob(db, row);
}

function getJobOrThrow(db: SqliteDatabase, jobId: string): Job {
  const job = getJob(db, jobId);
  if (job === undefined) throw new JobError('JOB_INVALID_TRANSITION', `job ${jobId} not found`);
  return job;
}

export interface TransitionPatch {
  readonly now: Date;
  /** pending -> running: the owner. */
  readonly owner?: { readonly pid: number; readonly token: string } | undefined;
  readonly outputs?: readonly JobOutput[] | undefined;
  readonly usage?: JobUsage | undefined;
  readonly outputRunId?: string | undefined;
  readonly outputRecapRevision?: number | undefined;
  readonly error?: JobFailure | undefined;
}

/**
 * Moves a job from `from` to `to` (compare-and-set: fails if another writer changed it first).
 * Sets `started_at` on running and `finished_at` on every terminal state; records outputs, usage
 * and the error with the transition, in one transaction.
 */
export function transitionJob(
  db: SqliteDatabase,
  jobId: string,
  from: JobStatus,
  to: JobStatus,
  patch: TransitionPatch,
): Job {
  assertTransition(from, to);
  const at = patch.now.toISOString();
  if (to === 'succeeded') validateResult('job', patch);
  const error = patch.error;
  if (to === 'failed' && error === undefined) {
    throw new JobError('JOB_INVALID_TRANSITION', 'a failed job needs an error code and message');
  }
  db.transaction(() => {
    const changes = db
      .prepare(
        `UPDATE jobs SET
           status = @to,
           started_at = CASE WHEN @to = 'running' THEN @at ELSE started_at END,
           finished_at = CASE WHEN @to IN ('succeeded', 'failed', 'cancelled') THEN @at ELSE finished_at END,
           owner_pid = CASE WHEN @to = 'running' THEN @pid ELSE owner_pid END,
           owner_token = CASE WHEN @to = 'running' THEN @token ELSE owner_token END,
           heartbeat_at = CASE WHEN @to = 'running' THEN @nowMs ELSE heartbeat_at END,
           output_run_id = coalesce(@runId, output_run_id),
           output_recap_revision = coalesce(@revision, output_recap_revision),
           input_tokens = coalesce(@inTok, input_tokens),
           output_tokens = coalesce(@outTok, output_tokens),
           cost_micro_usd = coalesce(@cost, cost_micro_usd),
           error_code = @errCode,
           error_message = @errMessage,
           error_retryable = @errRetryable
         WHERE job_id = @jobId AND status = @from`,
      )
      .run({
        jobId,
        from,
        to,
        at,
        nowMs: patch.now.getTime(),
        pid: patch.owner?.pid ?? null,
        token: patch.owner?.token ?? null,
        runId: patch.outputRunId ?? null,
        revision: patch.outputRecapRevision ?? null,
        inTok: patch.usage?.input_tokens ?? null,
        outTok: patch.usage?.output_tokens ?? null,
        cost: patch.usage?.cost_micro_usd ?? null,
        errCode: to === 'succeeded' ? null : (error?.code ?? null),
        errMessage:
          to === 'succeeded' ? null : error === undefined ? null : clipMessage(error.message),
        errRetryable: to === 'succeeded' || error === undefined ? null : error.retryable ? 1 : 0,
      }).changes;
    if (changes !== 1) {
      const current = getJob(db, jobId);
      throw new JobError(
        'JOB_INVALID_TRANSITION',
        current === undefined
          ? `job ${jobId} not found`
          : `job ${jobId} is ${current.status}, not ${from}; it cannot become ${to}`,
      );
    }
    if (to === 'succeeded' && patch.outputs !== undefined) {
      const insert = db.prepare('INSERT INTO job_outputs (job_id, path, hash) VALUES (?, ?, ?)');
      for (const o of patch.outputs) insert.run(jobId, o.path, o.hash);
    }
  })();
  return getJobOrThrow(db, jobId);
}

/** Starts the next attempt of a running job (bounded by `max_attempts`). */
export function nextAttempt(db: SqliteDatabase, jobId: string): number {
  const changes = db
    .prepare(
      `UPDATE jobs SET attempt = attempt + 1
       WHERE job_id = ? AND status = 'running' AND attempt < max_attempts`,
    )
    .run(jobId).changes;
  if (changes !== 1) {
    throw new JobError(
      'JOB_INVALID_TRANSITION',
      `job ${jobId} has no attempt left or is not running`,
    );
  }
  return getJobOrThrow(db, jobId).attempt;
}

/** Refreshes the heartbeat of every running job owned by `token`. */
export function heartbeatJobs(db: SqliteDatabase, token: string, nowMs: number): number {
  return db
    .prepare("UPDATE jobs SET heartbeat_at = ? WHERE owner_token = ? AND status = 'running'")
    .run(nowMs, token).changes;
}

const ORDER = 'ORDER BY created_at, job_id';

/** All jobs of a session, oldest first. */
export function listJobs(db: SqliteDatabase, campaignId: string, sessionId: string): Job[] {
  const rows = db
    .prepare(`SELECT * FROM jobs WHERE campaign_id = ? AND session_id = ? ${ORDER}`)
    .all(campaignId, sessionId) as JobRow[];
  return rows.map((row) => toJob(db, row));
}

/** The most recent job of each stage of a session, in order of first appearance. */
export function latestJobPerStage(
  db: SqliteDatabase,
  campaignId: string,
  sessionId: string,
): Job[] {
  const latest = new Map<string, Job>();
  for (const job of listJobs(db, campaignId, sessionId)) latest.set(job.stage, job);
  return [...latest.values()];
}

/** The most recent job of one stage, optionally only with a given status. */
export function latestJob(
  db: SqliteDatabase,
  campaignId: string,
  sessionId: string,
  stage: JobStage,
  status?: JobStatus,
): Job | undefined {
  const row = db
    .prepare(
      `SELECT * FROM jobs WHERE campaign_id = ? AND session_id = ? AND stage = ?
         AND (? IS NULL OR status = ?)
       ORDER BY created_at DESC, job_id DESC LIMIT 1`,
    )
    .get(campaignId, sessionId, stage, status ?? null, status ?? null) as JobRow | undefined;
  return row === undefined ? undefined : toJob(db, row);
}

/** Jobs of a session left `pending` or `running` by an owner other than `token`. */
export function orphanedJobs(
  db: SqliteDatabase,
  campaignId: string,
  sessionId: string,
  token: string,
): Job[] {
  const rows = db
    .prepare(
      `SELECT * FROM jobs WHERE campaign_id = ? AND session_id = ?
         AND status IN ('pending', 'running') AND (owner_token IS NULL OR owner_token <> ?)
       ${ORDER}`,
    )
    .all(campaignId, sessionId, token) as JobRow[];
  return rows.map((row) => toJob(db, row));
}

/**
 * The job as a `job-record` contract object (ADR-001: the contract is the row's shape). Receipt
 * inputs are included: the contract has no role field, the receipt is part of what the job used.
 */
export function toJobRecord(job: Job): JobRecord {
  return {
    schema_version: 1,
    job_id: job.jobId,
    campaign_id: job.campaignId,
    session_id: job.sessionId,
    stage: job.stage,
    status: job.status,
    attempt: job.attempt,
    max_attempts: job.maxAttempts,
    inputs: job.inputs.map(({ kind, ref, hash }) => ({ kind, ref, hash })),
    ...(job.outputRunId === undefined ? {} : { output_run_id: job.outputRunId }),
    ...(job.outputRecapRevision === undefined
      ? {}
      : { output_recap_revision: job.outputRecapRevision }),
    outputs: job.outputs.map(({ path, hash }) => ({ path, hash })),
    ...(job.usage === undefined ? {} : { usage: { ...job.usage } }),
    ...(job.error === undefined ? {} : { error: { ...job.error } }),
    created_at: job.createdAt,
    ...(job.startedAt === undefined ? {} : { started_at: job.startedAt }),
    ...(job.finishedAt === undefined ? {} : { finished_at: job.finishedAt }),
  };
}
