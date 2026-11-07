import { Type, type Static } from '@sinclair/typebox';
import {
  Count,
  EventId,
  Label,
  SchemaVersion1,
  SegmentId,
  Slug,
  StringEnum,
  Text,
  Ulid,
  when,
} from '../common.ts';

export const CLASSIFICATION_FLAGS = [
  'names_unmatched',
  'event_context_used',
  'low_asr_confidence',
  'possible_spoiler',
] as const;

const Correction = Type.Object(
  {
    kind: StringEnum(['name', 'term', 'spelling'] as const),
    from: Type.String({ minLength: 1, maxLength: 200 }),
    to: Type.String({ minLength: 1, maxLength: 200 }),
    glossary_id: Type.Optional(Slug({ description: 'Glossary entry that justified it (T04).' })),
  },
  { additionalProperties: false },
);

/**
 * One line of `classify/<classification_run_id>/results.jsonl` (ADR-001). Owns labels, corrections
 * and flags for exactly one segment of exactly one transcription run. Never alters text_original.
 */
export const ClassificationResultSchema = Type.Object(
  {
    schema_version: SchemaVersion1,
    classification_run_id: Ulid(),
    transcription_run_id: Ulid({ description: 'Input run; must prefix segment_id (ADR-004).' }),
    segment_id: SegmentId(),
    window_index: Count(),
    label: Label(),
    review_required: Type.Boolean({ description: 'Always true for mixed and uncertain.' }),
    text_corrected: Type.Optional(Text({ description: 'text_original with corrections applied.' })),
    corrections: Type.Array(Correction),
    event_ids: Type.Array(EventId(), {
      uniqueItems: true,
      description: 'Foundry events used as evidence; only with verified alignment (T18).',
    }),
    flags: Type.Array(StringEnum(CLASSIFICATION_FLAGS), { uniqueItems: true }),
  },
  {
    additionalProperties: false,
    allOf: [
      when('label', ['mixed', 'uncertain'], {
        properties: { review_required: { const: true } },
      }),
    ],
  },
);
export type ClassificationResult = Static<typeof ClassificationResultSchema>;
