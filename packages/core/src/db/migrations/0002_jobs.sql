-- 0002_jobs: job execution state (T07, ADR-001).
--
-- One `jobs` row per stage execution, projected 1:1 onto the `job-record` contract
-- (packages/contracts/src/schemas/job-record.ts). Execution state only: editorial state
-- lives in its own tables (ADR-010) and package lifecycle in the manifest (ADR-006).
-- Inputs and outputs are rows, not JSON, so invalidation and audits are plain queries.
-- Nothing here holds transcript, prompt or secret content: hashes, IDs, codes and
-- short actionable error messages only.
--
-- Instants used in arithmetic (heartbeats) are integer Unix milliseconds; audit
-- timestamps are RFC 3339 UTC text, like the contract.

CREATE TABLE jobs (
  job_id TEXT PRIMARY KEY CHECK (length(job_id) = 26),
  campaign_id TEXT NOT NULL CHECK (length(campaign_id) BETWEEN 1 AND 64),
  session_id TEXT NOT NULL CHECK (length(session_id) BETWEEN 1 AND 64),
  stage TEXT NOT NULL CHECK (length(stage) BETWEEN 1 AND 64),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')
  ),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 100),
  max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 100),
  output_run_id TEXT CHECK (output_run_id IS NULL OR length(output_run_id) = 26),
  output_recap_revision INTEGER CHECK (output_recap_revision IS NULL OR output_recap_revision >= 1),
  -- Usage and cost are integers (cost in micro-USD), never floats.
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cost_micro_usd INTEGER CHECK (cost_micro_usd IS NULL OR cost_micro_usd >= 0),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 64),
  error_message TEXT CHECK (error_message IS NULL OR length(error_message) BETWEEN 1 AND 500),
  error_retryable INTEGER CHECK (error_retryable IS NULL OR error_retryable IN (0, 1)),
  -- The interrupted job this one re-runs after crash recovery, if any.
  recovered_from_job_id TEXT REFERENCES jobs (job_id),
  -- Ownership while running: the lock holder's pid, lock token and last heartbeat.
  owner_pid INTEGER,
  owner_token TEXT,
  heartbeat_at INTEGER,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  -- Same rules as the contract's `allOf` (job-record).
  CHECK (status NOT IN ('running', 'succeeded', 'failed') OR started_at IS NOT NULL),
  CHECK (status NOT IN ('succeeded', 'failed', 'cancelled') OR finished_at IS NOT NULL),
  CHECK (status <> 'failed' OR error_code IS NOT NULL),
  CHECK (status NOT IN ('pending', 'running', 'succeeded') OR error_code IS NULL),
  CHECK ((error_code IS NULL) = (error_message IS NULL)),
  CHECK ((error_code IS NULL) = (error_retryable IS NULL)),
  CHECK ((input_tokens IS NULL) = (output_tokens IS NULL)),
  CHECK (cost_micro_usd IS NULL OR input_tokens IS NOT NULL),
  CHECK (attempt <= max_attempts)
) STRICT;

CREATE INDEX jobs_by_session_stage ON jobs (campaign_id, session_id, stage, created_at);
CREATE INDEX jobs_running ON jobs (campaign_id, session_id) WHERE status = 'running';

-- Inputs by hash. `role = 'dependency'` rows decide invalidation; `role = 'receipt'` rows are
-- recorded for traceability only (the assertConsent receipt: mode + policy hash), so a consent
-- edit never invalidates finished stages (consent is enforced by assertConsent, not by hashes).
CREATE TABLE job_inputs (
  job_id TEXT NOT NULL REFERENCES jobs (job_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (
    kind IN ('artifact', 'config', 'glossary', 'prompt', 'model', 'chunk-plan', 'overrides')
  ),
  ref TEXT NOT NULL CHECK (length(ref) BETWEEN 1 AND 240),
  hash TEXT NOT NULL CHECK (length(hash) = 71 AND hash GLOB 'sha256:*'),
  role TEXT NOT NULL DEFAULT 'dependency' CHECK (role IN ('dependency', 'receipt')),
  PRIMARY KEY (job_id, kind, ref)
) STRICT;

CREATE TABLE job_outputs (
  job_id TEXT NOT NULL REFERENCES jobs (job_id) ON DELETE CASCADE,
  path TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 240),
  hash TEXT NOT NULL CHECK (length(hash) = 71 AND hash GLOB 'sha256:*'),
  PRIMARY KEY (job_id, path)
) STRICT;

-- One row per session being processed. A run inserts it under BEGIN IMMEDIATE and refuses when a
-- live owner (same host, pid alive, fresh heartbeat) holds it; a dead or silent owner is replaced.
CREATE TABLE session_locks (
  campaign_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  owner_pid INTEGER NOT NULL,
  owner_host TEXT NOT NULL,
  owner_token TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  PRIMARY KEY (campaign_id, session_id)
) STRICT;
