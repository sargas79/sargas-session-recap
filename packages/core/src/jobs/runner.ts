/**
 * Job runner (T07): runs a stage and everything upstream of it for one session, as jobs in SQLite.
 *
 * 1. Plan: the target and its upstream stages, upstream first.
 * 2. Lock the session (refuse a concurrent run; replace a dead or silent owner).
 * 3. Recover: jobs a dead owner left `running` become `failed` with code `interrupted`
 *    (retryable, i.e. recoverable); jobs it left `pending` become `cancelled`.
 * 4. For each stage: compute its dependency inputs (declared inputs + upstream output hashes).
 *    If the latest succeeded job of that stage has exactly the same inputs, it is up to date and
 *    skipped. Otherwise a new job runs: pending -> running -> succeeded | failed | cancelled, with
 *    bounded retry and backoff for retryable errors. The first stage whose inputs changed reruns,
 *    and a downstream stage reruns only if its own inputs (including upstream outputs) changed.
 * 5. Release the lock.
 */
import type { ConsentReceipt } from '../config/index.ts';
import { createLogger, type Logger } from '../log/index.ts';
import type { DataPaths } from '../paths/index.ts';
import { isJobError, isStageError, JobError } from './errors.ts';
import { acquireSessionLock, type LockHolder, type LockOptions } from './lock.ts';
import {
  backoffDelay,
  DEFAULT_RETRY,
  planStages,
  PROMPT_JOB_STAGES,
  requireConfig,
  type InputContext,
  type RecoveredFrom,
  type RetryPolicy,
  type RunConfig,
  type StageDefinition,
  type StageRegistry,
  type StageResult,
  type UpstreamResult,
} from './stage.ts';
import type { JobStage } from './state.ts';
import {
  addJobInputs,
  createJob,
  dedupeInputs,
  inputKey,
  latestJob,
  nextAttempt,
  orphanedJobs,
  transitionJob,
  validateInputs,
  validateResult,
  type Job,
  type JobFailure,
  type JobInput,
} from './store.ts';
import type { SqliteDatabase } from '../db/index.ts';
import { ulid } from '../ids/ulid.ts';

/** Error code recorded on a job whose owner died while it was running. */
export const INTERRUPTED_CODE = 'interrupted';

export interface RunOptions {
  readonly db: SqliteDatabase;
  readonly campaignId: string;
  readonly sessionId: string;
  /** Stage to bring up to date (with its upstream stages). */
  readonly stage: string;
  /** Run the target stage even when it is up to date. Upstream stages are unaffected. */
  readonly force?: boolean | undefined;
  readonly stages: StageRegistry;
  readonly paths?: DataPaths | undefined;
  readonly config?: RunConfig | undefined;
  /** Abort to cancel (Ctrl+C). The running job becomes `cancelled`. */
  readonly signal?: AbortSignal | undefined;
  /** Overrides the stage's own retry policy. */
  readonly retry?: Partial<RetryPolicy> | undefined;
  readonly lock?: LockOptions | undefined;
  readonly logger?: Logger | undefined;
  /** Test seams. */
  readonly now?: (() => Date) | undefined;
  readonly sleep?: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined;
}

export type StageAction = 'up-to-date' | 'succeeded' | 'failed' | 'cancelled';

export interface StageOutcome {
  readonly stage: JobStage;
  readonly action: StageAction;
  /** The job that ran, or for `up-to-date` the succeeded job that is still current. */
  readonly jobId: string | undefined;
  readonly attempts: number;
  /** Why the stage ran: `never-run`, `inputs-changed`, `recovering`, `previous-run-failed`. */
  readonly reason:
    'never-run' | 'inputs-changed' | 'recovering' | 'previous-not-succeeded' | 'current' | 'forced';
  /** Names (`kind:ref`) of dependency inputs that differ from the last succeeded job. */
  readonly changedInputs: readonly string[];
  /** For `up-to-date`: receipts that changed since that job ran, so it does not reflect them. */
  readonly staleReceipts?: readonly string[];
  readonly error: JobFailure | undefined;
}

export interface RecoveredJob {
  readonly jobId: string;
  readonly stage: JobStage;
  readonly from: 'running' | 'pending';
  readonly to: 'failed' | 'cancelled';
}

export interface RunReport {
  readonly status: 'succeeded' | 'failed' | 'cancelled';
  readonly stages: readonly StageOutcome[];
  readonly recovered: readonly RecoveredJob[];
  /** The previous lock holder this run replaced because it was dead or silent. */
  readonly replacedLock: LockHolder | undefined;
}

