import { Type, type Static } from '@sinclair/typebox';
import { SchemaVersion1, SegmentId, StringEnum, Ulid } from '../common.ts';
import { CorrectionSchema } from './classification-result.ts';

/** Why core refused a correction the model proposed. */
export const CORRECTION_REJECTIONS = [
  'source-not-in-text',
  'unknown-glossary-entry',
  'glossary-mismatch',
  'no-change',
  'overlap',
] as const;
export type CorrectionRejection = (typeof CORRECTION_REJECTIONS)[number];

const Fixed = Type.Object(
  { segment_id: SegmentId(), ...CorrectionSchema.properties },
  { additionalProperties: false },
);

const Unmatched = Type.Object(
  { segment_id: SegmentId(), name: Type.String({ minLength: 1, maxLength: 120 }) },
  { additionalProperties: false },
);

const Rejected = Type.Object(
  {
    segment_id: SegmentId(),
    ...CorrectionSchema.properties,
    reason: StringEnum(CORRECTION_REJECTIONS),
  },
  { additionalProperties: false },
);

/**
 * `classify/<classification_run_id>/corrections-report.json` (T11). `fixed` repeats what the
 * results hold, for reading in one place; `unmatched` and `rejected` exist only here (ADR-001).
 * Holds words from the transcript, so it stays in the session package and is never logged.
 */
export const ClassificationCorrectionsReportSchema = Type.Object(
  {
    schema_version: SchemaVersion1,
    classification_run_id: Ulid(),
    transcription_run_id: Ulid(),
    fixed: Type.Array(Fixed),
    unmatched: Type.Array(Unmatched),
    rejected: Type.Array(Rejected),
  },
  { additionalProperties: false },
);
export type ClassificationCorrectionsReport = Static<typeof ClassificationCorrectionsReportSchema>;
