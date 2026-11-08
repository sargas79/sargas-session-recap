import { Type, type Static } from '@sinclair/typebox';
import {
  Count,
  FragmentId,
  Hash,
  Language,
  Ms,
  SchemaVersion1,
  SegmentId,
  SessionOffsetMs,
  SpeakerId,
  StringEnum,
  Text,
  Ulid,
} from '../common.ts';

export const SEGMENT_FLAGS = [
  'short',
  'low_confidence',
  'overlap',
  'timestamp_clamped',
  'repetition_loop',
] as const;

/** Piece of source audio a segment came from (piecewise chunk-to-source map, ADR-003). */
const SourceSpan = Type.Object(
  {
    fragment_id: FragmentId(),
    start_sample: Count(),
    end_sample: Count({ description: 'Exclusive.' }),
  },
  { additionalProperties: false },
);

/**
 * One line of `transcript/<transcription_run_id>/segments.jsonl`. Immutable once written (ADR-001).
 * Owns original text, timing and speaker. Labels and corrections live in classification results.
 */
export const TranscriptionSegmentSchema = Type.Object(
  {
    schema_version: SchemaVersion1,
    transcription_run_id: Ulid(),
    segment_id: SegmentId(),
    chunk_index: Count(),
    seq: Count({ description: 'n-th segment within the chunk.' }),
    speaker_id: SpeakerId(),
    language: Language(),
    text_original: Text({ description: 'ASR output, never modified (ADR-001).' }),
    text_hash: Hash({ description: 'sha256 of UTF-8 NFC text_original (ADR-005).' }),
    start_offset_ms: SessionOffsetMs(),
    end_offset_ms: SessionOffsetMs(),
    timing_uncertainty_ms: Ms(),
    chunk_start_ms: Ms({ description: 'Start within the chunk audio, as reported by ASR.' }),
    chunk_end_ms: Ms(),
    source_spans: Type.Array(SourceSpan, { minItems: 1 }),
    confidence_permille: Type.Optional(
      Type.Integer({ minimum: 0, maximum: 1000, description: 'ASR confidence x1000 (no floats).' }),
    ),
    flags: Type.Array(StringEnum(SEGMENT_FLAGS), { uniqueItems: true }),
  },
  { additionalProperties: false },
);
export type TranscriptionSegment = Static<typeof TranscriptionSegmentSchema>;
