import type { SqliteDatabase } from '../db/index.ts';

/**
 * Allocates the next recap revision of a session in one transaction (ADR-010, section 3). Numbers
 * are never reused; a gap after a failed write is allowed.
 */
export function allocateRecapRevision(
  db: SqliteDatabase,
  campaignId: string,
  sessionId: string,
  now: Date,
): number {
  return allocate(db, campaignId, sessionId, now, 'generated', null);
}

/** The next number for a fork of an exported revision (T15, ADR-010): same allocator. */
export function allocateForkRevision(
  db: SqliteDatabase,
  campaignId: string,
  sessionId: string,
  parentRevision: number,
  now: Date,
): number {
  return allocate(db, campaignId, sessionId, now, 'fork', parentRevision);
}

function allocate(
  db: SqliteDatabase,
  campaignId: string,
  sessionId: string,
  now: Date,
  origin: 'generated' | 'fork',
  parentRevision: number | null,
): number {
  const run = db.transaction((): number => {
    const row = db
      .prepare(
        'SELECT MAX(revision) AS top FROM recap_revisions WHERE campaign_id = ? AND session_id = ?',
      )
      .get(campaignId, sessionId) as { top: number | null };
    const revision = (row.top ?? 0) + 1;
    db.prepare(
      `INSERT INTO recap_revisions (campaign_id, session_id, revision, origin, parent_revision, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(campaignId, sessionId, revision, origin, parentRevision, now.toISOString());
    return revision;
  });
  return run.immediate();
}
