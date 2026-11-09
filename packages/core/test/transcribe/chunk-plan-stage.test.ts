import { cpSync, readFileSync } from 'node:fs';
import type { CampaignConfig, ChunkPlan } from '@sargas-recap/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ResolvedTool } from '../../src/audio/index.ts';
import type { RunConfig, StageContext } from '../../src/jobs/stage.ts';
import { JobError, StageError } from '../../src/jobs/errors.ts';
import { defineStages } from '../../src/jobs/stage.ts';
import { runStage, type RunReport } from '../../src/jobs/index.ts';
import { createLogger } from '../../src/log/index.ts';
import { sealPackage, validatePackage } from '../../src/package/index.ts';
import {
  chunkPlanJobInput,
  chunkPlanPath,
  createChunkPlanStage,
  parseChunkPlan,
  type DetectPauses,
} from '../../src/transcribe/index.ts';
import { campaign as campaignFixture, glossary as glossaryFixture } from '../config/helpers.ts';
import { noSleep, openFixture, runConfig, type Fixture } from '../jobs/helpers.ts';
import { makePackage, type TempPackage } from '../package/helpers.ts';

const ffmpeg = (raw: string): ResolvedTool =>
  ({ path: 'ffmpeg', source: 'path', version: { raw } }) as unknown as ResolvedTool;

function config(chunking?: CampaignConfig['chunking']): RunConfig {
  return {
    campaign: { chunking } as CampaignConfig,
    glossary: {} as RunConfig['glossary'],
    version: {} as RunConfig['version'],
  };
}

function context(pkg: TempPackage, overrides: Partial<StageContext> = {}): StageContext {
  return {
    db: {} as StageContext['db'],
    campaignId: 'test-campaign',
    sessionId: 's01',
    paths: undefined,
    sessionDir: pkg.root,
    config: config(),
    upstream: new Map(),
    jobId: '01JBX6ZZ0A1B2C3D4E5F6G7H8J',
    attempt: 1,
    maxAttempts: 3,
    signal: new AbortController().signal,
    inputs: [],
    recoveredFrom: undefined,
    consent: undefined,
    logger: createLogger({ sink: () => undefined }),
    ...overrides,
  };
}

const silenceBetween: DetectPauses = (_path, f) =>
  Promise.resolve(f.duration_ms > 15 ? [{ startMs: 5, endMs: 10 }] : []);

describe('chunk-plan through the job runner', () => {
  let fx: Fixture;
  let pkg: TempPackage;
  let detections = 0;
  const stages = defineStages([
    createChunkPlanStage({
      detect: (...args) => {
        detections += 1;
        return silenceBetween(...args);
      },
      resolveFfmpeg: () => Promise.resolve(ffmpeg('9.0.2')),
    }),
  ]);
  const session = { campaignId: 'synthetic-vaults', sessionId: 's01' };
  const run = (chunking?: CampaignConfig['chunking']): Promise<RunReport> => {
    const base = campaignFixture();
    const campaign = chunking === undefined ? base : { ...base, chunking };
    return runStage({
      db: fx.db,
      ...session,
      stage: 'chunk-plan',
      stages,
      paths: fx.paths,
      config: runConfig(campaign, glossaryFixture()),
      logger: fx.logger,
      sleep: noSleep,
    });
  };
  const action = (report: RunReport): string | undefined => report.stages[0]?.action;

  beforeEach(async () => {
    detections = 0;
    fx = await openFixture();
    pkg = makePackage();
    await sealPackage(pkg.root);
    cpSync(pkg.root, fx.paths.sessionDir(session.campaignId, session.sessionId), {
      recursive: true,
    });
  });

  afterEach(() => {
    pkg.cleanup();
    fx.cleanup();
  });

  it('runs once, is then up to date, and reruns only when a parameter changes', async () => {
    expect(action(await run())).toBe('succeeded');
    const planned = detections;
    expect(planned).toBeGreaterThan(0);
    expect(action(await run())).toBe('up-to-date');
    expect(detections).toBe(planned);
    expect(action(await run({ target_chunk_ms: 20_000 }))).toBe('succeeded');
    expect(detections).toBeGreaterThan(planned);
  });
});