/** Sleeps `ms`, resolving early (without error) when `signal` aborts. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Compares dependency inputs; returns the names that were added, removed or changed. */
export function diffInputs(previous: readonly JobInput[], current: readonly JobInput[]): string[] {
  const before = new Map(previous.map((i) => [inputKey(i), i.hash]));
  const after = new Map(current.map((i) => [inputKey(i), i.hash]));
  const changed = new Set<string>();
  for (const [key, hash] of after) if (before.get(key) !== hash) changed.add(key);
  for (const key of before.keys()) if (!after.has(key)) changed.add(key);
  return [...changed].sort();
}

function toUpstream(job: Job): UpstreamResult {
  return {
    jobId: job.jobId,
    outputs: job.outputs,
    outputRunId: job.outputRunId,
    outputRecapRevision: job.outputRecapRevision,
  };
}

function slugify(code: string): string {
  return code.toLowerCase().replace(/_/g, '-');
}

/** Maps anything a stage threw to a recorded failure. Unknown errors never leak their message. */
export function failureOf(error: unknown, stage: string): JobFailure {
  if (isStageError(error)) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  if (isJobError(error)) {
    return { code: slugify(error.code), message: error.message, retryable: false };
  }
  if (error instanceof Error && error.name === 'ConsentError' && 'code' in error) {
    // ConsentError messages carry only stage, provider, speaker IDs and the fix.
    return { code: slugify(String(error.code)), message: error.message, retryable: false };
  }
  const name = error instanceof Error ? error.name : typeof error;
  return {
    code: 'stage-error',
    message: `stage ${stage} failed with an unexpected ${name}; the error text is not recorded because it may contain session content`,
    retryable: false,
  };
}

function resolveRetry(
  stage: StageDefinition,
  override: Partial<RetryPolicy> | undefined,
): RetryPolicy {
  const policy = { ...DEFAULT_RETRY, ...stage.retry, ...override };
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1 || policy.maxAttempts > 100) {
    throw new JobError('JOB_INVALID_INPUT', 'max attempts must be an integer from 1 to 100');
  }
  return policy;
}

/**
 * Brings `options.stage` up to date for one session. Throws `JOB_SESSION_LOCKED` (nothing
 * changed) when another live process holds the session, and stage-graph or config errors before
 * any job is created. Stage failures and cancellation are reported, not thrown.
 */
export async function runStage(options: RunOptions): Promise<RunReport> {
  const { db, campaignId, sessionId } = options;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? abortableSleep;
  const logger = (options.logger ?? createLogger()).child([]);
  const plan = planStages(options.stages, options.stage);
  const sessionDir = options.paths?.sessionDir(campaignId, sessionId);
  if (options.config !== undefined && options.config.campaign.campaign_id !== campaignId) {
    throw new JobError(
      'JOB_CONFIG_REQUIRED',
      `--config is for campaign ${options.config.campaign.campaign_id}, not ${campaignId}`,
    );
  }

  const lock = acquireSessionLock(db, campaignId, sessionId, {
    lockFile: options.paths?.sessionLockFile(campaignId, sessionId),
    ...options.lock,
  });

  const controller = new AbortController();
  // Read through functions: TypeScript cannot see the callbacks that change these.
  const lockState = { lost: false };
  const lockLost = (): boolean => lockState.lost;
  const forward = (): void => {
    controller.abort();
  };
  options.signal?.addEventListener('abort', forward, { once: true });
  if (options.signal?.aborted === true) controller.abort();
  lock.startHeartbeat(() => {
    lockState.lost = true;
    controller.abort();
  });
  const signal = controller.signal;

  try {
    const recovered = recover(db, campaignId, sessionId, lock.token, now());
    for (const r of recovered) {
      logger.warn('job.recovered', {
        campaignId,
        sessionId,
        jobId: r.jobId,
        stage: r.stage,
        status: r.to,
      });
    }

    const outcomes: StageOutcome[] = [];
    const upstream = new Map<JobStage, UpstreamResult>();
    let status: RunReport['status'] = 'succeeded';

    for (const stage of plan) {
      if (signal.aborted) {
        status = 'cancelled';
        break;
      }
      const ctx: InputContext = {
        campaignId,
        sessionId,
        paths: options.paths,
        sessionDir,
        config: options.config,
        upstream: new Map(
          (stage.upstream ?? []).flatMap((name) => {
            const result = upstream.get(name);
            return result === undefined ? [] : [[name, result] as const];
          }),
        ),
      };
      const inputs = await stageInputs(stage, ctx);
      const receipts = dedupeInputs((await stage.receipts?.(ctx)) ?? []);
      validateInputs(receipts, stage.name);
      const forced = options.force === true && stage.name === options.stage;
      const current = latestJob(db, campaignId, sessionId, stage.name, 'succeeded');
      const previous = latestJob(db, campaignId, sessionId, stage.name);
      const changed =
        current === undefined
          ? []
          : diffInputs(
              current.inputs.filter((i) => i.role === 'dependency'),
              inputs,
            );
      if (current !== undefined && changed.length === 0 && !forced) {
        upstream.set(stage.name, toUpstream(current));
        const declared = new Set(receipts.map(inputKey));
        const stale = diffInputs(
          current.inputs.filter((i) => i.role === 'receipt' && declared.has(inputKey(i))),
          receipts,
        );
        outcomes.push({
          stage: stage.name,
          action: 'up-to-date',
          jobId: current.jobId,
          attempts: 0,
          reason: 'current',
          changedInputs: [],
          ...(stale.length === 0 ? {} : { staleReceipts: stale }),
          error: undefined,
        });
        logger.info('job.up-to-date', {
          campaignId,
          sessionId,
          jobId: current.jobId,
          stage: stage.name,
        });
        continue;
      }
      const recoveredFrom: RecoveredFrom | undefined =
        previous?.status === 'failed' && previous.error?.code === INTERRUPTED_CODE
          ? { jobId: previous.jobId, attempt: previous.attempt }
          : undefined;
      const reason: StageOutcome['reason'] =
        recoveredFrom !== undefined
          ? 'recovering'
          : current === undefined
            ? previous === undefined
              ? 'never-run'
              : 'previous-not-succeeded'
            : changed.length === 0
              ? 'forced'
              : 'inputs-changed';

      const outcome = await executeJob({
        options,
        stage,
        ctx,
        inputs,
        receipts,
        recoveredFrom,
        reason,
        changed,
        lockToken: lock.token,
        lockPid: lock.pid,
        signal,
        now,
        sleep,
        logger,
      });
      outcomes.push(outcome);
      if (outcome.action === 'succeeded' && outcome.jobId !== undefined) {
        const job = latestJob(db, campaignId, sessionId, stage.name, 'succeeded');
        if (job !== undefined) upstream.set(stage.name, toUpstream(job));
        continue;
      }
      status = outcome.action === 'cancelled' && !lockLost() ? 'cancelled' : 'failed';
      break;
    }
    if (lockLost()) {
      throw new JobError(
        'JOB_LOCK_LOST',
        `lost the lock on session ${campaignId}/${sessionId}: another run took it over after this process stopped sending heartbeats`,
        { hint: 'run `recap status` to see the state, then `recap run` again' },
      );
    }
    return { status, stages: outcomes, recovered, replacedLock: lock.replaced };
  } finally {
    options.signal?.removeEventListener('abort', forward);
    lock.release();
  }
}

