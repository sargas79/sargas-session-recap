import { Type, type Static } from '@sinclair/typebox';
import {
  CampaignId,
  Count,
  Hash,
  Label,
  SchemaVersion1,
  SegmentId,
  SessionId,
  StringEnum,
  Text,
  Timestamp,
  Ulid,
} from '../common.ts';

export const RECAP_INCLUSION = ['include', 'exclude', 'unresolved'] as const;
export const EXCLUSION_REASONS = ['spoiler', 'privacy', 'off-topic'] as const;
export const RECONCILIATION_STATES = ['attached', 'needs_reconciliation'] as const;

/**
 * A GM review override: one row of SQLite `review_overrides` (T12), authoritative there only
 * (ADR-001). Identity is (transcription_run_id, segment_id, base_text_hash) (ADR-005).
 */
export const ReviewOverrideSchema = Type.Object(
  {
    schema_version: SchemaVersion1,
    override_id: Ulid(),
    campaign_id: CampaignId(),
    session_id: SessionId(),
    transcription_run_id: Ulid(),
    segment_id: SegmentId(),
    base_text_hash: Hash({ description: 'text_hash of the segment when the override was made.' }),
    label_override: Type.Optional(Label()),
    recap_inclusion: StringEnum(RECAP_INCLUSION),
    text_override: Type.Optional(Text({ description: 'Cleaned text, e.g. IC part of mixed.' })),
    exclusion_reasons: Type.Array(StringEnum(EXCLUSION_REASONS), { uniqueItems: true }),
    review_status: StringEnum(['pending', 'reviewed'] as const),
    reconciliation: StringEnum(RECONCILIATION_STATES, {
      description:
        'needs_reconciliation: identity no longer matches; never auto-applied (ADR-005).',
    }),
    supersedes_override_id: Type.Optional(
      Ulid({ description: 'Override this one replaces after an explicit reconciliation.' }),
    ),
    revision: Count({ description: 'Row history counter; each change appends history (T12).' }),
    created_at: Timestamp(),
    updated_at: Timestamp(),
  },
  { additionalProperties: false },
);
export type ReviewOverride = Static<typeof ReviewOverrideSchema>;
