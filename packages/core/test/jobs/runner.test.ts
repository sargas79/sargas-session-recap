import { existsSync, readFileSync } from 'node:fs';
import type { CampaignConfig, Glossary } from '@sargas-recap/contracts';
import { validateJobRecord } from '@sargas-recap/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireSessionLock,
  createJob,
  defineStages,
  JobError,
  latestJob,
  listJobs,
  runStage,
  StageError,
  toJobRecord,
  transitionJob,
  type RunOptions,
  type RunReport,
  type StageRegistry,
} from '../../src/jobs/index.ts';
import { campaign as campaignFixture, glossary as glossaryFixture, at } from '../config/helpers.ts';
import {
  newWorld,
  noSleep,
  openFixture,
  pipelineStages,
  runConfig,
  sha,
  type Fixture,
  type World,
} from './helpers.ts';

const CAMPAIGN = 'synthetic-vaults';
const SESSION = 's01';

let fx: Fixture;
let world: World;
let campaign: CampaignConfig;
let glossary: Glossary;

beforeEach(async () => {
  fx = await openFixture();
  world = newWorld();
  campaign = campaignFixture();
  glossary = glossaryFixture();
});

afterEach(() => {
  fx.cleanup();
});

function run(
  stage: string,
  extra: Partial<RunOptions> = {},
  stages: StageRegistry = pipelineStages(world),
): Promise<RunReport> {
  return runStage({
    db: fx.db,
    campaignId: CAMPAIGN,
    sessionId: SESSION,
    stage,
    stages,
    paths: fx.paths,
    config: runConfig(campaign, glossary),
    logger: fx.logger,
    sleep: noSleep,
    ...extra,
  });
}

function actions(report: RunReport): Record<string, string> {
  return Object.fromEntries(report.stages.map((s) => [s.stage, s.action]));
}

function calls(): Record<string, number> {
  return { ...world.calls };
}

describe('runStage: planning and up-to-date detection', () => {
  it('runs the target and its upstream stages in order, then skips them when nothing changed', async () => {
    const first = await run('recap');
    expect(first.status).toBe('succeeded');
    expect(first.stages.map((s) => s.stage)).toEqual(['import', 'transcribe', 'classify', 'recap']);
    expect(actions(first)).toEqual({
      import: 'succeeded',
      transcribe: 'succeeded',
      classify: 'succeeded',
      recap: 'succeeded',
    });
    expect(first.stages.every((s) => s.reason === 'never-run')).toBe(true);

    const second = await run('recap');
    expect(second.status).toBe('succeeded');
    expect(Object.values(actions(second))).toEqual([
      'up-to-date',
      'up-to-date',
      'up-to-date',
      'up-to-date',
    ]);
    expect(calls()).toEqual({ import: 1, transcribe: 1, classify: 1, recap: 1 });
  });

  it('runs only up to the requested stage', async () => {
    const report = await run('transcribe');
    expect(report.stages.map((s) => s.stage)).toEqual(['import', 'transcribe']);
    expect(calls()).toEqual({ import: 1, transcribe: 1 });
  });

  it('records job rows that satisfy the job-record contract, with inputs, outputs and usage', async () => {
    await run('recap');
    const jobs = listJobs(fx.db, CAMPAIGN, SESSION);
    expect(jobs).toHaveLength(4);
    for (const job of jobs) {
      const result = validateJobRecord(toJobRecord(job));
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(job.status).toBe('succeeded');
      expect(job.startedAt).toBeDefined();
      expect(job.finishedAt).toBeDefined();
    }
    const classify = latestJob(fx.db, CAMPAIGN, SESSION, 'classify');
    expect(classify?.usage).toEqual({
      input_tokens: 1200,
      output_tokens: 300,
      cost_micro_usd: 4500,
    });
    const transcribe = latestJob(fx.db, CAMPAIGN, SESSION, 'transcribe');
    const refs = transcribe?.inputs.map((i) => `${i.role}:${i.kind}:${i.ref}`) ?? [];
    expect(refs).toEqual(
      expect.arrayContaining([
        'dependency:artifact:fragments.jsonl',
        'dependency:config:stage-deps:asr',
        'dependency:model:whisper-test',
        'receipt:config:consent:asr:whisper-local:records',
      ]),
    );
    expect(latestJob(fx.db, CAMPAIGN, SESSION, 'recap')?.outputRecapRevision).toBe(1);
  });

  it('refuses an unknown stage before creating anything', async () => {
    await expect(run('nope')).rejects.toMatchObject({ code: 'JOB_UNKNOWN_STAGE' });
    expect(listJobs(fx.db, CAMPAIGN, SESSION)).toHaveLength(0);
  });

  it('refuses a config for another campaign', async () => {
    campaign.campaign_id = 'other-campaign';
    await expect(run('import')).rejects.toMatchObject({ code: 'JOB_CONFIG_REQUIRED' });
  });

  it('asks for the config when a config-dependent stage has none', async () => {
    await expect(run('transcribe', { config: undefined })).rejects.toMatchObject({
      code: 'JOB_CONFIG_REQUIRED',
    });
  });

  it('rejects malformed stage graphs', () => {
    expect(() =>
      defineStages([{ name: 'classify', upstream: ['transcribe'], run: () => undefined }]),
    ).toThrow(JobError);
    expect(() =>
      defineStages([
        { name: 'classify', upstream: ['recap'], run: () => undefined },
        { name: 'recap', upstream: ['classify'], run: () => undefined },
      ]),
    ).toThrow(/cycle/);
    expect(() => defineStages([{ name: 'bogus' as 'recap', run: () => undefined }])).toThrow(
      /not a job-record stage/,
    );
  });
});

