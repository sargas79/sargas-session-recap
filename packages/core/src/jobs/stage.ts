/**
 * Stage runner abstraction (T07). A stage declares a name, its upstream stages, its inputs (hash
 * providers), optionally the AI provider it calls, and a `run(ctx)` function. The runner decides
 * whether the stage is up to date from the input hashes, runs it as a job and records the result.
 *
 * Real stages arrive with T08+; tests use synthetic stages.
 */
import type { CampaignConfig, ConsentPurpose, Glossary } from '@sargas-recap/contracts';
import type { ConfigVersion, ConsentReceipt, DependencyStage } from '../config/index.ts';
import type { Logger } from '../log/index.ts';
import type { DataPaths } from '../paths/index.ts';
import { JobError } from './errors.ts';
import { isJobStage, type JobStage } from './state.ts';
import type { JobInput, JobOutput, JobUsage } from './store.ts';

/** Validated campaign config and glossary for a run, with their versions (T04). */
export interface RunConfig {
  readonly campaign: CampaignConfig;
  readonly glossary: Glossary;
  readonly version: ConfigVersion;
}

/** What an upstream stage produced: its latest succeeded job. */
export interface UpstreamResult {
  readonly jobId: string;
  readonly outputs: readonly JobOutput[];
  readonly outputRunId: string | undefined;
  readonly outputRecapRevision: number | undefined;
}

/** Context for computing a stage's inputs (before deciding whether it must run). */
export interface InputContext {
  readonly campaignId: string;
  readonly sessionId: string;
  readonly paths: DataPaths | undefined;
  /** Session package directory, when the run has a data root. */
  readonly sessionDir: string | undefined;
  readonly config: RunConfig | undefined;
  readonly upstream: ReadonlyMap<JobStage, UpstreamResult>;
}

export interface RecoveredFrom {
  /** The interrupted job this run replaces. */
  readonly jobId: string;
  readonly attempt: number;
}

export interface StageContext extends InputContext {
  readonly jobId: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  /** Aborted on Ctrl+C, on cancellation by the caller, or when the session lock is lost. */
  readonly signal: AbortSignal;
  /** Dependency inputs recorded on this job. */
  readonly inputs: readonly JobInput[];
  /** Set when this job re-runs a job interrupted by a crash; a stage may resume from its outputs. */
  readonly recoveredFrom: RecoveredFrom | undefined;
  /** The `assertConsent` receipt, for stages that declare a provider. */
  readonly consent: ConsentReceipt | undefined;
  readonly logger: Logger;
}

export interface StageResult {
  readonly outputs?: readonly JobOutput[] | undefined;
  readonly outputRunId?: string | undefined;
  readonly outputRecapRevision?: number | undefined;
  readonly usage?: JobUsage | undefined;
}

/** Bounded retry with exponential backoff (`baseDelayMs * 2^(attempt-1)`, capped). */
export interface RetryPolicy {
  /** Total attempts including the first (1-100). */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
});

/** Delay before attempt `attempt + 1`. */
export function backoffDelay(policy: RetryPolicy, attempt: number): number {
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
}

/** A stage that sends speaker data to an AI provider. The runner calls `assertConsent` first. */
export interface StageProvider {
  /** Consent purpose; the provider is the one configured for it in campaign.yaml. */
  readonly purpose: Exclude<ConsentPurpose, 'recording'>;
  /** Every speaker whose audio or text the stage sends. */
  speakerIds(ctx: InputContext): readonly string[] | Promise<readonly string[]>;
}

export interface StageDefinition {
  readonly name: JobStage;
  /** Stages whose latest succeeded outputs this one consumes (they become artifact inputs). */
  readonly upstream?: readonly JobStage[] | undefined;
  /** Hash providers: config stage hashes, prompts (T26), models, source artifacts... */
  inputs?(ctx: InputContext): readonly JobInput[] | Promise<readonly JobInput[]>;
  readonly provider?: StageProvider | undefined;
  readonly retry?: Partial<RetryPolicy> | undefined;
  run(ctx: StageContext): Promise<StageResult | undefined> | StageResult | undefined;
}