async function stageInputs(stage: StageDefinition, ctx: InputContext): Promise<JobInput[]> {
  const declared = [...((await stage.inputs?.(ctx)) ?? [])];
  const fromUpstream: JobInput[] = [];
  for (const name of stage.upstream ?? []) {
    const up = ctx.upstream.get(name);
    if (up === undefined) continue;
    for (const output of up.outputs) {
      fromUpstream.push({ kind: 'artifact', ref: output.path, hash: output.hash });
    }
  }
  const all = [...declared, ...fromUpstream];
  validateInputs(all, stage.name);
  if (PROMPT_JOB_STAGES.includes(stage.name) && !all.some((i) => i.kind === 'prompt')) {
    throw new JobError(
      'JOB_INVALID_INPUT',
      `stage ${stage.name} declared no prompt input; record the prompt it uses with promptJobInput()`,
    );
  }
  return dedupeInputs(all);
}

/** Marks jobs a dead owner left behind. Safe only while holding the session lock. */
function recover(
  db: SqliteDatabase,
  campaignId: string,
  sessionId: string,
  token: string,
  at: Date,
): RecoveredJob[] {
  const recovered: RecoveredJob[] = [];
  for (const job of orphanedJobs(db, campaignId, sessionId, token)) {
    if (job.status === 'running') {
      transitionJob(db, job.jobId, 'running', 'failed', {
        now: at,
        error: {
          code: INTERRUPTED_CODE,
          message: `stage ${job.stage} was interrupted: its process (pid ${String(job.ownerPid ?? 'unknown')}) stopped or its heartbeat went stale; the next recap run re-runs it`,
          retryable: true,
        },
      });
      recovered.push({ jobId: job.jobId, stage: job.stage, from: 'running', to: 'failed' });
    } else {
      transitionJob(db, job.jobId, 'pending', 'cancelled', { now: at });
      recovered.push({ jobId: job.jobId, stage: job.stage, from: 'pending', to: 'cancelled' });
    }
  }
  return recovered;
}

interface ExecuteArgs {
  readonly options: RunOptions;
  readonly stage: StageDefinition;
  readonly ctx: InputContext;
  readonly inputs: readonly JobInput[];
  readonly receipts: readonly JobInput[];
  readonly recoveredFrom: RecoveredFrom | undefined;
  readonly reason: StageOutcome['reason'];
  readonly changed: readonly string[];
  readonly lockToken: string;
  readonly lockPid: number;
  readonly signal: AbortSignal;
  readonly now: () => Date;
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly logger: Logger;
}

