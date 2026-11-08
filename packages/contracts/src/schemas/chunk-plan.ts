import { Type, type Static } from '@sinclair/typebox';
import {
  Count,
  FragmentId,
  Hash,
  Ms,
  SchemaVersion1,
  SessionOffsetMs,
  SpeakerId,
  StringEnum,
} from '../common.ts';

/**
 * Chunk planning parameters (T08). S04 did not decide a chunking strategy and did not measure
 * drift or chunk boundaries on real audio, so every default for these fields is provisional.
 */
export const ChunkPlanParamsSchema = Type.Object(
  {
    target_chunk_ms: Ms({ minimum: 1, description: 'Preferred chunk duration.' }),
    max_chunk_ms: Ms({
      minimum: 1,
      description: 'Upper limit when a pause allows it. Speech is never cut to honor it.',
    }),
    min_chunk_ms: Ms({
      description: 'Prefer chunks at least this long. Shorter chunks are flagged, never dropped.',
    }),
    remove_pause_min_ms: Ms({
      minimum: 1,
      description: 'Pauses at least this long are removed from chunk audio; shorter ones are kept.',
    }),
    removal_padding_ms: Ms({
      description: 'Audio kept on each speech side of a removed pause, so word edges are not cut.',
    }),
    silence_threshold_db: Type.Integer({
      minimum: -200,
      maximum: 0,
      description: 'ffmpeg silencedetect noise level, in dBFS.',
    }),
    min_silence_ms: Ms({ minimum: 1, description: 'ffmpeg silencedetect minimum duration.' }),
  },
  { additionalProperties: false },
);
export type ChunkPlanParams = Static<typeof ChunkPlanParamsSchema>;

/** `chunking:` in campaign.yaml: any subset of the parameters, the rest keep their defaults. */
export const ChunkingConfigSchema = Type.Partial(ChunkPlanParamsSchema, {
  additionalProperties: false,
  description:
    'Chunk planning overrides (T08). The built-in defaults are provisional: S04 did not validate them on real audio.',
});
export type ChunkingConfig = Static<typeof ChunkingConfigSchema>;

export const CHUNK_FLAGS = ['over_max', 'under_min'] as const;
export const PAUSE_DISPOSITIONS = ['preserved', 'removed'] as const;
export const FRAGMENT_EXCLUSION_REASONS = ['empty', 'all_silence'] as const;

/**
 * One contiguous run of one fragment inside a chunk (piecewise map, ADR-003). Chunk time
 * `[chunk_start_ms, chunk_start_ms + duration_ms)` maps one to one onto fragment time starting at
 * `fragment_start_ms` and session time starting at `session_start_offset_ms`.
 */
const ChunkPiece = Type.Object(
  {
    chunk_start_ms: Ms(),
    duration_ms: Ms({ minimum: 1 }),
    fragment_id: FragmentId(),
    sample_rate_hz: Type.Integer({ minimum: 8000, maximum: 192_000 }),
    fragment_start_sample: Count(),
    sample_length: Count({ minimum: 1 }),
    fragment_start_ms: Ms({ description: 'floor(fragment_start_sample * 1000 / sample_rate_hz).' }),
    session_start_offset_ms: SessionOffsetMs(),
    timing_uncertainty_ms: Ms({ description: 'Uncertainty of the source fragment.' }),
  },
  { additionalProperties: false },
);

/**
 * `chunk-plans/<hash>.json`: how each speaker's fragments are cut and joined into chunks for ASR
 * (T08). Derived from `fragments.jsonl`, the audio and the parameters; identical inputs give an
 * identical plan.
 */
export const ChunkPlanSchema = Type.Object(
  {
    schema_version: SchemaVersion1,
    plan_hash: Hash({ description: 'sha256 of the canonical JSON of this record without it.' }),
    planner_version: Type.Integer({ minimum: 1, description: 'Bumped on any planning change.' }),
    params: ChunkPlanParamsSchema,
    chunks: Type.Array(
      Type.Object(
        {
          chunk_index: Count({ description: 'Position in `chunks`.' }),
          speaker_id: SpeakerId(),
          duration_ms: Ms({ minimum: 1 }),
          flags: Type.Array(StringEnum(CHUNK_FLAGS), { uniqueItems: true }),
          pieces: Type.Array(ChunkPiece, { minItems: 1 }),
        },
        { additionalProperties: false },
      ),
    ),
    pauses: Type.Array(
      Type.Object(
        {
          fragment_id: FragmentId(),
          start_ms: Ms({ description: 'Fragment time.' }),
          end_ms: Ms({ description: 'Fragment time, exclusive.' }),
          disposition: StringEnum(PAUSE_DISPOSITIONS),
        },
        { additionalProperties: false },
      ),
      { description: 'Every detected pause and whether it stays in the chunk audio.' },
    ),
    excluded_fragments: Type.Array(
      Type.Object(
        { fragment_id: FragmentId(), reason: StringEnum(FRAGMENT_EXCLUSION_REASONS) },
        { additionalProperties: false },
      ),
      { description: 'Fragments with no audio to transcribe; nothing else is left out.' },
    ),
  },
  { additionalProperties: false },
);
export type ChunkPlan = Static<typeof ChunkPlanSchema>;
export type ChunkPlanChunk = ChunkPlan['chunks'][number];
export type ChunkPlanPiece = ChunkPlanChunk['pieces'][number];
