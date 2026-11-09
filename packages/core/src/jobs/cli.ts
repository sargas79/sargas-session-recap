/**
 * `recap run <stage>` and `recap status` (T07). Modules are loaded inside each action so
 * `recap --help` stays fast.
 */
import type { Command } from 'commander';
import type { Logger } from '../log/index.ts';
import type { RunConfig, StageRegistry } from './stage.ts';
import type { Job } from './store.ts';
import type { RunReport, StageOutcome } from './runner.ts';

export interface JobCliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

export interface JobCliDeps {
  /** Registered stages. Empty until real stages land (T08+). */
  readonly stages?: StageRegistry | undefined;
  readonly logger?: Logger | undefined;
  /**
   * Installs the Ctrl+C handler: calls `abort` on interrupt and returns an uninstall function.
   * Defaults to a one-shot SIGINT listener (a second Ctrl+C terminates as usual).
   */
  readonly onInterrupt?: ((abort: () => void) => () => void) | undefined;
}

interface CommonOptions {
  campaign: string;
  session: string;
  dataRoot?: string;
  allowInRepo?: boolean;
}

interface RunCliOptions extends CommonOptions {
  config?: string;
  glossary?: string;
  maxAttempts?: string;
}

interface StatusCliOptions extends CommonOptions {
  json?: boolean;
  all?: boolean;
}

const EMPTY_REGISTRY: StageRegistry = new Map();

function sigintHandler(abort: () => void): () => void {
  const handler = (): void => {
    abort();
  };
  process.once('SIGINT', handler);
  return () => {
    process.off('SIGINT', handler);
  };
}

function addCommonOptions(command: Command): Command {
  return command
    .requiredOption('--campaign <id>', 'campaign id (slug)')
    .requiredOption('--session <id>', 'session id (slug)')
    .option('--data-root <dir>', 'data root (default: RECAP_DATA_ROOT, then the per-user dir)')
    .option('--allow-in-repo', 'accept a data root inside a git working tree');
}

function describeOutcome(o: StageOutcome): string {
  const job = o.jobId === undefined ? '' : ` (job ${o.jobId})`;
  switch (o.action) {
    case 'up-to-date': {
      if (o.reason === 'source-purged')
        return `${o.stage}: kept as it is${job}; the audio is purged`;
      const stale = o.staleReceipts ?? [];
      if (stale.length === 0) return `${o.stage}: up to date${job}`;
      return (
        `${o.stage}: up to date${job}; it does not reflect later changes to ${stale.join(', ')}` +
        (o.stage === 'transcribe' ? '; run `recap retranscribe` to apply them' : '')
      );
    }
    case 'succeeded': {
      const why =
        o.reason === 'inputs-changed'
          ? `; inputs changed: ${o.changedInputs.join(', ')}`
          : o.reason === 'recovering'
            ? '; re-ran an interrupted job'
            : '';
      return `${o.stage}: succeeded${job}, attempt ${String(o.attempts)}${why}`;
    }
    case 'failed':
      return `${o.stage}: failed${job} after ${String(o.attempts)} attempt(s): ${o.error?.code ?? 'error'}: ${o.error?.message ?? ''}`;
    case 'cancelled':
      return `${o.stage}: cancelled${job}`;
  }
}

export function printReport(io: JobCliIo, report: RunReport): void {
  if (report.replacedLock !== undefined) {
    io.out(
      `took over the session lock from pid ${String(report.replacedLock.ownerPid)} (no longer running)\n`,
    );
  }
  for (const r of report.recovered) {
    io.out(
      r.to === 'failed'
        ? `recovered: ${r.stage} job ${r.jobId} was interrupted; marked failed (recoverable)\n`
        : `recovered: ${r.stage} job ${r.jobId} never started; marked cancelled\n`,
    );
  }
  for (const o of report.stages) io.out(`  ${describeOutcome(o)}\n`);
  io.out(`result: ${report.status}\n`);
}

function describeJob(job: Job, ownerGone: boolean): string {
  const parts = [`${job.stage}: ${job.status}`, `job ${job.jobId}`];
  parts.push(`attempt ${String(job.attempt)}/${String(job.maxAttempts)}`);
  if (job.startedAt !== undefined) parts.push(`started ${job.startedAt}`);
  if (job.finishedAt !== undefined) parts.push(`finished ${job.finishedAt}`);
  if (job.usage !== undefined) {
    parts.push(`tokens ${String(job.usage.input_tokens)}/${String(job.usage.output_tokens)}`);
  }
  let line = parts.join(', ');
  if (job.error !== undefined) {
    line += `\n      ${job.error.code}${job.error.retryable ? ' (recoverable)' : ''}: ${job.error.message}`;
  }
  if (job.status === 'running' && ownerGone) {
    line +=
      '\n      owner process is gone; the next `recap run` marks it interrupted and re-runs it';
  }
  return line;
}

