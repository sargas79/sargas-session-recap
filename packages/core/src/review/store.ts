/**
 * SQLite `review_overrides` and its history (T12). The only writer of GM review state (ADR-001).
 * Every change bumps `revision` and appends the resulting state to the history in one transaction.
 */
import {
  EXCLUSION_REASONS,
  validateContract,
  type ClassificationLabel,
  type ReviewOverride,
} from '@sargas-recap/contracts';
import type { SqliteDatabase } from '../db/index.ts';
import { ulid } from '../ids/ulid.ts';
import { ReviewError } from './errors.ts';

export type RecapInclusion = ReviewOverride['recap_inclusion'];
export type ExclusionReason = ReviewOverride['exclusion_reasons'][number];
export type ReviewStatus = ReviewOverride['review_status'];
export type Reconciliation = ReviewOverride['reconciliation'];

/** An override as stored: the contract, except that "no inclusion decision" is `null` (ADR-011). */
export type StoredOverride = Omit<ReviewOverride, 'recap_inclusion'> & {
  readonly recap_inclusion: RecapInclusion | null;
};

export interface OverrideIdentity {
  readonly campaign_id: string;
  readonly session_id: string;
  readonly transcription_run_id: string;
  readonly segment_id: string;
  readonly base_text_hash: string;
}

/** What to change: an absent key is left alone, `null` clears the value. */
export interface OverrideChanges {
  readonly labelOverride?: ClassificationLabel | null;
  readonly recapInclusion?: RecapInclusion | null;
  readonly textOverride?: string | null;
  readonly exclusionReasons?: readonly ExclusionReason[];
  readonly reviewStatus?: ReviewStatus;
}

export interface OverrideHistoryEntry {
  readonly override_id: string;
  readonly revision: number;
  readonly action: HistoryAction;
  readonly label_override: ClassificationLabel | null;
  readonly recap_inclusion: RecapInclusion | null;
  readonly text_override: string | null;
  readonly exclusion_reasons: readonly ExclusionReason[];
  readonly review_status: ReviewStatus;
  readonly reconciliation: Reconciliation;
  readonly changed_at: string;
}

export type HistoryAction = 'create' | 'update' | 'reconcile' | 'reconciliation-state' | 'dismiss';

interface OverrideRow {
  readonly override_id: string;
  readonly campaign_id: string;
  readonly session_id: string;
  readonly transcription_run_id: string;
  readonly segment_id: string;
  readonly base_text_hash: string;
  readonly label_override: ClassificationLabel | null;
  readonly recap_inclusion: RecapInclusion | null;
  readonly text_override: string | null;
  readonly exclusion_reasons: string;
  readonly review_status: ReviewStatus;
  readonly reconciliation: Reconciliation;
  readonly supersedes_override_id: string | null;
  readonly dismissed_at: string | null;
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
}

type HistoryRow = Omit<OverrideHistoryEntry, 'exclusion_reasons'> & {
  readonly exclusion_reasons: string;
};

function parseReasons(json: string): ExclusionReason[] {
  return JSON.parse(json) as ExclusionReason[];
}

function canonicalReasons(reasons: readonly ExclusionReason[]): ExclusionReason[] {
  const wanted = new Set(reasons);
  return EXCLUSION_REASONS.filter((reason) => wanted.has(reason));
}