/** Registered stages by name, validated (known names, no duplicates, no cycles). */
export type StageRegistry = ReadonlyMap<JobStage, StageDefinition>;

export function defineStages(stages: readonly StageDefinition[]): StageRegistry {
  const registry = new Map<JobStage, StageDefinition>();
  for (const stage of stages) {
    if (!isJobStage(stage.name)) {
      throw new JobError(
        'JOB_STAGE_GRAPH_INVALID',
        `stage name ${JSON.stringify(stage.name)} is not a job-record stage`,
      );
    }
    if (registry.has(stage.name)) {
      throw new JobError('JOB_STAGE_GRAPH_INVALID', `stage ${stage.name} is registered twice`);
    }
    registry.set(stage.name, stage);
  }
  for (const stage of registry.values()) planStages(registry, stage.name);
  return registry;
}

/** The target stage and all its upstream stages, upstream first (deterministic DFS order). */
export function planStages(registry: StageRegistry, target: string): StageDefinition[] {
  const start = isJobStage(target) ? registry.get(target) : undefined;
  if (start === undefined) {
    const known = [...registry.keys()];
    throw new JobError('JOB_UNKNOWN_STAGE', `unknown stage ${JSON.stringify(target)}`, {
      hint:
        known.length === 0
          ? 'no stages are registered in this version of recap yet'
          : `registered stages: ${known.join(', ')}`,
    });
  }
  const order: StageDefinition[] = [];
  const state = new Map<JobStage, 'visiting' | 'done'>();
  const visit = (stage: StageDefinition, chain: readonly JobStage[]): void => {
    const seen = state.get(stage.name);
    if (seen === 'done') return;
    if (seen === 'visiting') {
      throw new JobError(
        'JOB_STAGE_GRAPH_INVALID',
        `stage graph has a cycle: ${[...chain, stage.name].join(' -> ')}`,
      );
    }
    state.set(stage.name, 'visiting');
    for (const name of stage.upstream ?? []) {
      const up = registry.get(name);
      if (up === undefined) {
        throw new JobError(
          'JOB_STAGE_GRAPH_INVALID',
          `stage ${stage.name} depends on ${name}, which is not registered`,
        );
      }
      visit(up, [...chain, stage.name]);
    }
    state.set(stage.name, 'done');
    order.push(stage);
  };
  visit(start, []);
  return order;
}

/** The run's config, or `JOB_CONFIG_REQUIRED` naming the stage that needs it. */
export function requireConfig(ctx: Pick<InputContext, 'config'>, stage: string): RunConfig {
  if (ctx.config === undefined) {
    throw new JobError('JOB_CONFIG_REQUIRED', `stage ${stage} needs the campaign config`, {
      hint: 'pass --config <campaign.yaml> and --glossary <glossary.yaml>',
    });
  }
  return ctx.config;
}

/**
 * The per-stage config dependency hash (T04 `configVersion().stage_hashes`) as a job input.
 * Only the fields that stage consumes are covered, so unrelated config edits invalidate nothing.
 */
export function configInput(config: RunConfig, dependency: DependencyStage): JobInput {
  return {
    kind: 'config',
    ref: `stage-deps:${dependency}`,
    hash: config.version.stage_hashes[dependency],
  };
}

/**
 * Stages that call an LLM with a versioned prompt (T26). Each of their jobs must declare at least one
 * `prompt` dependency input (`promptJobInput` from the prompt registry), so every classification and
 * recap run record names the prompt id, version and hash it used.
 */
export const PROMPT_JOB_STAGES: readonly JobStage[] = ['classify', 'recap'];

/** A prompt as a job input (T26 registry): `<id>@v<version>` with its normalized content hash. */
export function promptInput(id: string, version: number, hash: string): JobInput {
  return { kind: 'prompt', ref: `${id}@v${String(version)}`, hash };
}

/** A model (ASR or LLM) as a job input: its ID and a hash of the model file or version string. */
export function modelInput(modelId: string, hash: string): JobInput {
  return { kind: 'model', ref: modelId, hash };
}

/** A package artifact as a job input. */
export function artifactInput(relPath: string, hash: string): JobInput {
  return { kind: 'artifact', ref: relPath, hash };
}