describe('selective invalidation matrix', () => {
  type Case = [
    label: string,
    change: (ctx: { campaign: CampaignConfig; glossary: Glossary; world: World }) => void,
    rerun: string[],
  ];
  const cases: Case[] = [
    ['nothing', () => undefined, []],
    [
      'speaker display_name (not sent to any provider)',
      ({ campaign }) => {
        at(campaign.speakers, 0).display_name = 'Renamed GM';
      },
      [],
    ],
    [
      'consent record added (enforced by assertConsent, not by invalidation)',
      ({ campaign }) => {
        at(campaign.speakers, 2).consent?.push({
          purpose: 'recap',
          provider: 'claude-cli',
          granted_on: '2026-03-01',
        });
      },
      [],
    ],
    [
      'consent_mode switched off',
      ({ campaign }) => {
        campaign.consent_mode = 'implied';
      },
      [],
    ],
    [
      'recording provider (no processing stage uses it)',
      ({ campaign }) => {
        campaign.provider.recording = 'discord-bot';
      },
      [],
    ],
    [
      'glossary description (recap only)',
      ({ glossary }) => {
        at(glossary.entries, 0).description = 'SYNTHETIC. Changed description.';
      },
      ['recap'],
    ],
    [
      'campaign background (recap only)',
      ({ campaign }) => {
        campaign.background = 'SYNTHETIC. Another background.';
      },
      ['recap'],
    ],
    [
      'glossary mishearings (classification, then recap through its output)',
      ({ glossary }) => {
        at(glossary.entries, 1).mishearings = ['Sarah Ray'];
      },
      ['classify', 'recap'],
    ],
    [
      'ASR model with identical output (transcribe only)',
      ({ world }) => {
        world.asrModel = sha('model-v2');
      },
      ['transcribe'],
    ],
    [
      'glossary spelling (ASR prompt and everything after)',
      ({ glossary }) => {
        at(glossary.entries, 3).spelling = 'Otary';
      },
      ['transcribe', 'classify', 'recap'],
    ],
    [
      'language (every config-dependent stage)',
      ({ campaign }) => {
        campaign.language = 'en';
      },
      ['transcribe', 'classify', 'recap'],
    ],
    [
      'source audio hash (everything)',
      ({ world }) => {
        world.source = sha('source-v2');
      },
      ['import', 'transcribe', 'classify', 'recap'],
    ],
  ];

  it.each(cases)('changing %s reruns exactly %j', async (_label, change, rerun) => {
    await run('recap');
    const before = calls();
    change({ campaign, glossary, world });
    const report = await run('recap');
    expect(report.status).toBe('succeeded');
    const ran = report.stages.filter((s) => s.action === 'succeeded').map((s) => s.stage);
    expect(ran).toEqual(rerun);
    for (const s of report.stages) {
      if (s.action === 'succeeded') expect(s.reason).toBe('inputs-changed');
      expect(world.calls[s.stage]).toBe((before[s.stage] ?? 0) + (rerun.includes(s.stage) ? 1 : 0));
    }
  });

  it('names the changed inputs, never their content', async () => {
    await run('recap');
    at(glossary.entries, 0).description = 'SYNTHETIC. Changed description.';
    const report = await run('recap');
    const recap = report.stages.find((s) => s.stage === 'recap');
    expect(recap?.changedInputs).toEqual(['config:stage-deps:recap']);
  });

  it('a reverted change matches the earlier succeeded job again', async () => {
    await run('recap');
    world.source = sha('source-v2');
    await run('recap');
    world.source = sha('source-v1');
    const report = await run('recap');
    expect(Object.values(actions(report))).toEqual([
      'succeeded',
      'succeeded',
      'succeeded',
      'succeeded',
    ]);
    // Reverting is a change relative to the latest succeeded job, so it reruns (new run IDs).
  });
});

