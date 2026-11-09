/**
 * The SQLite side of recap editing (T15, ADR-010): the append-only edit and transition logs, the
 * immutable approval and export records, and revision lineage. Every record is checked against its
 * contract before it is written. Nothing here decides anything: the state machine is editorial.ts.
 */
import {
  validateContract,
  type ContractName,
  type ContractTypes,
  type EditorialState,
  type RecapApproval,
  type RecapCitations,
  type RecapEditorialTransition,
  type RecapExportManifest,
  type RecapSentenceEdit,
} from '@sargas-recap/contracts';
import type { SqliteDatabase } from '../db/index.ts';
import { RecapEditorialError } from './errors.ts';

export interface RevisionKey {
  readonly db: SqliteDatabase;
  readonly campaignId: string;
  readonly sessionId: string;
  readonly revision: number;
}

/** Contract violations name a JSON path and a rule, never the rejected value. */
export function assertRecord<N extends ContractName>(name: N, record: unknown): ContractTypes[N] {
  const result = validateContract(name, record);
  if (!result.ok) {
    const where = result.errors.map((issue) => `${issue.path} ${issue.keyword}`).join(', ');
    throw new RecapEditorialError(
      'RECAP_EDIT_INVALID',
      `${name} does not fit its contract: ${where}`,
    );
  }
  return result.value;
}

const SCOPE = 'WHERE campaign_id = ? AND session_id = ? AND recap_revision = ?';

function args(key: RevisionKey): [string, string, number] {
  return [key.campaignId, key.sessionId, key.revision];
}

interface EditRow {
  edit_id: string;
  sequence: number;
  target_kind: string;
  target_id: string;
  action: string;
  text: string | null;
  citations: string | null;
  reviewer_id: string;
  created_at: string;
}

function toEdit(key: RevisionKey, row: EditRow): RecapSentenceEdit {
  return {
    schema_version: 1,
    edit_id: row.edit_id,
    campaign_id: key.campaignId,
    session_id: key.sessionId,
    recap_revision: key.revision,
    sequence: row.sequence,
    target_kind: row.target_kind as RecapSentenceEdit['target_kind'],
    target_id: row.target_id,
    action: row.action as RecapSentenceEdit['action'],
    ...(row.text === null ? {} : { text: row.text }),
    ...(row.citations === null ? {} : { citations: JSON.parse(row.citations) as RecapCitations }),
    reviewer_id: row.reviewer_id,
    created_at: row.created_at,
  };
}

export function listEdits(key: RevisionKey): RecapSentenceEdit[] {
  const rows = key.db
    .prepare(`SELECT * FROM recap_edits ${SCOPE} ORDER BY sequence`)
    .all(...args(key)) as EditRow[];
  return rows.map((row) => toEdit(key, row));
}

