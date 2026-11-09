/**
 * The `transcribe` job stage (T09): runs whisper.cpp on each chunk of the plan and writes an
 * immutable `transcript/<transcription_run_id>/segments.jsonl`. Consent is checked by the job
 * runner for the whole run (`provider`) and again before every whisper call.
 *
 * The body loads on first use, so that registering the stage keeps the CLI start fast.
 */
import type { ResolvedTool } from '../audio/index.ts';
import { requireConfig, type StageDefinition } from '../jobs/stage.ts';
import type { JobInput } from '../jobs/store.ts';
import type { WhisperTools } from '../tools/inspect.ts';

export const ASR_GLOSSARY_RECEIPT: Pick<JobInput, 'kind' | 'ref'> = {
  kind: 'glossary',
  ref: 'asr-prompt',
};

/** Test seams. Production code passes none of these. */
export interface TranscribeStageOptions {
  /** Replaces the T23 lock check. */
  readonly resolveTools?: (() => Promise<WhisperTools>) | undefined;
  readonly resolveFfmpeg?: (() => Promise<ResolvedTool>) | undefined;
  /** Replaces ffmpeg's decoding of a fragment to 16 kHz mono PCM WAV. */
  readonly decode?:
    ((source: string, target: string, signal: AbortSignal) => Promise<void>) | undefined;
  /** Arguments placed before whisper's own, to run a script as the executable. */
  readonly whisperPrefixArgs?: readonly string[] | undefined;
  /** Defaults to `process.platform` (how an accented prompt reaches whisper differs on Windows). */
  readonly platform?: NodeJS.Platform | undefined;
  readonly now?: (() => Date) | undefined;
}

export function createTranscribeStage(options: TranscribeStageOptions = {}): StageDefinition {
  return {
    name: 'transcribe',
    upstream: ['chunk-plan'],
    provider: {
      purpose: 'asr',
      speakerIds: async (ctx) => (await import('./transcribe-run.ts')).planSpeakers(ctx),
    },
    inputs: async (ctx) => (await import('./transcribe-run.ts')).transcribeInputs(ctx, options),
    // The glossary a run used is on record, and a later edit never rewrites that record.
    receipts: (ctx) => [
      {
        ...ASR_GLOSSARY_RECEIPT,
        hash: requireConfig(ctx, 'transcribe').version.stage_hashes.asr,
      },
    ],
    run: async (ctx) => (await import('./transcribe-run.ts')).runTranscribe(ctx, options),
  };
}