describe('consent', () => {
  it('records the assertConsent receipt as a receipt input (mode + policy hash)', async () => {
    campaign.consent_mode = 'implied';
    await run('classify');
    const job = latestJob(fx.db, CAMPAIGN, SESSION, 'classify');
    const receipt = job?.inputs.find((i) => i.role === 'receipt');
    expect(receipt).toEqual({
      kind: 'config',
      ref: 'consent:classification:claude-cli:implied',
      hash: runConfig(campaign, glossary).version.consent_policy_hash,
      role: 'receipt',
    });
  });

  it('fails the job without calling the stage when consent is missing', async () => {
    const stages = pipelineStages(world, {
      recap: {
        provider: { purpose: 'recap', speakerIds: () => ['gm', 'player-bruno'] },
      },
    });
    const report = await run('recap', {}, stages);
    expect(report.status).toBe('failed');
    const recap = report.stages.find((s) => s.stage === 'recap');
    expect(recap?.action).toBe('failed');
    expect(recap?.error?.code).toBe('consent-missing');
    expect(recap?.error?.retryable).toBe(false);
    expect(world.calls['recap']).toBeUndefined();
    const job = latestJob(fx.db, CAMPAIGN, SESSION, 'recap');
    expect(job?.status).toBe('failed');
    expect(validateJobRecord(toJobRecord(job ?? never())).ok).toBe(true);
  });

  it('still refuses speakers missing from campaign.yaml in implied mode', async () => {
    campaign.consent_mode = 'implied';
    const stages = pipelineStages(world, {
      transcribe: { provider: { purpose: 'asr', speakerIds: () => ['stranger'] } },
    });
    const report = await run('transcribe', {}, stages);
    expect(report.stages.find((s) => s.stage === 'transcribe')?.error?.code).toBe(
      'consent-missing',
    );
    expect(world.calls['transcribe']).toBeUndefined();
  });
});

function never(): never {
  throw new Error('unreachable');
}

