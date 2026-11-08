import { Type, type Static } from '@sinclair/typebox';
import {
  CampaignId,
  EventId,
  GmNoteId,
  Language,
  RecapRevision,
  SchemaVersion1,
  SegmentId,
  SentenceId,
  SessionId,
  StringEnum,
  Text,
  Timestamp,
  Ulid,
} from '../common.ts';

export const ASSERTIONS = ['completed', 'proposed', 'ongoing', 'background'] as const;

export const RecapCitationsSchema = Type.Object(
  {
    segment_ids: Type.Array(SegmentId(), { uniqueItems: true }),
    event_ids: Type.Array(EventId(), { uniqueItems: true }),
  },
  { additionalProperties: false },
);

const Sentence = Type.Object(
  {
    sentence_id: SentenceId(),
    text: Text({ maxLength: 2000 }),
    assertion: StringEnum(ASSERTIONS, {
      description: 'background never counts as evidence of what happened this session (T13).',
    }),
    outcome_basis: Type.Optional(StringEnum(['roll', 'narrative'] as const)),
    citations: RecapCitationsSchema,
  },
  { additionalProperties: false },
);

const GmNote = Type.Object(
  {
    note_id: GmNoteId(),
    reason: StringEnum(['unresolved', 'unsupported', 'conflict', 'spoiler'] as const),
    text: Text({ maxLength: 2000 }),
    citations: RecapCitationsSchema,
  },
  { additionalProperties: false },
);

/**
 * `recap/<revision>/recap.json`: the generated draft. Immutable once written (ADR-001, ADR-006).
 * Edits, editorial state and approvals live in SQLite (ADR-010).
 * Citation semantics (IDs exist, current session, eligible evidence) are validated in T13.
 */
export const RecapSchema = Type.Object(
  {
    schema_version: SchemaVersion1,
    campaign_id: CampaignId(),
    session_id: SessionId(),
    recap_revision: RecapRevision(),
    transcription_run_id: Ulid({ description: 'Scope that resolves every cited segment_id.' }),
    classification_run_id: Ulid(),
    language: Language(),
    generated_at: Timestamp(),
    title: Type.String({ minLength: 1, maxLength: 200 }),
    sentences: Type.Array(Sentence, { minItems: 1 }),
    gm_notes: Type.Array(GmNote, { description: 'GM-only; never exported to players.' }),
  },
  { additionalProperties: false },
);
export type Recap = Static<typeof RecapSchema>;
export type RecapCitations = Static<typeof RecapCitationsSchema>;
