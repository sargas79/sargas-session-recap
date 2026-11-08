import { Type, type Static } from '@sinclair/typebox';
import {
  CampaignId,
  Count,
  GM_NOTE_ID_PATTERN,
  RecapRevision,
  ReviewerId,
  SchemaVersion1,
  SENTENCE_ID_PATTERN,
  SessionId,
  StringEnum,
  Text,
  Timestamp,
  Ulid,
  when,
} from '../common.ts';
import { RecapCitationsSchema } from './recap.ts';

/** What an edit targets. `title` and `sentence` are player-facing (hashed); `gm_note` is not. */
export const RECAP_EDIT_TARGETS = ['title', 'sentence', 'gm_note'] as const;
/**
 * `replace`: new text (and, for a sentence, new citations). `remove`: drop a sentence from the
 * player-facing content, or hide a GM note. `revert`: back to the generated draft value.
 */
export const RECAP_EDIT_ACTIONS = ['replace', 'remove', 'revert'] as const;

/**
 * One GM edit of a recap revision: one row of SQLite `recap_edits` (T15), append-only and
 * authoritative there only (ADR-001, ADR-010). The effective value of a target is the draft value
 * in `recap/<revision>/recap.json` overridden by its edit with the highest `sequence`.
 * T15 checks what JSON Schema cannot: `target_id` belongs to `recap_revision` and exists in its
 * draft, and `sequence` is unique per revision.
 */
export const RecapSentenceEditSchema = Type.Object(
  {
    schema_version: SchemaVersion1,
    edit_id: Ulid(),
    campaign_id: CampaignId(),
    session_id: SessionId(),
    recap_revision: RecapRevision(),
    sequence: Count({ description: 'Order of edits within the revision (0, 1, ...).' }),
    target_kind: StringEnum(RECAP_EDIT_TARGETS),
    target_id: Type.String({
      maxLength: 40,
      description: 'sentence_id, note_id, or the literal `title`, per target_kind.',
    }),
    action: StringEnum(RECAP_EDIT_ACTIONS),
    text: Type.Optional(Text({ maxLength: 2000, description: 'New text (replace only).' })),
    citations: Type.Optional(RecapCitationsSchema),
    reviewer_id: ReviewerId(),
    created_at: Timestamp(),
  },
  {
    additionalProperties: false,
    allOf: [
      when('target_kind', ['sentence'], {
        properties: { target_id: { type: 'string', pattern: SENTENCE_ID_PATTERN } },
      }),
      when('target_kind', ['gm_note'], {
        properties: { target_id: { type: 'string', pattern: GM_NOTE_ID_PATTERN } },
      }),
      when('target_kind', ['title'], {
        properties: {
          target_id: { type: 'string', const: 'title' },
          action: { type: 'string', enum: ['replace', 'revert'] },
          text: { type: 'string', maxLength: 200 },
        },
      }),
      when('target_kind', ['title', 'gm_note'], { properties: { citations: false } }),
      when('action', ['replace'], { required: ['text'] }),
      when('action', ['remove', 'revert'], { properties: { text: false, citations: false } }),
      {
        if: {
          type: 'object',
          properties: {
            target_kind: { type: 'string', const: 'sentence' },
            action: { type: 'string', const: 'replace' },
          },
          required: ['target_kind', 'action'],
        },
        then: { type: 'object', required: ['citations'] },
      },
    ],
  },
);
export type RecapSentenceEdit = Static<typeof RecapSentenceEditSchema>;