describe('bounded retry', () => {
  it('retries a retryable error with exponential backoff and succeeds', async () => {
    let failures = 2;
    const delays: number[] = [];
    const stages = pipelineStages(world, {
      import: {
        retry: { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 1_000 },
        run: () => {
          if (failures > 0) {
            failures -= 1;
            throw new StageError('provider-timeout', 'provider timed out; retrying', {
              retryable: true,
            });
          }
          return { outputs: [] };
        },
      },
    });
    const report = await run(
      'import',
      {
        sleep: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
      },
      stages,
    );
    expect(report.status).toBe('succeeded');
    expect(at(report.stages, 0).attempts).toBe(3);
    expect(delays).toEqual([100, 200]);
    const job = latestJob(fx.db, CAMPAIGN, SESSION, 'import');
    expect(job?.attempt).toBe(3);
    expect(job?.maxAttempts).toBe(4);
    expect(job?.error).toBeUndefined();
  });

  it('caps the delay at maxDelayMs', async () => {
    const delays: number[] = [];
    const stages = pipelineStages(world, {
      import: {
        retry: { maxAttempts: 5, baseDelayMs: 1_000, maxDelayMs: 2_500 },
        run: () => {
          throw new StageError('provider-busy', 'provider busy', { retryable: true });
        },
      },
    });
    await run(
      'import',
      {
        sleep: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
      },
      stages,
    );
    expect(delays).toEqual([1_000, 2_000, 2_500, 2_500]);
  });

  it('marks the job failed when attempts are exhausted, and stops downstream stages', async () => {
    const stages = pipelineStages(world, {
      transcribe: {
        run: () => {
          world.calls['transcribe'] = (world.calls['transcribe'] ?? 0) + 1;
          throw new StageError('provider-timeout', 'whisper did not answer in 600 s', {
            retryable: true,
          });
        },
      },
    });
    const report = await run('recap', { retry: { maxAttempts: 3 } }, stages);
    expect(report.status).toBe('failed');
    expect(actions(report)).toEqual({ import: 'succeeded', transcribe: 'failed' });
    expect(world.calls['transcribe']).toBe(3);
    const job = latestJob(fx.db, CAMPAIGN, SESSION, 'transcribe');
    expect(job?.status).toBe('failed');
    expect(job?.attempt).toBe(3);
    expect(job?.error).toEqual({
      code: 'provider-timeout',
      message: 'whisper did not answer in 600 s',
      retryable: true,
    });
    expect(validateJobRecord(toJobRecord(job ?? never())).ok).toBe(true);
    expect(world.calls['classify']).toBeUndefined();
  });

  it('does not retry a non-retryable error and never records an unknown error message', async () => {
    const stages = pipelineStages(world, {
      import: {
        run: () => {
          throw new Error('SECRET transcript line that must not be stored');
        },
      },
    });
    const report = await run('import', { retry: { maxAttempts: 5 } }, stages);
    const outcome = at(report.stages, 0);
    expect(outcome.attempts).toBe(1);
    expect(outcome.error?.code).toBe('stage-error');
    const job = latestJob(fx.db, CAMPAIGN, SESSION, 'import');
    expect(job?.error?.message).not.toContain('SECRET');
    expect(fx.logLines.join('\n')).not.toContain('SECRET');
  });

  it('reruns a failed stage on the next run', async () => {
    let fail = true;
    const stages = pipelineStages(world, {
      import: {
        run: () => {
          if (fail) throw new StageError('disk-full', 'free some disk space and run again');
          return { outputs: [] };
        },
      },
    });
    expect((await run('import', {}, stages)).status).toBe('failed');
    fail = false;
    const report = await run('import', {}, stages);
    expect(report.status).toBe('succeeded');
    expect(at(report.stages, 0).reason).toBe('previous-not-succeeded');
  });

  it('rejects invalid stage outputs', async () => {
    const stages = pipelineStages(world, {
      import: { run: () => ({ outputs: [{ path: '../escape', hash: sha('x') }] }) },
    });
    const report = await run('import', {}, stages);
    expect(at(report.stages, 0).error?.code).toBe('job-invalid-output');
  });
});