async function executeJob(args: ExecuteArgs): Promise<StageOutcome> {
  const { options, stage, ctx, inputs, signal, now, logger } = args;
  const { db, campaignId, sessionId } = options;
  const aborted = (): boolean => signal.aborted;
  const policy = resolveRetry(stage, options.retry);
  const jobId = ulid(now().getTime());
  createJob(db, {
    jobId,
    campaignId,
    sessionId,
    stage: stage.name,
    maxAttempts: policy.maxAttempts,
    inputs,
    recoveredFromJobId: args.recoveredFrom?.jobId,
    now: now(),
  });
  addJobInputs(db, jobId, args.receipts, 'receipt');
  const base = {
    stage: stage.name,
    jobId,
    reason: args.reason,
    changedInputs: args.changed,
  };
  if (aborted()) {
    transitionJob(db, jobId, 'pending', 'cancelled', { now: now() });
    return { ...base, action: 'cancelled', attempts: 0, error: undefined };
  }
  transitionJob(db, jobId, 'pending', 'running', {
    now: now(),
    owner: { pid: args.lockPid, token: args.lockToken },
  });
  const started = Date.now();
  logger.info('job.started', { campaignId, sessionId, jobId, stage: stage.name, attempt: 1 });

  const finish = (
    to: 'failed' | 'cancelled',
    error: JobFailure | undefined,
    attempts: number,
  ): StageOutcome => {
    try {
      transitionJob(db, jobId, 'running', to, { now: now(), error });
    } catch (transitionError) {
      // The job was taken over (lock lost and recovered elsewhere); report, do not mask.
      if (!isJobError(transitionError)) throw transitionError;
    }
    const fields = {
      campaignId,
      sessionId,
      jobId,
      stage: stage.name,
      status: to,
      attempt: attempts,
      durationMs: Date.now() - started,
    };
    if (to === 'failed') logger.error('job.failed', { ...fields, errorCode: error?.code ?? null });
    else logger.warn('job.cancelled', fields);
    return { ...base, action: to, attempts, error };
  };

  // Consent before any provider call (AGENTS.md section 4); the receipt is recorded on the job.
  let consent: ConsentReceipt | undefined;
  if (stage.provider !== undefined) {
    try {
      const config = requireConfig(ctx, stage.name);
      const speakerIds = await stage.provider.speakerIds(ctx);
      const { assertConsent } = await import('../config/consent.ts');
      const purpose = stage.provider.purpose;
      consent = assertConsent({
        campaign: config.campaign,
        speakerIds,
        provider: config.campaign.provider[purpose],
        stage: purpose,
        now: now(),
      });
      addJobInputs(
        db,
        jobId,
        [
          {
            kind: 'config',
            ref: `consent:${consent.stage}:${consent.provider}:${consent.mode}`,
            hash: consent.policy_hash,
          },
        ],
        'receipt',
      );
    } catch (error) {
      return finish('failed', failureOf(error, stage.name), 1);
    }
  }

  let attempt = 1;
  for (;;) {
    if (aborted()) return finish('cancelled', undefined, attempt);
    let result: StageResult | undefined;
    try {
      result = await stage.run({
        ...ctx,
        jobId,
        attempt,
        maxAttempts: policy.maxAttempts,
        signal,
        inputs,
        recoveredFrom: args.recoveredFrom,
        consent,
        logger,
      });
      validateResult(stage.name, result ?? {});
    } catch (error) {
      if (aborted()) return finish('cancelled', undefined, attempt);
      const failure = failureOf(error, stage.name);
      if (!failure.retryable || attempt >= policy.maxAttempts) {
        return finish('failed', failure, attempt);
      }
      const delay = backoffDelay(policy, attempt);
      logger.warn('job.retry', {
        campaignId,
        sessionId,
        jobId,
        stage: stage.name,
        attempt,
        errorCode: failure.code,
        durationMs: delay,
      });
      await args.sleep(delay, signal);
      if (aborted()) return finish('cancelled', undefined, attempt);
      attempt = nextAttempt(db, jobId);
      continue;
    }
    try {
      transitionJob(db, jobId, 'running', 'succeeded', {
        now: now(),
        outputs: result?.outputs,
        usage: result?.usage,
        outputRunId: result?.outputRunId,
        outputRecapRevision: result?.outputRecapRevision,
      });
    } catch (error) {
      if (!isJobError(error)) throw error;
      return { ...base, action: 'failed', attempts: attempt, error: failureOf(error, stage.name) };
    }
    logger.info('job.succeeded', {
      campaignId,
      sessionId,
      jobId,
      stage: stage.name,
      attempt,
      durationMs: Date.now() - started,
    });
    return { ...base, action: 'succeeded', attempts: attempt, error: undefined };
  }
}
