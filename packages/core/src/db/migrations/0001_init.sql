-- 0001_init: migration bookkeeping only (ADR-009).
-- Jobs (T07) and review overrides (T12) arrive in later migrations.
--
-- Migrations are forward-only: never edit or renumber a file once it has shipped.
-- The runner records a checksum per file and refuses to open a database whose
-- applied migrations no longer match the code.
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;