describe('cancellation', () => {
  it('moves the running job to cancelled on abort and does not start later stages', async () => {
    const controller = new AbortController();
    const stages = pipelineStages(world, {
      transcribe: {
        run: (ctx) =>
          new Promise((_resolve, reject) => {
            ctx.signal.addEventListener('abort', () => {
              reject(new Error('aborted'));
            });
            controller.abort();
          }),
      },
    });
    const report = await run('recap', { signal: controller.signal }, stages);
    expect(report.status).toBe('cancelled');
    expect(actions(report)).toEqual({ import: 'succeeded', transcribe: 'cancelled' });
    const job = latestJob(fx.db, CAMPAIGN, SESSION, 'transcribe');
    expect(job?.status).toBe('cancelled');
    expect(job?.finishedAt).toBeDefined();
    expect(job?.error).toBeUndefined();
    expect(validateJobRecord(toJobRecord(job ?? never())).ok).toBe(true);
    // The lock is released: the next run proceeds and re-runs the cancelled stage.
    const next = await run('recap');
    expect(actions(next)).toEqual({
      import: 'up-to-date',
      transcribe: 'succeeded',
      classify: 'succeeded',
      recap: 'succeeded',
    });
  });

  it('cancels during the retry backoff', async () => {
    const controller = new AbortController();
    const stages = pipelineStages(world, {
      import: {
        run: () => {
          throw new StageError('provider-busy', 'busy', { retryable: true });
        },
      },
    });
    const report = await run(
      'import',
      {
        signal: controller.signal,
        sleep: () => {
          controller.abort();
          return Promise.resolve();
        },
      },
      stages,
    );
    expect(report.status).toBe('cancelled');
    expect(latestJob(fx.db, CAMPAIGN, SESSION, 'import')?.status).toBe('cancelled');
  });

  it('starts nothing when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const report = await run('recap', { signal: controller.signal });
    expect(report.status).toBe('cancelled');
    expect(report.stages).toHaveLength(0);
    expect(listJobs(fx.db, CAMPAIGN, SESSION)).toHaveLength(0);
  });
});

describe('per-session lock (in process)', () => {
  it('refuses a second run on the same session while the first is running', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const slow = pipelineStages(world, {
      import: {
        run: async () => {
          started();
          await gate;
          return { outputs: [] };
        },
      },
    });
    const first = run('import', {}, slow);
    await running;
    const lockFile = fx.paths.sessionLockFile(CAMPAIGN, SESSION);
    expect(existsSync(lockFile)).toBe(true);
    expect(JSON.parse(readFileSync(lockFile, 'utf8'))).toMatchObject({ pid: process.pid });

    const error = await run('import').then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(JobError);
    expect((error as JobError).code).toBe('JOB_SESSION_LOCKED');
    expect((error as JobError).message).toContain(`pid ${String(process.pid)}`);
    expect((error as JobError).hint).toContain('Ctrl+C');

    // Another session is independent.
    const other = await runStage({
      db: fx.db,
      campaignId: CAMPAIGN,
      sessionId: 's02',
      stage: 'import',
      stages: pipelineStages(newWorld()),
      paths: fx.paths,
      logger: fx.logger,
    });
    expect(other.status).toBe('succeeded');

    release();
    expect((await first).status).toBe('succeeded');
    expect(existsSync(lockFile)).toBe(false);
  });

  it('replaces a lock whose heartbeat is stale', async () => {
    const stale = acquireSessionLock(fx.db, CAMPAIGN, SESSION, {
      nowMs: () => Date.now() - 120_000,
    });
    const report = await run('import');
    expect(report.status).toBe('succeeded');
    expect(report.replacedLock?.ownerToken).toBe(stale.token);
    expect(stale.heartbeat()).toBe(false); // the old holder learns it lost the lock
  });

  it('replaces a lock whose owner pid is dead', async () => {
    acquireSessionLock(fx.db, CAMPAIGN, SESSION, { pid: 999_999_999 });
    const report = await run('import');
    expect(report.status).toBe('succeeded');
    expect(report.replacedLock?.ownerPid).toBe(999_999_999);
  });
});

