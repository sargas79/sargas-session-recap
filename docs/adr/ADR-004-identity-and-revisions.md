# ADR-004: Identity and revisions

- Status: Accepted
- Date: 2026-11-07
- Task: T02 (#18)
- Related: ADR-001, ADR-005, ADR-007

## Context

Stages can be re-run: a new glossary triggers retranscription, a prompt change triggers
reclassification, GM edits trigger a new recap. If IDs are global counters or random per record,
reruns are not diffable, tests are not stable, and a reference such as "segment 412" is ambiguous:
412 of which transcription? References between artifacts (classification → segment, recap citation
→ segment, override → segment) must stay unambiguous across reruns.

## Decision

### Run identity

- Every stage execution that produces an immutable artifact set gets a **run ID: a ULID** (26 chars,
  Crockford base32, time-sortable). `transcription_run_id`, `classification_run_id`, `job_id`,
  `override_id`, `package_id` and the Foundry `capture_id` are ULIDs.
- Recaps are identified by **`recap_revision`**, an integer starting at `1` and incremented per
  session. It names the directory `recap/<revision>/` and is what the GM and Foundry see.
- Runs are immutable. A rerun never overwrites a run directory; it creates a new run ID or revision.

### Record identity: deterministic within a run

| ID                | Format                                     | Example                              |
| ----------------- | ------------------------------------------ | ------------------------------------ |
| `campaign_id`     | slug `[a-z0-9-]`, operator-chosen (T04)    | `abomination-vaults`                 |
| `session_id`      | slug, unique within a campaign             | `s07`                                |
| `speaker_id`      | slug from campaign config (T04)            | `player-ana`                         |
| `fragment_id`     | `<speaker_id>:<n>`                         | `player-ana:1`                       |
| `segment_id`      | `<transcription_run_id>:<chunk_index>:<n>` | `01JBX7Q8M2N4P6R8S0T2V4W6XY:12:3`    |
| `event_id`        | `fvtt:<capture_id>:<seq>`                  | `fvtt:01JBX7A0B1C2D3E4F5G6H7J8K9:42` |
| `sentence_id`     | `r<recap_revision>:s<n>`                   | `r2:s0`                              |
| GM note `note_id` | `r<recap_revision>:g<n>`                   | `r2:g0`                              |
| `footnote_id`     | `r<recap_revision>:f<n>`                   | `r2:f1`                              |

- `<n>`, `<chunk_index>` and `<seq>` are non-negative integers without leading zeros, assigned in
  order by the stage that creates the records. The same inputs and plan produce the same IDs.
- A segment ID embeds its run, so a segment reference is never ambiguous. Records that also carry a
  `transcription_run_id` field must agree with the prefix of their `segment_id`; T03's validators
  check this (JSON Schema cannot compare two fields).
- Classification results reference exactly one transcription run. A recap revision references
  exactly one transcription run and one classification run (stored in `recap.json` as identity
  scope, see ADR-001); the overrides and prompts it used are recorded as job inputs.

### Revisions

- Transcription: a new run per retranscription. The previous run stays readable until purged by
  an explicit command.
- Classification: a new run per reclassification, bound to one transcription run.
- Recap: a new revision per generation. Edits to a revision are SQLite state (ADR-010, reserved);
  approval binds to a revision and its content hash (ADR-007).
- Which run is active for a session is SQLite state (ADR-001), never inferred from directory order.

## Consequences

- Reruns are diffable record by record, and fixtures and tests have stable IDs.
- Segment IDs change on retranscription, so overrides cannot follow by ID; that is intended and
  handled by ADR-005.
- IDs are safe as path segments and in HTML attributes: no spaces, quotes or slashes.
- ULID generation needs a monotonic source within one millisecond; T03/T07 provide the generator.

## Alternatives considered

- **UUIDv4 for every record.** Rejected: not deterministic, so reruns are not diffable and tests
  need ID normalization.
- **Global sequence numbers per session.** Rejected: ambiguous across runs and racy with parallel
  workers.
- **Content-hash IDs for segments.** Rejected: identical text in two places ("Sim.") collides, and
  timing corrections would change the ID.
- **UUIDv7 instead of ULID.** Equivalent in practice; ULID was chosen in T01 and is shorter and
  case-insensitive in path segments.
