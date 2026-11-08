import { Type, type Static } from '@sinclair/typebox';
import {
  CampaignId,
  Count,
  Hash,
  RecapRevision,
  ReviewerId,
  SchemaVersion1,
  SessionId,
  Timestamp,
  Ulid,
} from '../common.ts';

/**
 * Record of one export of a recap package: one row of SQLite `recap_exports` (T15), immutable and
 * authoritative there only (ADR-010). It is what enforces ADR-007's "one content_hash per exported
 * revision": every export row of a revision carries the same `content_hash`. It stores no file
 * path (paths can contain the operator's user name) and no content.
 */
export const RecapExportManifestSchema = Type.Object(
  {
    schema_version: SchemaVersion1,
    export_id: Ulid(),
    campaign_id: CampaignId(),
    session_id: SessionId(),
    recap_revision: RecapRevision(),
    content_hash: Hash({ description: 'Equals the package content_hash (ADR-007, ADR-010).' }),
    approval_id: Ulid({ description: 'Approval in force at export; same content_hash.' }),
    package_schema_version: Type.Literal(1, {
      description: 'schema_version of the written recap-package.',
    }),
    package_sha256: Hash({ description: 'SHA-256 of the exact bytes of the written file.' }),
    package_bytes: Count(),
    generator_version: Type.String({ minLength: 1, maxLength: 32 }),
    reviewer_id: ReviewerId(),
    exported_at: Timestamp(),
  },
  { additionalProperties: false },
);
export type RecapExportManifest = Static<typeof RecapExportManifestSchema>;