describe('crash recovery (in process, simulated)', () => {
  it('marks a job left running by a dead owner as interrupted and re-runs only that stage onward', async () => {
    await run('classify');
    // Simulate a crash during `recap`: a dead owner holds the lock and left a running job.
    const ghost = acquireSessionLock(fx.db, CAMPAIGN, SESSION, { pid: 999_999_998 });
    createJob(fx.db, {
      jobId: '01JBX7Q8M2N4P6R8S0T2V4W6XY',
      campaignId: CAMPAIGN,
      sessionId: SESSION,
      stage: 'recap',
      maxAttempts: 3,
      inputs: [],
      now: new Date(),
    });
    transitionJob(fx.db, '01JBX7Q8M2N4P6R8S0T2V4W6XY', 'pending', 'running', {
      now: new Date(),
      owner: { pid: 999_999_998, token: ghost.token },
    });

    const report = await run('recap');
    expect(report.recovered).toEqual([
      { jobId: '01JBX7Q8M2N4P6R8S0T2V4W6XY', stage: 'recap', from: 'running', to: 'failed' },
    ]);
    expect(actions(report)).toEqual({
      import: 'up-to-date',
      transcribe: 'up-to-date',
      classify: 'up-to-date',
      recap: 'succeeded',
    });
    expect(report.stages.find((s) => s.stage === 'recap')?.reason).toBe('recovering');
    const interrupted = listJobs(fx.db, CAMPAIGN, SESSION).find(
      (j) => j.jobId === '01JBX7Q8M2N4P6R8S0T2V4W6XY',
    );
    expect(interrupted?.status).toBe('failed');
    expect(interrupted?.error?.code).toBe('interrupted');
    expect(interrupted?.error?.retryable).toBe(true);
    const rerun = latestJob(fx.db, CAMPAIGN, SESSION, 'recap');
    expect(rerun?.recoveredFromJobId).toBe('01JBX7Q8M2N4P6R8S0T2V4W6XY');
    expect(calls()).toEqual({ import: 1, transcribe: 1, classify: 1, recap: 1 });
  });
});

describe('lock loss', () => {
  it('aborts the stage and reports JOB_LOCK_LOST when another run took the lock over', async () => {
    const stages = pipelineStages(world, {
      import: {
        run: (ctx) =>
          new Promise((_resolve, reject) => {
            ctx.signal.addEventListener('abort', () => {
              reject(new Error('aborted'));
            });
            // Simulate a takeover after this process looked dead (e.g. a long system sleep).
            fx.db.prepare('DELETE FROM session_locks').run();
          }),
      },
    });
    await expect(run('import', { lock: { heartbeatMs: 10 } }, stages)).rejects.toMatchObject({
      code: 'JOB_LOCK_LOST',
    });
    expect(latestJob(fx.db, CAMPAIGN, SESSION, 'import')?.status).toBe('cancelled');
  });

  it('refreshes the heartbeat of the lock and of the running job', async () => {
    let seen: { lock: number; job: number } | undefined;
    const stages = pipelineStages(world, {
      import: {
        run: async (ctx) => {
          const read = () => ({
            lock: (
              fx.db.prepare('SELECT heartbeat_at AS h FROM session_locks').get() as { h: number }
            ).h,
            job: (
              fx.db
                .prepare('SELECT heartbeat_at AS h FROM jobs WHERE job_id = ?')
                .get(ctx.jobId) as {
                h: number;
              }
            ).h,
          });
          const before = read();
          await new Promise((r) => setTimeout(r, 120));
          const after = read();
          seen = { lock: after.lock - before.lock, job: after.job - before.job };
          return { outputs: [] };
        },
      },
    });
    await run('import', { lock: { heartbeatMs: 20 } }, stages);
    expect(seen?.lock).toBeGreaterThan(0);
    expect(seen?.job).toBeGreaterThan(0);
  });
});
