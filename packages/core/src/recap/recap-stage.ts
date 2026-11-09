/**
 * The `recap` job stage (T13): writes one immutable `recap/<revision>/` directory from the
 * effective transcript. It never publishes: a draft goes to the GM's review (T14, T15). The body
 * loads on first use, to keep the CLI start fast.
 */
import type { StageDefinition } from '../jobs/stage.ts';
import type { LlmBackendOptions } from '../llm/index.ts';
import type { PromptRegistry } from '../prompts/index.ts';

/** Test seams. Production code passes none of these. */
export interface RecapStageOptions {
  readonly prompts?: PromptRegistry | undefined;
  /** Merged over the backend options, for example a fake `claude` executable. */
  readonly llm?: Partial<LlmBackendOptions> | undefined;
  readonly now?: (() => Date) | undefined;
}

export function createRecapStage(options: RecapStageOptions = {}): StageDefinition {
  return {
    name: 'recap',
    upstream: ['classify'],
    provider: {
      purpose: 'recap',
      speakerIds: async (ctx) => (await import('./recap-run.ts')).recapSpeakers(ctx, options),
    },
    inputs: async (ctx) => (await import('./recap-run.ts')).recapInputs(ctx, options),
    receipts: async (ctx) => (await import('./recap-run.ts')).recapReceipts(ctx, options),
    run: async (ctx) => (await import('./recap-run.ts')).runRecap(ctx, options),
  };
}
