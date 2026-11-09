-- 0005_recap_editorial: recap edits, editorial state, approvals and exports (T15, ADR-007, ADR-010).
--
-- SQLite is the only home of this state: edits are the only change a generated draft ever gets,
-- the current state is the `to_state` of the latest transition (no status column, ADR-010), and
-- approvals and exports are immutable facts. Every row is a contract record (`recap-sentence-edit`,
-- `recap-editorial-transition`, `recap-approval`, `recap-export-manifest`). All four tables are
-- append-only; the triggers refuse anything else. No table holds a file path.
--
-- draft_sha256 on recap_revisions: the hash of `recap/<revision>/recap.json` of a fork, which no
-- job records. NULL on generated revisions (their job holds the hash) and on a fork whose write has
-- not finished: such a fork is not a revision yet, and its number is a burned gap (ADR-010).

ALTER TABLE recap_revisions ADD COLUMN draft_sha256 TEXT CHECK (
  draft_sha256 IS NULL OR (length(draft_sha256) = 71 AND draft_sha256 GLOB 'sha256:*')
);

CREATE TABLE recap_edits (
  edit_id TEXT PRIMARY KEY CHECK (length(edit_id) = 26),
  campaign_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  recap_revision INTEGER NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('title', 'sentence', 'gm_note')),
  target_id TEXT NOT NULL CHECK (length(target_id) BETWEEN 1 AND 40),
  action TEXT NOT NULL CHECK (action IN ('replace', 'remove', 'revert')),
  text TEXT CHECK (text IS NULL OR length(text) >= 1),
  citations TEXT CHECK (citations IS NULL OR json_valid(citations)),
  reviewer_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (campaign_id, session_id, recap_revision, sequence),
  FOREIGN KEY (campaign_id, session_id, recap_revision)
    REFERENCES recap_revisions (campaign_id, session_id, revision)
) STRICT;

CREATE TABLE recap_editorial_transitions (
  transition_id TEXT PRIMARY KEY CHECK (length(transition_id) = 26),
  campaign_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  recap_revision INTEGER NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  trigger TEXT NOT NULL CHECK (trigger IN ('review', 'approve', 'export', 'content_edit', 'reopen')),
  from_state TEXT NOT NULL CHECK (from_state IN ('draft', 'reviewed', 'approved', 'exported')),
  to_state TEXT NOT NULL CHECK (to_state IN ('draft', 'reviewed', 'approved', 'exported')),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 71 AND content_hash GLOB 'sha256:*'),
  edit_id TEXT REFERENCES recap_edits (edit_id),
  approval_id TEXT,
  export_id TEXT,
  reviewer_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (campaign_id, session_id, recap_revision, sequence),
  FOREIGN KEY (campaign_id, session_id, recap_revision)
    REFERENCES recap_revisions (campaign_id, session_id, revision)
) STRICT;

CREATE TABLE recap_approvals (
  approval_id TEXT PRIMARY KEY CHECK (length(approval_id) = 26),
  campaign_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  recap_revision INTEGER NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 71 AND content_hash GLOB 'sha256:*'),
  reviewer_id TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  FOREIGN KEY (campaign_id, session_id, recap_revision)
    REFERENCES recap_revisions (campaign_id, session_id, revision)
) STRICT;

CREATE TABLE recap_exports (
  export_id TEXT PRIMARY KEY CHECK (length(export_id) = 26),
  campaign_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  recap_revision INTEGER NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 71 AND content_hash GLOB 'sha256:*'),
  approval_id TEXT NOT NULL REFERENCES recap_approvals (approval_id),
  package_schema_version INTEGER NOT NULL CHECK (package_schema_version = 1),
  package_sha256 TEXT NOT NULL CHECK (length(package_sha256) = 71 AND package_sha256 GLOB 'sha256:*'),
  package_bytes INTEGER NOT NULL CHECK (package_bytes >= 0),
  generator_version TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  exported_at TEXT NOT NULL,
  FOREIGN KEY (campaign_id, session_id, recap_revision)
    REFERENCES recap_revisions (campaign_id, session_id, revision)
) STRICT;

CREATE TRIGGER recap_edits_append_only_u BEFORE UPDATE ON recap_edits
BEGIN SELECT RAISE(ABORT, 'recap edits are append-only (ADR-010)'); END;
CREATE TRIGGER recap_edits_append_only_d BEFORE DELETE ON recap_edits
BEGIN SELECT RAISE(ABORT, 'recap edits are append-only (ADR-010)'); END;

CREATE TRIGGER recap_transitions_append_only_u BEFORE UPDATE ON recap_editorial_transitions
BEGIN SELECT RAISE(ABORT, 'editorial transitions are append-only (ADR-010)'); END;
CREATE TRIGGER recap_transitions_append_only_d BEFORE DELETE ON recap_editorial_transitions
BEGIN SELECT RAISE(ABORT, 'editorial transitions are append-only (ADR-010)'); END;

CREATE TRIGGER recap_approvals_immutable_u BEFORE UPDATE ON recap_approvals
BEGIN SELECT RAISE(ABORT, 'approval records are immutable (ADR-010)'); END;
CREATE TRIGGER recap_approvals_immutable_d BEFORE DELETE ON recap_approvals
BEGIN SELECT RAISE(ABORT, 'approval records are immutable (ADR-010)'); END;

CREATE TRIGGER recap_exports_immutable_u BEFORE UPDATE ON recap_exports
BEGIN SELECT RAISE(ABORT, 'export records are immutable (ADR-010)'); END;
CREATE TRIGGER recap_exports_immutable_d BEFORE DELETE ON recap_exports
BEGIN SELECT RAISE(ABORT, 'export records are immutable (ADR-010)'); END;
