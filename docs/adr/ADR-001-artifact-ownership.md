# ADR-001: Artifact ownership and the single source of truth

- Status: Accepted
- Date: 2026-11-07
- Task: T02 (#18)
- Related: ADR-004, ADR-005, ADR-006, ADR-009 (reserved, #45), ADR-010
- Amended: ADR-010 (T27, #46) filled in the recap editorial-state rows of the ownership table

## Context

The pipeline produces several layers of state for one session: audio and its timing, ASR text,
LLM classification, GM review decisions, recap drafts, approvals and Foundry imports. Some of it is
written once by a stage, some of it is edited by the GM over days. If the same fact is stored in two
places (for example a label in both `results.jsonl` and SQLite, or a job's status in both the
manifest and SQLite), the copies drift and nobody can say which one is right. Re-running a stage
must never destroy GM work, and GM work must never rewrite stage output.

## Decision

Every piece of state has exactly one authoritative home. Everything else is a derived, recomputable
projection or a reference by ID and hash.

1. **Transcription runs own the original text, timing, speaker and source fragments.**
   `transcript/<transcription_run_id>/segments.jsonl` is immutable once its job succeeds.
2. **Classification runs own labels, corrections and classification flags.**
   `classify/<classification_run_id>/results.jsonl` references segments by ID and never contains or
   changes `text_original`.
3. **SQLite owns GM review overrides** (label override, recap inclusion, cleaned text, exclusions,
   review status, reconciliation state, history) and **job execution state**.
4. **The effective transcript is a derived projection**: segments + one classification run +
   attached overrides. It can be cached but is never edited and never read back as a source.
5. **Artifacts carry no "current" pointers and no execution state.** Which run is active for a
   session, and whether a job is running, lives in SQLite only.
6. **Recap drafts are immutable artifacts** (`recap/<revision>/recap.json`). Edits, editorial
   state and approvals are SQLite state (detail in ADR-010). Exported packages are
   derived snapshots.

### Where each piece of state lives

| State                                                                  | Authoritative home                       | Contract                            | Also appears in (non-authoritative)                                                                           |
| ---------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Audio samples                                                          | `audio/<speaker_id>/<n>.<ext>`           | —                                   | —                                                                                                             |
| Fragment timing (start offset, sample rate, sample count, status)      | `fragments.jsonl`                        | `fragment`                          | —                                                                                                             |
| Source artifact hashes and sizes (seal)                                | `manifest.json` `seal`                   | `manifest`                          | —                                                                                                             |
| Package lifecycle state                                                | `manifest.json` `lifecycle`              | `manifest`                          | —                                                                                                             |
| Purge provenance (who, when, which hashes)                             | `manifest.json` `purge`                  | `manifest`                          | the log line of the purge command (no content)                                                                |
| Consent applied at capture time                                        | `manifest.json` `consent` (snapshot)     | `manifest`                          | current policy lives in campaign config (T04); the snapshot is not a copy of it, it records what applied then |
| Session timeline origin and discontinuities                            | `manifest.json` `timeline`               | `manifest`                          | —                                                                                                             |
| Foundry observations (raw timing)                                      | `foundry.jsonl`                          | `foundry-event`                     | —                                                                                                             |
| Foundry-to-session alignment                                           | separate alignment artifact (T18)        | defined in T18                      | —                                                                                                             |
| Original text, segment timing, speaker, source spans, `text_hash`      | `transcript/<run>/segments.jsonl`        | `transcription-segment`             | effective transcript (projection)                                                                             |
| Labels, corrections, `review_required`, classification flags           | `classify/<run>/results.jsonl`           | `classification-result`             | effective transcript (projection)                                                                             |
| Names the model could not match, corrections core rejected             | `classify/<run>/corrections-report.json` | `classification-corrections-report` | —                                                                                                             |
| GM overrides and their history                                         | SQLite `review_overrides`                | `review-override`                   | effective transcript (projection)                                                                             |
| Effective text/label/inclusion per segment                             | nowhere: derived                         | `effective-transcript`              | optional cache, regenerated on any input change                                                               |
| Active run per session (which transcription/classification is current) | SQLite                                   | T07/T12                             | —                                                                                                             |
| Job status, attempts, input hashes, output hashes, usage, errors       | SQLite `jobs`                            | `job-record`                        | —                                                                                                             |
| Generated recap draft (sentences, citations, GM notes)                 | `recap/<revision>/recap.json`            | `recap`                             | `recap.md` (rendering)                                                                                        |
| Recap revision allocation and lineage (generated or forked, ADR-010)   | SQLite `recap_revisions`                 | ADR-010 (T15)                       | the directory name `recap/<revision>/`                                                                        |
| Recap title, sentence and GM-note edits                                | SQLite `recap_edits`                     | `recap-sentence-edit`               | effective recap content (derived, ADR-010)                                                                    |
| Recap editorial state and its history (current = latest transition)    | SQLite `recap_editorial_transitions`     | `recap-editorial-transition`        | —                                                                                                             |
| Recap approval records (who approved which `content_hash`, when)       | SQLite `recap_approvals`                 | `recap-approval`                    | package `approval` block (snapshot)                                                                           |
| Recap export records (revision, `content_hash`, package hash)          | SQLite `recap_exports`                   | `recap-export-manifest`             | —                                                                                                             |
| Effective recap content (draft + edits) and its `content_hash`         | nowhere: derived (ADR-010)               | `canonicalContentHash`              | hash recorded in transitions, approvals and exports as a fact about that moment                               |
| Approved/exported recap content and its `content_hash`                 | derived from the approved revision       | `recap-package`                     | Foundry journal flags (import result, ADR-007)                                                                |
| Journal identity and imported version                                  | Foundry journal flags                    | ADR-007                             | —                                                                                                             |

Rules that follow from the table:

- A recap draft stores `transcription_run_id` and `classification_run_id` because they are the
  identity scope that makes its citations resolvable (ADR-004), not as a record of job inputs. Input
  hashes (config, prompt, model, overrides) are job state and live only in the job record.
- `fragments.jsonl` does not store hashes; the manifest seal does. The manifest does not store job
  state; SQLite does. SQLite does not store lifecycle; the manifest does.
- An exported recap package and a Foundry journal carry `recap_revision` and `content_hash` as
  version identity. They are outputs, never read back into the pipeline.

## Consequences

- Re-running classification produces a new run directory and cannot touch overrides, because
  overrides key on the transcription run (ADR-005), not on classification output.
- Re-transcription produces a new run with new segment IDs; existing overrides go to
  `needs_reconciliation` instead of being silently reattached (ADR-005).
- Readers that need "the transcript as the GM sees it" must build the projection; there is no file to
  edit by hand. T12 owns the projection code.
- Losing the SQLite database loses GM review work and job history but not stage output. Backups of
  the data root (ADR-009) must include the database.
- Validators (T03) can check artifacts without SQLite, and SQLite can be migrated without rewriting
  artifacts.

## Alternatives considered

- **Store overrides inside `results.jsonl` or a sidecar JSONL.** Rejected: a classification rerun
  would have to merge GM work into new output, which is exactly the drift this ADR prevents.
- **Store everything in SQLite, including segments.** Rejected: large immutable text and audio
  metadata belong in hashable files that can be sealed, validated and diffed; SQLite is for mutable
  state.
- **Mutable `transcript.json` updated in place with labels and edits.** Rejected: no audit trail,
  no safe rerun, and overrides would be lost on retranscription.