describe('chunk-plan stage', () => {
  let pkg: TempPackage;
  const stage = createChunkPlanStage({
    detect: silenceBetween,
    resolveFfmpeg: () => Promise.resolve(ffmpeg('9.0.2')),
  });

  beforeEach(async () => {
    pkg = makePackage();
    await sealPackage(pkg.root);
  });

  afterEach(() => {
    pkg.cleanup();
  });

  it('registers as a stage', () => {
    expect([...defineStages([stage]).keys()]).toEqual(['chunk-plan']);
  });

  it('declares the sealed artifacts, the parameters and the ffmpeg version as inputs', async () => {
    const inputs = await stage.inputs?.(context(pkg));
    expect(inputs?.map((i) => `${i.kind}:${i.ref}`)).toEqual([
      'artifact:fragments.jsonl',
      'artifact:audio',
      'config:chunk-plan-params',
      'config:tool:ffmpeg',
    ]);
    const again = await stage.inputs?.(context(pkg));
    expect(again).toEqual(inputs);
  });

  it('changes its inputs when a parameter or ffmpeg changes', async () => {
    const base = await stage.inputs?.(context(pkg));
    const paramsChanged = await stage.inputs?.(
      context(pkg, { config: config({ target_chunk_ms: 20_000 }) }),
    );
    expect(paramsChanged?.[2]?.hash).not.toBe(base?.[2]?.hash);
    expect(paramsChanged?.[0]).toEqual(base?.[0]);
    const other = createChunkPlanStage({
      detect: silenceBetween,
      resolveFfmpeg: () => Promise.resolve(ffmpeg('7.1.0')),
    });
    const toolChanged = await other.inputs?.(context(pkg));
    expect(toolChanged?.[3]?.hash).not.toBe(base?.[3]?.hash);
  });

  it('writes a valid plan and reports it as the job output, without breaking the package', async () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (line) => lines.push(line) });
    const result = await stage.run(context(pkg, { logger }));
    const output = result?.outputs?.[0];
    if (output === undefined) throw new Error('no output');
    const plan = parseChunkPlan(readFileSync(pkg.file(output.path), 'utf8'));
    expect(output.hash).toBe(plan.plan_hash);
    expect(output.path).toBe(chunkPlanPath(plan.plan_hash));
    expect(chunkPlanJobInput(plan)).toEqual({
      kind: 'chunk-plan',
      ref: output.path,
      hash: plan.plan_hash,
    });
    expect((await validatePackage(pkg.root)).ok).toBe(true);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      event: 'chunk-plan.written',
      stage: 'chunk-plan',
      count: 3,
      chunks: plan.chunks.length,
    });
    expect(JSON.parse(lines[0] ?? '')).not.toHaveProperty('redacted');
  });

  it('is deterministic across runs', async () => {
    const first = await stage.run(context(pkg));
    const second = await stage.run(context(pkg));
    expect(second?.outputs).toEqual(first?.outputs);
  });

  it('applies campaign chunking overrides', async () => {
    const planFor = async (chunking?: CampaignConfig['chunking']): Promise<ChunkPlan> => {
      const result = await stage.run(context(pkg, { config: config(chunking) }));
      return parseChunkPlan(readFileSync(pkg.file(result?.outputs?.[0]?.path ?? ''), 'utf8'));
    };
    // The synthetic fragments are 20 ms with a 5 ms pause: kept by default, removed here.
    const defaults = await planFor();
    expect(new Set(defaults.pauses.map((p) => p.disposition))).toEqual(new Set(['preserved']));
    const removed = await planFor({ remove_pause_min_ms: 5, removal_padding_ms: 0 });
    expect(new Set(removed.pauses.map((p) => p.disposition))).toEqual(new Set(['removed']));
    expect(removed.params.remove_pause_min_ms).toBe(5);
    expect(removed.plan_hash).not.toBe(defaults.plan_hash);
  });

  it('wraps a planner failure as a recorded stage error', async () => {
    const failing = createChunkPlanStage({
      detect: () => Promise.resolve([{ startMs: 0.5, endMs: 2 }]),
      resolveFfmpeg: () => Promise.resolve(ffmpeg('9.0.2')),
    });
    await expect(failing.run(context(pkg))).rejects.toMatchObject({ code: 'chunk-plan-failed' });
    await expect(failing.run(context(pkg))).rejects.toBeInstanceOf(StageError);
  });

  it('fails with a stage error on a modified package, naming the problem and no content', async () => {
    pkg.write('fragments.jsonl', '\n');
    await expect(stage.run(context(pkg))).rejects.toMatchObject({ code: 'package-invalid' });
  });

  it('refuses a package without a session directory, or one still capturing', async () => {
    await expect(stage.inputs?.(context(pkg, { sessionDir: undefined }))).rejects.toBeInstanceOf(
      JobError,
    );
    const capturing = makePackage();
    try {
      await expect(stage.inputs?.(context(capturing))).rejects.toMatchObject({
        code: 'JOB_INVALID_INPUT',
      });
    } finally {
      capturing.cleanup();
    }
  });

  it('requires the campaign config, so it cannot silently fall back to the defaults', async () => {
    await expect(stage.inputs?.(context(pkg, { config: undefined }))).rejects.toMatchObject({
      code: 'JOB_CONFIG_REQUIRED',
    });
  });

  it('reports invalid campaign chunking as a job input error', async () => {
    await expect(
      stage.inputs?.(context(pkg, { config: config({ target_chunk_ms: 99_000_000 }) })),
    ).rejects.toThrow(/must not exceed/);
  });

  it('surfaces a missing ffmpeg as a job input error with its fix', async () => {
    const { AudioToolError } = await import('../../src/audio/index.ts');
    const noTool = createChunkPlanStage({
      resolveFfmpeg: () =>
        Promise.reject(
          new AudioToolError('AUDIO_TOOL_NOT_FOUND', 'ffmpeg not found', { hint: 'install it' }),
        ),
    });
    await expect(noTool.inputs?.(context(pkg))).rejects.toMatchObject({
      code: 'JOB_INVALID_INPUT',
      hint: 'install it',
    });
  });
});
