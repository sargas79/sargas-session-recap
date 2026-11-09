import { Type, type Static } from '@sinclair/typebox';
import {
  CampaignId,
  Hash,
  LABELS,
  type ClassificationLabel,
  SchemaVersion1,
  SegmentId,
  SessionId,
  StringEnum,
  Text,
  Timestamp,
  Ulid,
} from '../common.ts';
import { CLASSIFICATION_FLAGS, CorrectionSchema } from './classification-result.ts';
import { EffectiveSegment } from './effective-transcript.ts';
import { EXCLUSION_REASONS } from './review-override.ts';
import { SEGMENT_FLAGS } from './transcription-segment.ts';

export const UNATTACHED_REASONS = ['run_changed', 'segment_missing', 'text_changed'] as const;

const ReviewSegment = Type.Object(
  {
    ...EffectiveSegment.properties,
    text_original: Text({ description: 'ASR text, always reachable from the effective view.' }),
    text_hash: Hash(),
    text_corrected: Type.Optional(Text({ description: 'Classification corrections applied.' })),
    text_override: Type.Optional(Text({ description: 'Cleaned text from the GM.' })),
    corrections: Type.Array(CorrectionSchema, { description: 'What text_corrected changed.' }),
    classification_label: Type.Unsafe<ClassificationLabel | null>({
      enum: [...LABELS, null],
      description: 'Label before any override; null: not classified yet.',
    }),
    segment_flags: Type.Array(StringEnum(SEGMENT_FLAGS), { uniqueItems: true }),
    classification_flags: Type.Array(StringEnum(CLASSIFICATION_FLAGS), { uniqueItems: true }),
    confidence_permille: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000 })),
    override_id: Type.Optional(Ulid({ description: 'The override attached to this segment.' })),
  },
  { additionalProperties: false },
);

/**
 * What the GM reviews: the `effective-transcript` projection plus where each value came from, so
 * nothing hides behind the effective text. Derived and never authoritative (ADR-001, ADR-011).
 */
export const EffectiveTranscriptReviewSchema = Type.Object(
  {
    schema_version: SchemaVersion1,
    campaign_id: CampaignId(),
    session_id: SessionId(),
    transcription_run_id: Ulid(),
    classification_run_id: Type.Union([Ulid(), Type.Null()]),
    generated_at: Timestamp(),
    segments: Type.Array(ReviewSegment),
    needs_reconciliation: Type.Array(
      Type.Object(
        {
          override_id: Ulid(),
          transcription_run_id: Ulid({ description: 'The run the override was made on.' }),
          segment_id: SegmentId(),
          reason: StringEnum(UNATTACHED_REASONS),
          exclusion_reasons: Type.Array(StringEnum(EXCLUSION_REASONS), { uniqueItems: true }),
        },
        { additionalProperties: false },
      ),
      { description: 'Overrides not applied because their identity did not match (ADR-005).' },
    ),
  },
  { additionalProperties: false },
);
export type EffectiveTranscriptReview = Static<typeof EffectiveTranscriptReviewSchema>;
