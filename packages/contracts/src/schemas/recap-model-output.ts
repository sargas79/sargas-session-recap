import { Type, type Static } from '@sinclair/typebox';
import { EventId, SchemaVersion1, StringEnum, Text } from '../common.ts';
import { SEGMENT_REF_PATTERN } from './classification-window-output.ts';
import { ASSERTIONS, GM_NOTE_REASONS, OUTCOME_BASES } from './recap.ts';

/** Citations as the model gives them; core resolves each ref to its segment ID (T13). */
const RecapModelCitationsSchema = Type.Object(
  {
    segment_refs: Type.Array(
      Type.String({
        pattern: SEGMENT_REF_PATTERN,
        maxLength: 24,
        description: 'The ref of a segment in the input, copied exactly.',
      }),
    ),
    event_ids: Type.Array(EventId()),
  },
  { additionalProperties: false },
);
export type RecapModelCitations = Static<typeof RecapModelCitationsSchema>;

const RecapModelSentence = Type.Object(
  {
    text: Text({ maxLength: 2000 }),
    assertion: StringEnum(ASSERTIONS),
    outcome_basis: Type.Optional(StringEnum(OUTCOME_BASES)),
    citations: RecapModelCitationsSchema,
  },
  { additionalProperties: false },
);

const RecapModelNote = Type.Object(
  {
    reason: StringEnum(GM_NOTE_REASONS),
    text: Text({ maxLength: 2000 }),
    citations: RecapModelCitationsSchema,
  },
  { additionalProperties: false },
);

/**
 * What the model returns for one recap (T13): only what it can know. Campaign, session, revision,
 * run IDs, language, `generated_at`, sentence and note IDs and full segment IDs are filled in by
 * core, which validates the finished record against `recap` and every citation against the
 * segments it actually sent.
 */
export const RecapModelOutputSchema = Type.Object(
  {
    schema_version: SchemaVersion1,
    title: Type.String({ minLength: 1, maxLength: 200 }),
    sentences: Type.Array(RecapModelSentence, { minItems: 1 }),
    gm_notes: Type.Array(RecapModelNote),
  },
  { additionalProperties: false },
);
export type RecapModelOutput = Static<typeof RecapModelOutputSchema>;
