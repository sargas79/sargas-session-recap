import { Type, type Static } from '@sinclair/typebox';
import { Label, SchemaVersion1 } from '../common.ts';
import { CorrectionSchema } from './classification-result.ts';

/** `<chunk_index>:<seq>`: a segment within the one transcription run a window belongs to. */
export const SEGMENT_REF_PATTERN = '^(?:0|[1-9][0-9]*):(?:0|[1-9][0-9]*)$';

export const ClassificationModelResultSchema = Type.Object(
  {
    segment_ref: Type.String({
      pattern: SEGMENT_REF_PATTERN,
      maxLength: 24,
      description: 'The ref of a segment in the core region, copied from the input.',
    }),
    label: Label(),
    corrections: Type.Array(CorrectionSchema, { maxItems: 20 }),
    unmatched_names: Type.Array(Type.String({ minLength: 1, maxLength: 120 }), {
      maxItems: 20,
      description: 'Names in this segment that match no glossary entry.',
    }),
    possible_spoiler: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type ClassificationModelResult = Static<typeof ClassificationModelResultSchema>;

/**
 * What the model returns for one classification window (T11): only what it can know. Run IDs,
 * `window_index`, `text_corrected`, `review_required`, `event_ids` and the ASR flags are filled in
 * by core, which validates the finished records against `classification-result`.
 */
export const ClassificationWindowOutputSchema = Type.Object(
  {
    schema_version: SchemaVersion1,
    results: Type.Array(ClassificationModelResultSchema),
  },
  { additionalProperties: false },
);
export type ClassificationWindowOutput = Static<typeof ClassificationWindowOutputSchema>;