function fromRow(row: OverrideRow): StoredOverride {
  return {
    schema_version: 1,
    override_id: row.override_id,
    campaign_id: row.campaign_id,
    session_id: row.session_id,
    transcription_run_id: row.transcription_run_id,
    segment_id: row.segment_id,
    base_text_hash: row.base_text_hash,
    ...(row.label_override === null ? {} : { label_override: row.label_override }),
    recap_inclusion: row.recap_inclusion,
    ...(row.text_override === null ? {} : { text_override: row.text_override }),
    exclusion_reasons: parseReasons(row.exclusion_reasons),
    review_status: row.review_status,
    reconciliation: row.reconciliation,
    ...(row.supersedes_override_id === null
      ? {}
      : { supersedes_override_id: row.supersedes_override_id }),
    revision: row.revision,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** The `review-override` contract row. "No decision" reads as `unresolved` there (ADR-011). */
export function toReviewOverride(override: StoredOverride): ReviewOverride {
  return { ...override, recap_inclusion: override.recap_inclusion ?? 'unresolved' };
}

function assertValid(override: StoredOverride): void {
  const result = validateContract('review-override', toReviewOverride(override));
  if (!result.ok) {
    const where = result.errors.map((issue) => `${issue.path} ${issue.keyword}`).join(', ');
    throw new ReviewError('REVIEW_INVALID_OVERRIDE', `the override is not valid: ${where}`);
  }
}

/** NFC with LF line endings, so an editor cannot create a spurious change. */
function normalizeText(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').normalize('NFC');
  if (normalized.trim() === '') {
    throw new ReviewError('REVIEW_INVALID_OVERRIDE', 'the override text is empty', {
      hint: 'to remove a cleaned text use --clear-text',
    });
  }
  return normalized;
}

function appendHistory(
  db: SqliteDatabase,
  override: StoredOverride,
  action: HistoryAction,
  changedAt: string,
): void {
  db.prepare(
    `INSERT INTO review_override_history
       (override_id, revision, action, label_override, recap_inclusion, text_override,
        exclusion_reasons, review_status, reconciliation, changed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    override.override_id,
    override.revision,
    action,
    override.label_override ?? null,
    override.recap_inclusion,
    override.text_override ?? null,
    JSON.stringify(override.exclusion_reasons),
    override.review_status,
    override.reconciliation,
    changedAt,
  );
}

function insert(db: SqliteDatabase, override: StoredOverride, action: HistoryAction): void {
  assertValid(override);
  db.prepare(
    `INSERT INTO review_overrides
       (override_id, campaign_id, session_id, transcription_run_id, segment_id, base_text_hash,
        label_override, recap_inclusion, text_override, exclusion_reasons, review_status,
        reconciliation, supersedes_override_id, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    override.override_id,
    override.campaign_id,
    override.session_id,
    override.transcription_run_id,
    override.segment_id,
    override.base_text_hash,
    override.label_override ?? null,
    override.recap_inclusion,
    override.text_override ?? null,
    JSON.stringify(override.exclusion_reasons),
    override.review_status,
    override.reconciliation,
    override.supersedes_override_id ?? null,
    override.revision,
    override.created_at,
    override.updated_at,
  );
  appendHistory(db, override, action, override.created_at);
}

function update(db: SqliteDatabase, override: StoredOverride, action: HistoryAction): void {
  assertValid(override);
  db.prepare(
    `UPDATE review_overrides SET label_override = ?, recap_inclusion = ?, text_override = ?,
       exclusion_reasons = ?, review_status = ?, reconciliation = ?, revision = ?, updated_at = ?
     WHERE override_id = ?`,
  ).run(
    override.label_override ?? null,
    override.recap_inclusion,
    override.text_override ?? null,
    JSON.stringify(override.exclusion_reasons),
    override.review_status,
    override.reconciliation,
    override.revision,
    override.updated_at,
    override.override_id,
  );
  appendHistory(db, override, action, override.updated_at);
}

const LIVE = 'dismissed_at IS NULL';
const NOT_SUPERSEDED = `NOT EXISTS (
  SELECT 1 FROM review_overrides AS next
  WHERE next.supersedes_override_id = review_overrides.override_id AND next.dismissed_at IS NULL
)`;

/** Overrides in force or waiting for reconciliation, oldest first. */
export function listOverrides(
  db: SqliteDatabase,
  campaignId: string,
  sessionId: string,
): StoredOverride[] {
  const rows = db
    .prepare(
      `SELECT * FROM review_overrides
       WHERE campaign_id = ? AND session_id = ? AND ${LIVE} AND ${NOT_SUPERSEDED}
       ORDER BY created_at, override_id`,
    )
    .all(campaignId, sessionId) as OverrideRow[];
  return rows.map(fromRow);
}

function findRow(db: SqliteDatabase, overrideId: string): OverrideRow | undefined {
  return db.prepare('SELECT * FROM review_overrides WHERE override_id = ?').get(overrideId) as
    OverrideRow | undefined;
}

export function getOverride(db: SqliteDatabase, overrideId: string): StoredOverride | undefined {
  const row = findRow(db, overrideId);
  return row === undefined ? undefined : fromRow(row);
}

export function listOverrideHistory(
  db: SqliteDatabase,
  overrideId: string,
): OverrideHistoryEntry[] {
  const rows = db
    .prepare('SELECT * FROM review_override_history WHERE override_id = ? ORDER BY revision')
    .all(overrideId) as HistoryRow[];
  return rows.map((row) => ({ ...row, exclusion_reasons: parseReasons(row.exclusion_reasons) }));
}

function applyChanges(current: StoredOverride, changes: OverrideChanges): StoredOverride {
  const { label_override: currentLabel, text_override: currentText, ...rest } = current;
  const label = changes.labelOverride === undefined ? currentLabel : changes.labelOverride;
  const text =
    changes.textOverride === undefined
      ? currentText
      : changes.textOverride === null
        ? undefined
        : normalizeText(changes.textOverride);
  return {
    ...rest,
    ...(label === undefined || label === null ? {} : { label_override: label }),
    ...(text === undefined ? {} : { text_override: text }),
    recap_inclusion:
      changes.recapInclusion === undefined ? current.recap_inclusion : changes.recapInclusion,
    exclusion_reasons:
      changes.exclusionReasons === undefined
        ? current.exclusion_reasons
        : canonicalReasons(changes.exclusionReasons),
    review_status: changes.reviewStatus ?? current.review_status,
  };
}

function sameContent(a: StoredOverride, b: StoredOverride): boolean {
  return (
    a.label_override === b.label_override &&
    a.recap_inclusion === b.recap_inclusion &&
    a.text_override === b.text_override &&
    a.review_status === b.review_status &&
    a.exclusion_reasons.join() === b.exclusion_reasons.join()
  );
}

/** Creates the override of this identity or changes the existing one. */
export function setOverride(
  db: SqliteDatabase,
  identity: OverrideIdentity,
  changes: OverrideChanges,
  now: Date,
): StoredOverride {
  const at = now.toISOString();
  const write = db.transaction((): StoredOverride => {
    const row = db
      .prepare(
        `SELECT * FROM review_overrides
         WHERE transcription_run_id = ? AND segment_id = ? AND base_text_hash = ? AND ${LIVE}`,
      )
      .get(identity.transcription_run_id, identity.segment_id, identity.base_text_hash) as
      OverrideRow | undefined;
    if (row === undefined) {
      const created = applyChanges(
        {
          schema_version: 1,
          override_id: ulid(now.getTime()),
          ...identity,
          recap_inclusion: null,
          exclusion_reasons: [],
          review_status: 'pending',
          reconciliation: 'attached',
          revision: 1,
          created_at: at,
          updated_at: at,
        },
        changes,
      );
      insert(db, created, 'create');
      return created;
    }
    const current = fromRow(row);
    const next = applyChanges(current, changes);
    if (sameContent(current, next)) return current;
    const changed = { ...next, revision: current.revision + 1, updated_at: at };
    update(db, changed, 'update');
    return changed;
  });
  return write.immediate();
}

/**
 * Records each override's reconciliation state as the projection worked it out. The projection
 * decides from the identity (ADR-005); this column records the outcome, so a stale value can never
 * cause an override to be applied.
 */
export function recordReconciliation(
  db: SqliteDatabase,
  overrides: readonly StoredOverride[],
  unattachedIds: ReadonlySet<string>,
  now: Date,
): StoredOverride[] {
  const at = now.toISOString();
  const sync = db.transaction(() =>
    overrides.map((override) => {
      const state: Reconciliation = unattachedIds.has(override.override_id)
        ? 'needs_reconciliation'
        : 'attached';
      if (override.reconciliation === state) return override;
      const changed = {
        ...override,
        reconciliation: state,
        revision: override.revision + 1,
        updated_at: at,
      };
      update(db, changed, 'reconciliation-state');
      return changed;
    }),
  );
  return sync.immediate();
}

export interface ReconcileTarget {
  readonly transcription_run_id: string;
  readonly segment_id: string;
  readonly text_hash: string;
}

/**
 * The explicit GM action of ADR-005: a new row on the target segment that supersedes the old one,
 * which stays in history. One old override can be applied to several segments (a split).
 */
export function supersedeOverride(
  db: SqliteDatabase,
  old: StoredOverride,
  target: ReconcileTarget,
  now: Date,
): StoredOverride {
  const at = now.toISOString();
  const write = db.transaction((): StoredOverride => {
    const elsewhere = db
      .prepare(
        `SELECT override_id FROM review_overrides
         WHERE supersedes_override_id = ? AND transcription_run_id <> ? AND ${LIVE} LIMIT 1`,
      )
      .get(old.override_id, target.transcription_run_id) as { override_id: string } | undefined;
    if (elsewhere !== undefined) {
      throw new ReviewError(
        'REVIEW_NOT_RECONCILABLE',
        `override ${old.override_id} was already replaced by ${elsewhere.override_id}`,
        { hint: `reconcile ${elsewhere.override_id} instead` },
      );
    }
    const taken = db
      .prepare(
        `SELECT override_id FROM review_overrides
         WHERE transcription_run_id = ? AND segment_id = ? AND base_text_hash = ? AND ${LIVE}`,
      )
      .get(target.transcription_run_id, target.segment_id, target.text_hash) as
      { override_id: string } | undefined;
    if (taken !== undefined) {
      throw new ReviewError(
        'REVIEW_TARGET_TAKEN',
        `segment ${target.segment_id} already has override ${taken.override_id}`,
        {
          hint: `merge by hand: change it with \`recap overrides set\`, then retire ${old.override_id} with \`recap overrides reconcile --override ${old.override_id} --discard\``,
        },
      );
    }
    if (old.reconciliation !== 'needs_reconciliation') {
      update(
        db,
        {
          ...old,
          reconciliation: 'needs_reconciliation',
          revision: old.revision + 1,
          updated_at: at,
        },
        'reconciliation-state',
      );
    }
    const created: StoredOverride = {
      ...old,
      override_id: ulid(now.getTime()),
      transcription_run_id: target.transcription_run_id,
      segment_id: target.segment_id,
      base_text_hash: target.text_hash,
      // The GM reviewed other words if the text differs.
      review_status: target.text_hash === old.base_text_hash ? old.review_status : 'pending',
      reconciliation: 'attached',
      supersedes_override_id: old.override_id,
      revision: 1,
      created_at: at,
      updated_at: at,
    };
    insert(db, created, 'reconcile');
    return created;
  });
  return write.immediate();
}

/** Retires an override that has no counterpart. The row and its history stay (ADR-011). */
export function dismissOverride(db: SqliteDatabase, override: StoredOverride, now: Date): void {
  const at = now.toISOString();
  const write = db.transaction(() => {
    const revision = override.revision + 1;
    db.prepare(
      'UPDATE review_overrides SET dismissed_at = ?, revision = ?, updated_at = ? WHERE override_id = ?',
    ).run(at, revision, at, override.override_id);
    appendHistory(db, { ...override, revision, updated_at: at }, 'dismiss', at);
  });
  write.immediate();
}

export function isDismissed(db: SqliteDatabase, overrideId: string): boolean {
  return findRow(db, overrideId)?.dismissed_at !== null;
}