export function insertEdit(db: SqliteDatabase, edit: RecapSentenceEdit): void {
  assertRecord('recap-sentence-edit', edit);
  db.prepare(
    `INSERT INTO recap_edits (edit_id, campaign_id, session_id, recap_revision, sequence,
       target_kind, target_id, action, text, citations, reviewer_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    edit.edit_id,
    edit.campaign_id,
    edit.session_id,
    edit.recap_revision,
    edit.sequence,
    edit.target_kind,
    edit.target_id,
    edit.action,
    edit.text ?? null,
    edit.citations === undefined ? null : JSON.stringify(edit.citations),
    edit.reviewer_id,
    edit.created_at,
  );
}

interface TransitionRow {
  transition_id: string;
  sequence: number;
  trigger: string;
  from_state: string;
  to_state: string;
  content_hash: string;
  edit_id: string | null;
  approval_id: string | null;
  export_id: string | null;
  reviewer_id: string;
  created_at: string;
}

function toTransition(key: RevisionKey, row: TransitionRow): RecapEditorialTransition {
  return {
    schema_version: 1,
    transition_id: row.transition_id,
    campaign_id: key.campaignId,
    session_id: key.sessionId,
    recap_revision: key.revision,
    sequence: row.sequence,
    trigger: row.trigger as RecapEditorialTransition['trigger'],
    from_state: row.from_state as EditorialState,
    to_state: row.to_state as EditorialState,
    content_hash: row.content_hash,
    ...(row.edit_id === null ? {} : { edit_id: row.edit_id }),
    ...(row.approval_id === null ? {} : { approval_id: row.approval_id }),
    ...(row.export_id === null ? {} : { export_id: row.export_id }),
    reviewer_id: row.reviewer_id,
    created_at: row.created_at,
  };
}

export function listTransitions(key: RevisionKey): RecapEditorialTransition[] {
  const rows = key.db
    .prepare(`SELECT * FROM recap_editorial_transitions ${SCOPE} ORDER BY sequence`)
    .all(...args(key)) as TransitionRow[];
  return rows.map((row) => toTransition(key, row));
}

export function insertTransition(db: SqliteDatabase, transition: RecapEditorialTransition): void {
  assertRecord('recap-editorial-transition', transition);
  db.prepare(
    `INSERT INTO recap_editorial_transitions (transition_id, campaign_id, session_id, recap_revision,
       sequence, trigger, from_state, to_state, content_hash, edit_id, approval_id, export_id,
       reviewer_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    transition.transition_id,
    transition.campaign_id,
    transition.session_id,
    transition.recap_revision,
    transition.sequence,
    transition.trigger,
    transition.from_state,
    transition.to_state,
    transition.content_hash,
    transition.edit_id ?? null,
    transition.approval_id ?? null,
    transition.export_id ?? null,
    transition.reviewer_id,
    transition.created_at,
  );
}

/** The current state is the latest transition's; no rows means `draft` (ADR-010). */
export function currentState(transitions: readonly RecapEditorialTransition[]): EditorialState {
  return transitions[transitions.length - 1]?.to_state ?? 'draft';
}

export function getApproval(key: RevisionKey, approvalId: string): RecapApproval | undefined {
  const row = key.db
    .prepare(`SELECT * FROM recap_approvals ${SCOPE} AND approval_id = ?`)
    .get(...args(key), approvalId) as
    { content_hash: string; reviewer_id: string; approved_at: string } | undefined;
  if (row === undefined) return undefined;
  return {
    schema_version: 1,
    approval_id: approvalId,
    campaign_id: key.campaignId,
    session_id: key.sessionId,
    recap_revision: key.revision,
    content_hash: row.content_hash,
    reviewer_id: row.reviewer_id,
    approved_at: row.approved_at,
  };
}

export function insertApproval(db: SqliteDatabase, approval: RecapApproval): void {
  assertRecord('recap-approval', approval);
  db.prepare(
    `INSERT INTO recap_approvals (approval_id, campaign_id, session_id, recap_revision, content_hash,
       reviewer_id, approved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    approval.approval_id,
    approval.campaign_id,
    approval.session_id,
    approval.recap_revision,
    approval.content_hash,
    approval.reviewer_id,
    approval.approved_at,
  );
}

interface ExportRow {
  export_id: string;
  content_hash: string;
  approval_id: string;
  package_sha256: string;
  package_bytes: number;
  generator_version: string;
  reviewer_id: string;
  exported_at: string;
}

export function listExports(key: RevisionKey): RecapExportManifest[] {
  const rows = key.db
    .prepare(`SELECT * FROM recap_exports ${SCOPE} ORDER BY exported_at, export_id`)
    .all(...args(key)) as ExportRow[];
  return rows.map((row) => ({
    schema_version: 1,
    export_id: row.export_id,
    campaign_id: key.campaignId,
    session_id: key.sessionId,
    recap_revision: key.revision,
    content_hash: row.content_hash,
    approval_id: row.approval_id,
    package_schema_version: 1,
    package_sha256: row.package_sha256,
    package_bytes: row.package_bytes,
    generator_version: row.generator_version,
    reviewer_id: row.reviewer_id,
    exported_at: row.exported_at,
  }));
}

export function insertExport(db: SqliteDatabase, manifest: RecapExportManifest): void {
  assertRecord('recap-export-manifest', manifest);
  db.prepare(
    `INSERT INTO recap_exports (export_id, campaign_id, session_id, recap_revision, content_hash,
       approval_id, package_schema_version, package_sha256, package_bytes, generator_version,
       reviewer_id, exported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    manifest.export_id,
    manifest.campaign_id,
    manifest.session_id,
    manifest.recap_revision,
    manifest.content_hash,
    manifest.approval_id,
    manifest.package_schema_version,
    manifest.package_sha256,
    manifest.package_bytes,
    manifest.generator_version,
    manifest.reviewer_id,
    manifest.exported_at,
  );
}

export interface RevisionRow {
  readonly revision: number;
  readonly origin: 'generated' | 'fork';
  readonly parentRevision: number | undefined;
  readonly draftSha256: string | undefined;
}

/** Lineage of one revision, or `undefined` if the number was never allocated. */
export function getRevisionRow(key: RevisionKey): RevisionRow | undefined {
  const row = key.db
    .prepare(
      'SELECT revision, origin, parent_revision, draft_sha256 FROM recap_revisions WHERE campaign_id = ? AND session_id = ? AND revision = ?',
    )
    .get(...args(key)) as
    | {
        revision: number;
        origin: 'generated' | 'fork';
        parent_revision: number | null;
        draft_sha256: string | null;
      }
    | undefined;
  if (row === undefined) return undefined;
  return {
    revision: row.revision,
    origin: row.origin,
    parentRevision: row.parent_revision ?? undefined,
    draftSha256: row.draft_sha256 ?? undefined,
  };
}

/** The highest fork whose write finished: a NULL hash is a burned number, not a revision. */
export function latestCompleteFork(
  db: SqliteDatabase,
  campaignId: string,
  sessionId: string,
): number | undefined {
  const row = db
    .prepare(
      `SELECT MAX(revision) AS top FROM recap_revisions
       WHERE campaign_id = ? AND session_id = ? AND origin = 'fork' AND draft_sha256 IS NOT NULL`,
    )
    .get(campaignId, sessionId) as { top: number | null };
  return row.top ?? undefined;
}

export function recordForkDraftHash(key: RevisionKey, hash: string): void {
  key.db
    .prepare(
      'UPDATE recap_revisions SET draft_sha256 = ? WHERE campaign_id = ? AND session_id = ? AND revision = ?',
    )
    .run(hash, ...args(key));
}
