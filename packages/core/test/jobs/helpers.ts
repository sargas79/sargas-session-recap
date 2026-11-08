/**
 * Synthetic test stages and helpers for the job runner (T07). No real stage logic: each stage
 * derives its output hash from its inputs, so a changed input propagates exactly like real data.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CampaignConfig, Glossary } from '@sargas-recap/contracts';
import { configVersion } from '../../src/config/index.ts';
import { openStateDatabase, type SqliteDatabase } from '../../src/db/index.ts';
import {
  artifactInput,
  configInput,
  defineStages,
  modelInput,
  requireConfig,
  type JobInput,
  type RunConfig,
  type StageDefinition,
  type StageRegistry,
} from '../../src/jobs/index.ts';
import { createLogger, type Logger } from '../../src/log/index.ts';
import { loadPromptRegistry, promptJobInput } from '../../src/prompts/index.ts';
import { createDataPaths, type DataPaths } from '../../src/paths/index.ts';

export function sha(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

/** Hash of a stage's inputs, used as its synthetic output hash. */
export function digestOf(inputs: readonly JobInput[]): string {
  return sha(
    inputs
      .map((i) => `${i.kind}:${i.ref}=${i.hash}`)
      .sort()
      .join('\n'),
  );
}

export interface Fixture {
  readonly dir: string;
  readonly paths: DataPaths;
  readonly db: SqliteDatabase;
  readonly logLines: string[];
  readonly logger: Logger;
  cleanup(): void;
}

export async function openFixture(): Promise<Fixture> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'recap-jobs-'));
  const paths = createDataPaths(path.join(dir, 'data'));
  const { db } = await openStateDatabase(paths);
  const logLines: string[] = [];
  const logger = createLogger({ level: 'debug', sink: (line) => logLines.push(line) });
  return {
    dir,
    paths,
    db,
    logLines,
    logger,
    cleanup() {
      if (db.open) db.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

export function runConfig(campaign: CampaignConfig, glossary: Glossary): RunConfig {
  return { campaign, glossary, version: configVersion(campaign, glossary) };
}

/** Mutable world the synthetic stages read: change a field to change an input. */
export interface World {
  /** Hash of the sealed source audio (input of `import`). */
  source: string;
  /** Hash of the ASR model (input of `transcribe`, not part of its output). */
  asrModel: string;
  /** Prompt each LLM stage uses (T26), as a job input. Defaults to the shipped prompts. */
  prompts: { classify: JobInput; recap: JobInput };
  /** Number of times each stage's `run` was called. */
  readonly calls: Record<string, number>;
}

export function newWorld(): World {
  const registry = loadPromptRegistry();
  return {
    source: sha('source-v1'),
    asrModel: sha('model-v1'),
    prompts: {
      classify: promptJobInput(registry.latest('classification.window')),
      recap: promptJobInput(registry.latest('recap.draft')),
    },
    calls: {},
  };
}

const SPEAKERS = ['gm', 'player-ana'];

function counted(world: World, name: string): void {
  world.calls[name] = (world.calls[name] ?? 0) + 1;
}

/**
 * import -> transcribe -> classify -> recap. transcribe/classify/recap declare an AI provider
 * and the matching T04 stage dependency hash; classify/recap also declare their prompt (T26). transcribe's output ignores the model hash, so a
 * model change reruns transcribe but not what follows when the output is identical.
 */
export function pipelineStages(
  world: World,
  overrides: Partial<Record<string, Partial<StageDefinition>>> = {},
): StageRegistry {
  const stages: StageDefinition[] = [
    {
      name: 'import',
      inputs: () => [artifactInput('audio/gm/0.flac', world.source)],
      run: (ctx) => {
        counted(world, 'import');
        return { outputs: [{ path: 'fragments.jsonl', hash: digestOf(ctx.inputs) }] };
      },
    },
    {
      name: 'transcribe',
      upstream: ['import'],
      inputs: (ctx) => [
        configInput(requireConfig(ctx, 'transcribe'), 'asr'),
        modelInput('whisper-test', world.asrModel),
      ],
      provider: { purpose: 'asr', speakerIds: () => SPEAKERS },
      run: (ctx) => {
        counted(world, 'transcribe');
        const relevant = ctx.inputs.filter((i) => i.kind !== 'model');
        return {
          outputs: [{ path: 'transcript/segments.jsonl', hash: digestOf(relevant) }],
        };
      },
    },
    {
      name: 'classify',
      upstream: ['transcribe'],
      inputs: (ctx) => [
        configInput(requireConfig(ctx, 'classify'), 'classification'),
        world.prompts.classify,
      ],
      provider: { purpose: 'classification', speakerIds: () => SPEAKERS },
      run: (ctx) => {
        counted(world, 'classify');
        return {
          outputs: [{ path: 'classify/results.jsonl', hash: digestOf(ctx.inputs) }],
          usage: { input_tokens: 1200, output_tokens: 300, cost_micro_usd: 4500 },
        };
      },
    },
    {
      name: 'recap',
      upstream: ['classify'],
      inputs: (ctx) => [configInput(requireConfig(ctx, 'recap'), 'recap'), world.prompts.recap],
      provider: { purpose: 'recap', speakerIds: () => SPEAKERS },
      run: (ctx) => {
        counted(world, 'recap');
        return {
          outputs: [{ path: 'recap/1/recap.json', hash: digestOf(ctx.inputs) }],
          outputRecapRevision: 1,
        };
      },
    },
  ];
  return defineStages(stages.map((s) => ({ ...s, ...overrides[s.name] })));
}

export const noSleep = (): Promise<void> => Promise.resolve();
