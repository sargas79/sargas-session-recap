/**
 * Transcribe: per-speaker chunk planning with reversible chunk-to-source maps (T08). The local
 * Whisper runner arrives with T09.
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
