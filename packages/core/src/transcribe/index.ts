/**
 * Transcribe: per-speaker chunk planning with reversible chunk-to-source maps (T08) and the local
 * whisper.cpp runner with immutable transcription runs (T09).
 */
export const MODULE_NAME = 'transcribe';

export {
  assertChunkPlanConsistent,
  CHUNK_PLANNER_VERSION,
  hashChunkPlan,
  msToSample,
  parseChunkPlan,
  planChunks,
  PROVISIONAL_CHUNK_PLAN_DEFAULTS,
  resolveChunkPlanParams,
  sampleToMs,
  serializeChunkPlan,
  type ChunkPlanInput,
} from './chunk-plan.ts';
export {
  chunkToSource,
  fragmentToChunk,
  mapChunkInterval,
  type ChunkEdge,
  type ChunkIntervalMapping,
  type ChunkTimeMapping,
  type FragmentTimeLocation,
  type SourceSpan,
} from './chunk-map.ts';
export {
  CHUNK_PLAN_DIR,
  chunkPlanJobInput,
  chunkPlanPath,
  createChunkPlanStage,
  detectFragmentPauses,
  type ChunkPlanStageOptions,
  type DetectFragmentPausesOptions,
  type DetectPauses,
} from './chunk-plan-stage.ts';
export { ChunkPlanError, isChunkPlanError, type ChunkPlanErrorCode } from './errors.ts';
export {
  ASR_RUNNER_VERSION,
  PROVISIONAL_ASR_DEFAULTS,
  resolveAsrParams,
  whisperLanguage,
} from './asr-params.ts';
export { buildChunkSegments, flagRepetitionLoops, normalizeTimings } from './segments.ts';
export { findRepetitionLoops, wordsOf, type RepetitionParams } from './repetition.ts';
export { parseWhisperJson, WhisperOutputError, type WhisperOutput } from './whisper-json.ts';
export {
  buildWhisperPrompt,
  planPromptDelivery,
  type PromptDelivery,
  type WhisperPrompt,
} from './whisper-prompt.ts';
export { whisperArgs } from './whisper-process.ts';
export {
  ASR_GLOSSARY_RECEIPT,
  createTranscribeStage,
  type TranscribeStageOptions,
} from './transcribe-stage.ts';
export {
  registerRetranscribeCommand,
  retranscribe,
  type RetranscribeOptions,
  type RetranscribeResult,
} from './retranscribe.ts';
