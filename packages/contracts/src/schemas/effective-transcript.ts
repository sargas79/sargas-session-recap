import { Type, type Static } from '@sinclair/typebox';
import {
  CampaignId,
  LABELS,
  type ClassificationLabel,
  Ms,
  SchemaVersion1,
  SegmentId,
  SessionId,
  SessionOffsetMs,
  SpeakerId,
  StringEnum,
  Text,
  Timestamp,
  Ulid,
} from '../common.ts';
import { EXCLUSION_REASONS, RECAP_INCLUSION } from './review-override.ts';

const EffectiveSegment = Type.Object(
  {
    segment_id: SegmentId(),
    speaker_id: SpeakerId(),
    start_offset_ms: SessionOffsetMs(),
    end_offset_ms: SessionOffsetMs(),
    timing_uncertainty_ms: Ms(),
    text: Text(),
    text_source: StringEnum(['original', 'corrected', 'override'] as const),
    label: Type.Unsafe<ClassificationLabel | null>({
      enum: [...LABELS, null],
      description: 'Effective label; null: not classified yet.',
    }),
    label_source: StringEnum(['classification', 'override', 'none'] as const),
    recap_inclusion: StringEnum(RECAP_INCLUSION),
    exclusion_reasons: Type.Array(StringEnum(EXCLUSION_REASONS), { uniqueItems: true }),
    review_required: Type.Boolean(),
    review_status: StringEnum(['pending', 'reviewed'] as const),
  },
  { additionalProperties: false },
);

/**
 * Derived projection: segments + one classification run + attached overrides (ADR-001).
 * Never authoritative, never edited; recomputed on demand and may be cached.
 */
export const EffectiveTranscriptSchema = Type.Object(
  {
    schema_version: SchemaVersion1,
    campaign_id: CampaignId(),
    session_id: SessionId(),
    transcription_run_id: Ulid(),
    classification_run_id: Type.Union([Ulid(), Type.Null()], {
      description: 'null: projection built before classification.',
    }),
    generated_at: Timestamp(),
    segments: Type.Array(EffectiveSegment),
    needs_reconciliation: Type.Array(
      Type.Object(
        { override_id: Ulid(), segment_id: SegmentId() },
        { additionalProperties: false },
      ),
      { description: 'Overrides that were not applied because their identity did not match.' },
    ),
  },
  { additionalProperties: false },
);
export type EffectiveTranscript = Static<typeof EffectiveTranscriptSchema>;
