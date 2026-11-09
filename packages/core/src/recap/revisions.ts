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
  const allocate = db.transaction((): number => {
    const row = db
      .prepare(
        'SELECT MAX(revision) AS top FROM recap_revisions WHERE campaign_id = ? AND session_id = ?',
      )
      .get(campaignId, sessionId) as { top: number | null };
    const revision = (row.top ?? 0) + 1;
    db.prepare(
      `INSERT INTO recap_revisions (campaign_id, session_id, revision, origin, created_at)
       VALUES (?, ?, ?, 'generated', ?)`,
    ).run(campaignId, sessionId, revision, now.toISOString());
    return revision;
  });
  return allocate.immediate();
}
