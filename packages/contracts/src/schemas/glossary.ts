import { Type, type Static } from '@sinclair/typebox';
import { SchemaVersion1, Slug, StringEnum } from '../common.ts';

/** Known glossary entry types (T04). An unknown type is a validation error. */
export const GLOSSARY_TYPES = [
  'pc',
  'npc',
  'creature',
  'deity',
  'place',
  'faction',
  'item',
  'spell',
  'rule',
  'term',
] as const;
export type GlossaryType = (typeof GLOSSARY_TYPES)[number];

/** No control characters: spellings and mishearings end up in prompts. */
const SINGLE_LINE = '^[^\\u0000-\\u001F\\u007F]+$';
const Term = () => Type.String({ minLength: 1, maxLength: 120, pattern: SINGLE_LINE });

const GlossaryEntryObject = Type.Object(
  {
    id: Slug({
      description: 'Stable entry ID, unique within the glossary (checked by the loader).',
    }),
    spelling: Term(),
    type: StringEnum(GLOSSARY_TYPES),
    description: Type.Optional(
      Type.String({ minLength: 1, maxLength: 2000, description: 'Recap context only.' }),
    ),
    mishearings: Type.Optional(
      Type.Array(Term(), {
        uniqueItems: true,
        maxItems: 50,
        description: 'Known ASR misrecognitions of the spelling (classification correction).',
      }),
    ),
    is_english_term: Type.Optional(
      Type.Boolean({ description: 'English term inside a non-English session. Default false.' }),
    ),
  },
  { additionalProperties: false },
);

/**
 * `glossary.yaml` (T04). Entry IDs are unique (checked by the loader; JSON Schema cannot express
 * uniqueness of a property across array items).
 */
export const GlossarySchema = Type.Object(
  {
    schema_version: SchemaVersion1,
    entries: Type.Array(GlossaryEntryObject, { maxItems: 2000 }),
  },
  { additionalProperties: false },
);
export type Glossary = Static<typeof GlossarySchema>;
export type GlossaryEntry = Glossary['entries'][number];
