export type ChunkPlanErrorCode =
  /** A planning parameter is out of range or the parameters contradict each other. */
  | 'CHUNK_PLAN_INVALID_PARAMS'
  /** A fragment or pause list given to the planner is malformed. */
  | 'CHUNK_PLAN_INVALID_INPUT'
  /** A stored plan does not validate or its fields disagree with each other. */
  | 'CHUNK_PLAN_INVALID'
  /** A time given to the mapper lies outside the chunk or fragment. */
  | 'CHUNK_TIME_OUT_OF_RANGE';

/** Error raised by chunk planning and mapping. Messages carry IDs and numbers, never content. */
export class ChunkPlanError extends Error {
  readonly code: ChunkPlanErrorCode;

  constructor(code: ChunkPlanErrorCode, message: string) {
    super(message);
    this.name = 'ChunkPlanError';
    this.code = code;
  }
}

export function isChunkPlanError(value: unknown): value is ChunkPlanError {
  return value instanceof ChunkPlanError;
}
