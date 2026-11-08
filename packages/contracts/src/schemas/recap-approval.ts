import { Type, type Static } from '@sinclair/typebox';
import {
  CampaignId,
  Hash,
  RecapRevision,
  ReviewerId,
  SchemaVersion1,
  SessionId,
  Timestamp,
  Ulid,
} from '../common.ts';

/**
 * One GM approval of `(recap_revision, content_hash)`: one row of SQLite `recap_approvals` (T15),
 * immutable and authoritative there only (ADR-007, ADR-010). Whether it is still in force is not
 * stored here: it is in force while the revision's latest transition is the `approve` (or a later
 * `export`) that references it. A content edit or reopen ends it; the row is never updated.
 */
export const RecapApprovalSchema = Type.Object(
  {
    schema_version: SchemaVersion1,
    approval_id: Ulid(),
    campaign_id: CampaignId(),
    session_id: SessionId(),
    recap_revision: RecapRevision(),
    content_hash: Hash({ description: 'canonicalContentHash of the approved content (ADR-010).' }),
    reviewer_id: ReviewerId(),
    approved_at: Timestamp(),
  },
  { additionalProperties: false },
);
export type RecapApproval = Static<typeof RecapApprovalSchema>;
