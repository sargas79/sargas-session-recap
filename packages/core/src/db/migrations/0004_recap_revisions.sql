-- 0004_recap_revisions: per-session recap revision allocator (T13, ADR-004, ADR-010).
--
-- SQLite is the only allocator of recap revision numbers: within a session they are never reused
-- and a gap after a failed write is allowed. Recap generation (T13) inserts `origin = 'generated'`;
-- the content-edit fork of an exported revision (T15) inserts `origin = 'fork'` with its parent.
-- Nothing here holds recap content: the draft is `recap/<revision>/recap.json`.

CREATE TABLE recap_revisions (
  campaign_id TEXT NOT NULL CHECK (length(campaign_id) BETWEEN 1 AND 64),
  session_id TEXT NOT NULL CHECK (length(session_id) BETWEEN 1 AND 64),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  origin TEXT NOT NULL CHECK (origin IN ('generated', 'fork')),
  parent_revision INTEGER CHECK (parent_revision IS NULL OR parent_revision >= 1),
  created_at TEXT NOT NULL,
  PRIMARY KEY (campaign_id, session_id, revision),
  CHECK ((origin = 'fork') = (parent_revision IS NOT NULL))
) STRICT;