export async function reportError(io: JobCliIo, error: unknown): Promise<void> {
  const { isJobError } = await import('./errors.ts');
  const { PathsError } = await import('../paths/index.ts');
  const { DbError } = await import('../db/index.ts');
  if (isJobError(error) || error instanceof DbError) {
    io.err(`recap: ${error.message}\n`);
    if (error.hint !== undefined) io.err(`  fix: ${error.hint}\n`);
    process.exitCode = 1;
    return;
  }
  if (error instanceof PathsError) {
    io.err(`recap: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  if (error instanceof Error && (error.name === 'ConfigError' || error.name === 'ConsentError')) {
    io.err(`recap: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  throw error;
}

export function registerJobCommands(program: Command, io: JobCliIo, deps: JobCliDeps = {}): void {
  const stages = deps.stages ?? EMPTY_REGISTRY;
  const onInterrupt = deps.onInterrupt ?? sigintHandler;

  addCommonOptions(
    program
      .command('run')
      .description(
        'bring a stage (and the stages it depends on) up to date for one session; Ctrl+C cancels',
      )
      .argument('<stage>', 'stage to run'),
  )
    .option('--config <campaign.yaml>', 'campaign config (needed by config-dependent stages)')
    .option('--glossary <glossary.yaml>', 'glossary (required with --config)')
    .option('--max-attempts <n>', 'attempts per job for retryable errors (1-100)')
    .action(async (stage: string, options: RunCliOptions) => {
      try {
        const { assertSlug, openDataRoot } = await import('../paths/index.ts');
        const { openStateDatabase } = await import('../db/index.ts');
        const { runStage } = await import('./runner.ts');
        const { JobError } = await import('./errors.ts');
        assertSlug('campaign_id', options.campaign);
        assertSlug('session_id', options.session);
        let maxAttempts: number | undefined;
        if (options.maxAttempts !== undefined) {
          maxAttempts = Number(options.maxAttempts);
          if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
            io.err('recap: --max-attempts must be an integer from 1 to 100\n');
            process.exitCode = 2;
            return;
          }
        }
        let config: RunConfig | undefined;
        if (options.config !== undefined || options.glossary !== undefined) {
          if (options.config === undefined || options.glossary === undefined) {
            throw new JobError('JOB_CONFIG_REQUIRED', '--config and --glossary go together', {
              hint: 'pass both files, or neither',
            });
          }
          const { configVersion, loadCampaignConfig, loadGlossary } =
            await import('../config/index.ts');
          const campaign = (await loadCampaignConfig(options.config)).value;
          const glossary = (await loadGlossary(options.glossary)).value;
          config = { campaign, glossary, version: configVersion(campaign, glossary) };
        }
        const { paths } = openDataRoot({
          flag: options.dataRoot,
          allowInRepo: options.allowInRepo,
        });
        const { db } = await openStateDatabase(paths, { logger: deps.logger });
        const controller = new AbortController();
        const uninstall = onInterrupt(() => {
          io.err('recap: cancelling; the running job will be marked cancelled\n');
          controller.abort();
        });
        try {
          const report = await runStage({
            db,
            campaignId: options.campaign,
            sessionId: options.session,
            stage,
            stages,
            paths,
            config,
            signal: controller.signal,
            retry: maxAttempts === undefined ? undefined : { maxAttempts },
            logger: deps.logger,
          });
          printReport(io, report);
          if (report.status === 'failed') process.exitCode = 1;
          if (report.status === 'cancelled') process.exitCode = 130;
        } finally {
          uninstall();
          db.close();
        }
      } catch (error) {
        await reportError(io, error);
      }
    });

  addCommonOptions(program.command('status').description('show the job state of one session'))
    .option('--json', 'print job records (job-record contract) as JSON')
    .option('--all', 'list every job, not only the latest per stage')
    .action(async (options: StatusCliOptions) => {
      try {
        const { existsSync } = await import('node:fs');
        const { assertSlug, openDataRoot } = await import('../paths/index.ts');
        assertSlug('campaign_id', options.campaign);
        assertSlug('session_id', options.session);
        const { paths } = openDataRoot({
          flag: options.dataRoot,
          allowInRepo: options.allowInRepo,
        });
        const label = `${options.campaign}/${options.session}`;
        if (!existsSync(paths.dbFile)) {
          // Status never creates the database.
          if (options.json === true) {
            io.out(
              `${JSON.stringify({ campaign_id: options.campaign, session_id: options.session, lock: null, jobs: [] }, null, 2)}\n`,
            );
          } else {
            io.out(`${label}: no jobs recorded yet\n`);
          }
          return;
        }
        const { openStateDatabase } = await import('../db/index.ts');
        const { latestJobPerStage, listJobs, toJobRecord } = await import('./store.ts');
        const { lockLiveness, readSessionLock } = await import('./lock.ts');
        const { db } = await openStateDatabase(paths, { logger: deps.logger });
        try {
          const jobs =
            options.all === true
              ? listJobs(db, options.campaign, options.session)
              : latestJobPerStage(db, options.campaign, options.session);
          const lock = readSessionLock(db, options.campaign, options.session);
          const live = lock === undefined ? undefined : lockLiveness(lock);
          if (options.json === true) {
            io.out(
              `${JSON.stringify(
                {
                  campaign_id: options.campaign,
                  session_id: options.session,
                  lock:
                    lock === undefined
                      ? null
                      : {
                          owner_pid: lock.ownerPid,
                          owner_host: lock.ownerHost,
                          acquired_at: lock.acquiredAt,
                          alive: live?.alive ?? false,
                        },
                  jobs: jobs.map(toJobRecord),
                },
                null,
                2,
              )}\n`,
            );
            return;
          }
          io.out(`${label}\n`);
          if (lock !== undefined) {
            io.out(
              live?.alive === true
                ? `  lock: held by pid ${String(lock.ownerPid)} on ${lock.ownerHost} since ${lock.acquiredAt}\n`
                : `  lock: left by pid ${String(lock.ownerPid)} (${live?.reason ?? 'gone'}); the next run takes it over\n`,
            );
          }
          if (jobs.length === 0) io.out('  no jobs recorded yet\n');
          const ownerGone = lock === undefined || live?.alive !== true;
          for (const job of jobs) io.out(`  ${describeJob(job, ownerGone)}\n`);
        } finally {
          db.close();
        }
      } catch (error) {
        await reportError(io, error);
      }
    });
}
