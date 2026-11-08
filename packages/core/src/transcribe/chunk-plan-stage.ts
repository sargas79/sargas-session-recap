/**
 * The `chunk-plan` job stage (T08): detects pauses per fragment with T22's `detectSilences`, plans
 * the chunks and writes `chunk-plans/<hash>.json`. Local only: nothing leaves the machine, so
 * there is no provider and no `assertConsent` call here (T09 makes that call for ASR).
 *
 * Runtime dependencies load on first use, so that registering the stage keeps the CLI start fast.
 */
import type { ChunkPlan, ChunkPlanParams, Fragment, Manifest } from '@sargas-recap/contracts';
import type { ResolvedTool, SilenceInterval } from '../audio/index.ts';
import { JobError, StageError } from '../jobs/errors.ts';
import {
  artifactInput,
  requireConfig,
  type InputContext,
  type StageDefinition,
} from '../jobs/stage.ts';
import type { JobInput } from '../jobs/store.ts';

export const CHUNK_PLAN_DIR = 'chunk-plans';

/** Package-relative path of a plan. Content-addressed: which plan is current lives in SQLite. */
export function chunkPlanPath(planHash: string): string {
  return `${CHUNK_PLAN_DIR}/${planHash.slice('sha256:'.length)}.json`;
}

/** A plan as a job input of a later stage (T09): `kind: chunk-plan`, keyed by its path. */
export function chunkPlanJobInput(plan: Pick<ChunkPlan, 'plan_hash'>): JobInput {
  return { kind: 'chunk-plan', ref: chunkPlanPath(plan.plan_hash), hash: plan.plan_hash };
}

export interface DetectFragmentPausesOptions {
  readonly ffmpeg?: ResolvedTool | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly detect?: DetectPauses | undefined;
}

/** Pauses of one fragment's audio file, in ms from the start of the file. */
export type DetectPauses = (
  absolutePath: string,
  fragment: Fragment,
  params: ChunkPlanParams,
  options: { readonly ffmpeg?: ResolvedTool | undefined; readonly signal: AbortSignal | undefined },
) => Promise<readonly SilenceInterval[]>;

const defaultDetect: DetectPauses = async (absolutePath, fragment, params, options) => {
  const { detectSilences } = await import('../audio/index.ts');
  return detectSilences(
    absolutePath,
    { thresholdDb: params.silence_threshold_db, minSilenceMs: params.min_silence_ms },
    { durationMs: fragment.duration_ms, ffmpeg: options.ffmpeg, signal: options.signal },
  );
};

/** Runs pause detection on each fragment that has audio, one at a time, in fragment order. */
export async function detectFragmentPauses(
  packageRoot: string,
  fragments: readonly Fragment[],
  params: ChunkPlanParams,
  options: DetectFragmentPausesOptions = {},
): Promise<Map<string, readonly SilenceInterval[]>> {
  const { realPackageRoot, resolveInsidePackage } = await import('../package/index.ts');
  const detect = options.detect ?? defaultDetect;
  const realRoot = await realPackageRoot(packageRoot);
  const pauses = new Map<string, readonly SilenceInterval[]>();
  for (const fragment of fragments) {
    if (fragment.duration_ms === 0) continue;
    const { absolute } = await resolveInsidePackage(realRoot, fragment.path);
    pauses.set(
      fragment.fragment_id,
      await detect(absolute, fragment, params, { ffmpeg: options.ffmpeg, signal: options.signal }),
    );
  }
  return pauses;
}

export interface ChunkPlanStageOptions {
  /** Replaces ffmpeg's silence detection (tests). */
  readonly detect?: DetectPauses | undefined;
  /** Replaces ffmpeg discovery (tests). */
  readonly resolveFfmpeg?: (() => Promise<ResolvedTool>) | undefined;
}

const defaultResolveFfmpeg = async (): Promise<ResolvedTool> => {
  const { resolveTool } = await import('../audio/index.ts');
  return resolveTool('ffmpeg');
};

function requireSessionDir(ctx: Pick<InputContext, 'sessionDir'>): string {
  if (ctx.sessionDir === undefined) {
    throw new JobError('JOB_INVALID_INPUT', 'stage chunk-plan needs a session package directory');
  }
  return ctx.sessionDir;
}

async function loadParams(ctx: Pick<InputContext, 'config'>): Promise<ChunkPlanParams> {
  const { resolveChunkPlanParams } = await import('./chunk-plan.ts');
  const { isChunkPlanError } = await import('./errors.ts');
  // Required, not optional: running without the config would silently fall back to the defaults
  // and replace a plan built with the campaign's own `chunking:` settings.
  const { campaign } = requireConfig(ctx, 'chunk-plan');
  try {
    return resolveChunkPlanParams(campaign.chunking);
  } catch (error) {
    if (isChunkPlanError(error)) throw new JobError('JOB_INVALID_INPUT', error.message);
    throw error;
  }
}

/** The manifest of a sealed package whose audio is still present. */
export async function readSealedManifest(root: string, stage = 'chunk-plan'): Promise<Manifest> {
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const { validateContract } = await import('@sargas-recap/contracts');
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  } catch {
    throw new JobError('JOB_INVALID_INPUT', 'could not read manifest.json of the session package');
  }
  const result = validateContract('manifest', value);
  if (!result.ok) throw new JobError('JOB_INVALID_INPUT', 'manifest.json does not validate');
  const manifest = value as Manifest;
  if (manifest.seal === undefined || manifest.lifecycle === 'audio-purged') {
    throw new JobError(
      'JOB_INVALID_INPUT',
      `stage ${stage} needs a sealed package with its audio (lifecycle is ${manifest.lifecycle})`,
      { hint: `seal the package first; ${stage} is impossible after the audio is purged` },
    );
  }
  return manifest;
}

