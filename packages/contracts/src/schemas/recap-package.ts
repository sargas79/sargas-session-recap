import { Type, type Static } from '@sinclair/typebox';
import {
  CampaignId,
  EVENT_ID_PATTERN,
  FootnoteId,
  Hash,
  Language,
  RecapRevision,
  SchemaVersion1,
  SEGMENT_ID_PATTERN,
  SentenceId,
  SessionId,
  SessionOffsetMs,
  StringEnum,
  Text,
  Timestamp,
  when,
} from '../common.ts';

const Evidence = Type.Object(
  {
    kind: StringEnum(['segment', 'event'] as const),
    ref: Type.String({ maxLength: 80, description: 'segment_id or event_id, per `kind`.' }),
    session_offset_ms: Type.Optional(SessionOffsetMs()),
    speaker_label: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    excerpt: Type.Optional(
      Text({ maxLength: 500, description: 'Effective text, GM-only journal.' }),
    ),
  },
  {
    additionalProperties: false,
    allOf: [
      when('kind', ['segment'], {
        properties: { ref: { type: 'string', pattern: SEGMENT_ID_PATTERN } },
      }),
      when('kind', ['event'], {
        properties: { ref: { type: 'string', pattern: EVENT_ID_PATTERN } },
      }),
    ],
  },
);

/**
 * Exported recap package imported by the Foundry module (T15 export, T19 import; ADR-007).
 * A derived, hashed snapshot of an approved revision. Contains no GM notes.
 * Journal identity: (campaign_id, session_id). Version: (recap_revision, content_hash).
 * content_hash canonicalization is defined in ADR-010 (reserved, T27).
 */
export const RecapPackageSchema = Type.Object(
  {
    schema_version: SchemaVersion1,
    package_kind: Type.Literal('sargas-recap'),
    campaign_id: CampaignId(),
    session_id: SessionId(),
    recap_revision: RecapRevision(),
    content_hash: Hash({ description: 'Hash of `content` (ADR-007; canonical form ADR-010).' }),
    approval: Type.Object(
      {
        approved_content_hash: Hash({ description: 'Must equal content_hash (ADR-007).' }),
        approved_at: Timestamp(),
      },
      { additionalProperties: false },
    ),
    exported_at: Timestamp(),
    generator: Type.Object(
      {
        name: Type.Literal('sargas-recap'),
        version: Type.String({ minLength: 1, maxLength: 32 }),
      },
      { additionalProperties: false },
    ),
    content: Type.Object(
      {
        language: Language(),
        title: Type.String({ minLength: 1, maxLength: 200 }),
        sentences: Type.Array(
          Type.Object(
            {
              sentence_id: SentenceId(),
              text: Text({ maxLength: 2000 }),
              footnote_ids: Type.Array(FootnoteId(), { uniqueItems: true }),
            },
            { additionalProperties: false },
          ),
          { minItems: 1 },
        ),
        footnotes: Type.Array(
          Type.Object(
            {
              footnote_id: FootnoteId(),
              evidence: Type.Array(Evidence, { minItems: 1 }),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type RecapPackage = Static<typeof RecapPackageSchema>;
