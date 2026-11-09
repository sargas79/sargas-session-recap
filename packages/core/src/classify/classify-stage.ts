/**
 * The `classify` job stage (T11): turns one transcription run into an immutable
 * `classify/<classification_run_id>/` directory. It reads only the transcript, so it also runs on a
 * package whose audio was purged (ADR-006). The body loads on first use, to keep the CLI start fast.
 */
import type { StageDefinition } from '../jobs/stage.ts';
import type { LlmBackendOptions } from '../llm/index.ts';
import type { PromptRegistry } from '../prompts/index.ts';
import type { WindowParams } from './windows.ts';

/** Test seams. Production code passes none of these. */
export interface ClassifyStageOptions {
  readonly prompts?: PromptRegistry | undefined;
  readonly windowParams?: WindowParams | undefined;
  /** Merged over the backend options, for example a fake `claude` executable. */
  readonly llm?: Partial<LlmBackendOptions> | undefined;
  readonly now?: (() => Date) | undefined;
}

export function createClassifyStage(options: ClassifyStageOptions = {}): StageDefinition {
  return {
    name: 'classify',
    upstream: ['transcribe'],
    provider: {
      purpose: 'classification',
      speakerIds: async (ctx) => (await import('./classify-run.ts')).transcriptSpeakers(ctx),
    },
    inputs: async (ctx) => (await import('./classify-run.ts')).classifyInputs(ctx, options),
    run: async (ctx) => (await import('./classify-run.ts')).runClassify(ctx, options),
  };
}
