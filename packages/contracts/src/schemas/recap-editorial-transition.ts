import { Type, type Static } from '@sinclair/typebox';
import {
  CampaignId,
  Count,
  Hash,
  RecapRevision,
  ReviewerId,
  SchemaVersion1,
  SessionId,
  StringEnum,
  Timestamp,
  Ulid,
  when,
} from '../common.ts';

/** Editorial state of one recap revision (ADR-010). A new revision starts as `draft`. */
export const EDITORIAL_STATES = ['draft', 'reviewed', 'approved', 'exported'] as const;
export type EditorialState = (typeof EDITORIAL_STATES)[number];

/** What caused a transition (ADR-010 state transition table). */
export const EDITORIAL_TRIGGERS = [
  'review',
  'approve',
  'export',
  'content_edit',
  'reopen',
] as const;

const states = (...values: EditorialState[]) => ({ type: 'string', enum: values });

/**
 * One editorial state transition of a recap revision: one row of SQLite
 * `recap_editorial_transitions` (T15), append-only and authoritative there only (ADR-010). The
 * current state of a revision is `to_state` of its transition with the highest `sequence`, or
 * `draft` when there is none; no other column or file stores it.
 */
export const RecapEditorialTransitionSchema = Type.Object(
  {
    schema_version: SchemaVersion1,
    transition_id: Ulid(),
    campaign_id: CampaignId(),
    session_id: SessionId(),
    recap_revision: RecapRevision(),
    sequence: Count({ description: 'Order of transitions within the revision (0, 1, ...).' }),
    trigger: StringEnum(EDITORIAL_TRIGGERS),
    from_state: StringEnum(EDITORIAL_STATES),
    to_state: StringEnum(EDITORIAL_STATES),
    content_hash: Hash({
      description: 'canonicalContentHash of the effective content after the transition (ADR-010).',
    }),
    edit_id: Type.Optional(Ulid({ description: 'The edit that caused a content_edit.' })),
    approval_id: Type.Optional(Ulid({ description: 'The approval record an approve created.' })),
    export_id: Type.Optional(Ulid({ description: 'The export manifest an export created.' })),
    reviewer_id: ReviewerId(),
    created_at: Timestamp(),
  },
  {
    additionalProperties: false,
    allOf: [
      when('trigger', ['review'], {
        properties: { from_state: states('draft'), to_state: states('reviewed') },
      }),
      when('trigger', ['approve'], {
        properties: { from_state: states('reviewed'), to_state: states('approved') },
        required: ['approval_id'],
      }),
      when('trigger', ['export'], {
        properties: { from_state: states('approved', 'exported'), to_state: states('exported') },
        required: ['approval_id', 'export_id'],
      }),
      when('trigger', ['content_edit'], {
        properties: {
          from_state: states('draft', 'reviewed', 'approved'),
          to_state: states('draft'),
        },
        required: ['edit_id'],
      }),
      when('trigger', ['reopen'], {
        properties: { from_state: states('reviewed', 'approved'), to_state: states('draft') },
      }),
      when('trigger', ['review', 'approve', 'export', 'reopen'], {
        properties: { edit_id: false },
      }),
      when('trigger', ['review', 'content_edit', 'reopen'], {
        properties: { approval_id: false },
      }),
      when('trigger', ['review', 'approve', 'content_edit', 'reopen'], {
        properties: { export_id: false },
      }),
    ],
  },
);
export type RecapEditorialTransition = Static<typeof RecapEditorialTransitionSchema>;