export async function readFragments(root: string): Promise<Fragment[]> {
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const { validateContract } = await import('@sargas-recap/contracts');
  const text = await readFile(path.join(root, 'fragments.jsonl'), 'utf8');
  const fragments: Fragment[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new StageError(
        'fragments-invalid',
        `fragments.jsonl line ${String(index + 1)}: bad JSON`,
      );
    }
    if (!validateContract('fragment', value).ok) {
      throw new StageError(
        'fragments-invalid',
        `fragments.jsonl line ${String(index + 1)} does not validate`,
      );
    }
    fragments.push(value as Fragment);
  }
  return fragments;
}

async function stageJobInputs(
  ctx: InputContext,
  resolveFfmpeg: () => Promise<ResolvedTool>,
): Promise<JobInput[]> {
  const root = requireSessionDir(ctx);
  const { contentHash } = await import('../config/index.ts');
  const { CHUNK_PLANNER_VERSION } = await import('./chunk-plan.ts');
  const { isAudioToolError } = await import('../audio/index.ts');
  const manifest = await readSealedManifest(root);
  const artifacts = manifest.seal?.artifacts ?? [];
  const index = artifacts.find((a) => a.kind === 'fragments-index');
  if (index === undefined) {
    throw new JobError('JOB_INVALID_INPUT', 'the package seal does not list fragments.jsonl');
  }
  const audio = artifacts
    .filter((a) => a.kind === 'audio-fragment')
    .map((a) => ({ path: a.path, hash: a.hash }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  let ffmpeg: ResolvedTool;
  try {
    ffmpeg = await resolveFfmpeg();
  } catch (error) {
    if (isAudioToolError(error)) {
      throw new JobError('JOB_INVALID_INPUT', error.message, {
        ...(error.hint === undefined ? {} : { hint: error.hint }),
      });
    }
    throw error;
  }
  return [
    artifactInput(index.path, index.hash),
    artifactInput('audio', contentHash(audio)),
    {
      kind: 'config',
      ref: 'chunk-plan-params',
      hash: contentHash({
        planner_version: CHUNK_PLANNER_VERSION,
        params: await loadParams(ctx),
      }),
    },
    // ffmpeg's silence output can change between releases, and with it the boundaries.
    { kind: 'config', ref: 'tool:ffmpeg', hash: contentHash({ version: ffmpeg.version.raw }) },
  ];
}

/** Fields the plan summary logs. Counts and durations only, never content. */
const LOG_FIELDS = [
  'chunks',
  'speakers',
  'excludedFragments',
  'removedPauses',
  'overMaxChunks',
  'underMinChunks',
];

export function createChunkPlanStage(options: ChunkPlanStageOptions = {}): StageDefinition {
  const resolveFfmpeg = options.resolveFfmpeg ?? defaultResolveFfmpeg;
  return {
    name: 'chunk-plan',
    inputs: (ctx) => stageJobInputs(ctx, resolveFfmpeg),
    run: async (ctx) => {
      const root = requireSessionDir(ctx);
      const {
        validatePackage,
        formatIssue,
        writeFileAtomic,
        resolveInsidePackage,
        realPackageRoot,
      } = await import('../package/index.ts');
      const { planChunks, serializeChunkPlan } = await import('./chunk-plan.ts');
      const { isChunkPlanError } = await import('./errors.ts');
      const { isAudioToolError } = await import('../audio/index.ts');
      const { mkdir } = await import('node:fs/promises');
      const path = await import('node:path');

      const report = await validatePackage(root);
      if (!report.ok || report.lifecycle === 'capturing' || report.lifecycle === 'audio-purged') {
        const first = report.issues[0];
        throw new StageError(
          'package-invalid',
          first === undefined
            ? `the package cannot be planned in lifecycle ${String(report.lifecycle)}`
            : `the package does not validate: ${formatIssue(first)}`,
        );
      }

      const params = await loadParams(ctx);
      const fragments = await readFragments(root);
      let plan: ChunkPlan;
      try {
        const ffmpeg = options.detect === undefined ? await resolveFfmpeg() : undefined;
        const pauses = await detectFragmentPauses(root, fragments, params, {
          ffmpeg,
          signal: ctx.signal,
          detect: options.detect,
        });
        plan = planChunks({ fragments, pauses, params });
      } catch (error) {
        if (isAudioToolError(error)) {
          throw new StageError('silence-detection-failed', error.message, { cause: error });
        }
        if (isChunkPlanError(error)) {
          throw new StageError('chunk-plan-failed', error.message, { cause: error });
        }
        throw error;
      }

      const rel = chunkPlanPath(plan.plan_hash);
      const target = await resolveInsidePackage(await realPackageRoot(root), rel);
      await mkdir(path.dirname(target.absolute), { recursive: true });
      await writeFileAtomic(target.absolute, serializeChunkPlan(plan));

      ctx.logger.child(LOG_FIELDS).info('chunk-plan.written', {
        stage: 'chunk-plan',
        count: fragments.length,
        chunks: plan.chunks.length,
        speakers: new Set(plan.chunks.map((chunk) => chunk.speaker_id)).size,
        excludedFragments: plan.excluded_fragments.length,
        removedPauses: plan.pauses.filter((p) => p.disposition === 'removed').length,
        overMaxChunks: plan.chunks.filter((c) => c.flags.includes('over_max')).length,
        underMinChunks: plan.chunks.filter((c) => c.flags.includes('under_min')).length,
      });
      return { outputs: [{ path: rel, hash: plan.plan_hash }] };
    },
  };
}
