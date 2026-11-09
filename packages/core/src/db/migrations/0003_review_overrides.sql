-- 0003_review_overrides: GM review overrides and their history (T12, ADR-001, ADR-005).
--
-- SQLite is the only home of this state; the effective transcript is derived from it. One row per
-- override, projected onto the `review-override` contract. Deviations from the contract:
--   recap_inclusion NULL: the GM made no inclusion decision (ADR-011). The contract reads it as
--     `unresolved`, but the projection falls through to the default for the effective label.
--   dismissed_at: the GM retired an override that cannot be reconciled (ADR-011).
--
-- Identity is (transcription_run_id, segment_id, base_text_hash) and never changes. Nothing here
-- references classification, so a classification rerun cannot touch a row.

CREATE TABLE review_overrides (
  override_id TEXT PRIMARY KEY CHECK (length(override_id) = 26),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  campaign_id TEXT NOT NULL CHECK (length(campaign_id) BETWEEN 1 AND 64),
  session_id TEXT NOT NULL CHECK (length(session_id) BETWEEN 1 AND 64),
  transcription_run_id TEXT NOT NULL CHECK (length(transcription_run_id) = 26),
  segment_id TEXT NOT NULL CHECK (length(segment_id) BETWEEN 1 AND 128),
  base_text_hash TEXT NOT NULL CHECK (length(base_text_hash) = 71 AND base_text_hash GLOB 'sha256:*'),
  label_override TEXT CHECK (
    label_override IS NULL
    OR label_override IN ('ic', 'narration', 'rules', 'ooc', 'mixed', 'uncertain')
  ),
  recap_inclusion TEXT CHECK (
    recap_inclusion IS NULL OR recap_inclusion IN ('include', 'exclude', 'unresolved')
  ),
  text_override TEXT CHECK (text_override IS NULL OR length(text_override) BETWEEN 1 AND 20000),
  exclusion_reasons TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(exclusion_reasons)),
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'reviewed')),
  reconciliation TEXT NOT NULL DEFAULT 'attached' CHECK (
    reconciliation IN ('attached', 'needs_reconciliation')
  ),
  supersedes_override_id TEXT REFERENCES review_overrides (override_id),
  dismissed_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX review_overrides_identity
  ON review_overrides (transcription_run_id, segment_id, base_text_hash)
  WHERE dismissed_at IS NULL;
CREATE INDEX review_overrides_by_session ON review_overrides (campaign_id, session_id, created_at);
CREATE INDEX review_overrides_supersedes ON review_overrides (supersedes_override_id)
  WHERE supersedes_override_id IS NOT NULL;

CREATE TRIGGER review_overrides_identity_immutable
  BEFORE UPDATE OF campaign_id, session_id, transcription_run_id, segment_id, base_text_hash,
    supersedes_override_id ON review_overrides
BEGIN
  SELECT RAISE(ABORT, 'a review override identity is immutable (ADR-005)');
END;

-- One row per revision of an override: the state after that change. Append-only.
CREATE TABLE review_override_history (
  override_id TEXT NOT NULL REFERENCES review_overrides (override_id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  action TEXT NOT NULL CHECK (
    action IN ('create', 'update', 'reconcile', 'reconciliation-state', 'dismiss')
  ),
  label_override TEXT,
  recap_inclusion TEXT,
  text_override TEXT,
  exclusion_reasons TEXT NOT NULL CHECK (json_valid(exclusion_reasons)),
  review_status TEXT NOT NULL,
  reconciliation TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  PRIMARY KEY (override_id, revision)
) STRICT;

CREATE TRIGGER review_override_history_no_update
  BEFORE UPDATE ON review_override_history
BEGIN
  SELECT RAISE(ABORT, 'review override history is append-only');
END;

CREATE TRIGGER review_override_history_no_delete
  BEFORE DELETE ON review_override_history
BEGIN
  SELECT RAISE(ABORT, 'review override history is append-only');
END;
