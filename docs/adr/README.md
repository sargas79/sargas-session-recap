# Architecture decision records

Decisions that later tasks must not re-decide. Each ADR has Status, Context, Decision, Consequences
and Alternatives. To change a decision, add a new ADR that supersedes the old one; don't rewrite an
accepted ADR.

The schemas that implement these decisions live in `packages/contracts/src` (TypeBox). The emitted
JSON Schema 2020-12 files are committed in `packages/contracts/schemas/`, and synthetic examples are in
`fixtures/contracts/<name>/`.

## Index

| ADR                                            | Title                                                 | Status   | Task      |
| ---------------------------------------------- | ----------------------------------------------------- | -------- | --------- |
| [ADR-001](ADR-001-artifact-ownership.md)       | Artifact ownership and the single source of truth     | Accepted | T02 (#18) |
| [ADR-002](ADR-002-schema-version-placement.md) | `schema_version` placement                            | Accepted | T02 (#18) |
| [ADR-003](ADR-003-timeline.md)                 | Timeline: integer milliseconds and sample offsets     | Accepted | T02 (#18) |
| [ADR-004](ADR-004-identity-and-revisions.md)   | Identity and revisions                                | Accepted | T02 (#18) |
| [ADR-005](ADR-005-override-reconciliation.md)  | Review override reconciliation                        | Accepted | T02 (#18) |
| [ADR-006](ADR-006-package-lifecycle.md)        | Session package lifecycle and path layout             | Accepted | T02 (#18) |
| [ADR-007](ADR-007-approval-and-import.md)      | Approval binding and Foundry import rules             | Accepted | T02 (#18) |
| [ADR-008](ADR-008-workspace-layout.md)         | Workspace layout                                      | Accepted | T24 (#44) |
| [ADR-009](ADR-009-data-root.md)                | Data root and app-state locations                     | Accepted | T25 (#45) |
| [ADR-010](ADR-010-recap-editorial-state.md)    | Recap editorial state and content-hash canonical form | Accepted | T27 (#46) |

ADR-008, ADR-009 and ADR-010 were reserved here so references stay stable. Their content belongs to
the listed tasks.

## Contracts

| Contract                     | Schema file                              | Stored as                                          | Owner (ADR-001)       |
| ---------------------------- | ---------------------------------------- | -------------------------------------------------- | --------------------- |
| `manifest`                   | `manifest.schema.json`                   | `manifest.json`                                    | package               |
| `fragment`                   | `fragment.schema.json`                   | `fragments.jsonl`, one record per line             | capture / import      |
| `foundry-event`              | `foundry-event.schema.json`              | `foundry.jsonl`, one record per line               | Foundry capture (T16) |
| `transcription-segment`      | `transcription-segment.schema.json`      | `transcript/<transcription_run_id>/segments.jsonl` | transcription run     |
| `chunk-plan`                 | `chunk-plan.schema.json`                 | `chunk-plans/<plan_hash_hex>.json`                 | chunk-plan stage      |
| `classification-result`      | `classification-result.schema.json`      | `classify/<classification_run_id>/results.jsonl`   | classification run    |
| `review-override`            | `review-override.schema.json`            | SQLite `review_overrides` row                      | SQLite                |
| `effective-transcript`       | `effective-transcript.schema.json`       | computed on demand; a cache is never authoritative | derived               |
| `recap`                      | `recap.schema.json`                      | `recap/<revision>/recap.json`                      | recap generation      |
| `recap-package`              | `recap-package.schema.json`              | export file imported by the Foundry module         | derived snapshot      |
| `job-record`                 | `job-record.schema.json`                 | SQLite `jobs` row                                  | SQLite                |
| `recap-sentence-edit`        | `recap-sentence-edit.schema.json`        | SQLite `recap_edits` row                           | SQLite                |
| `recap-editorial-transition` | `recap-editorial-transition.schema.json` | SQLite `recap_editorial_transitions` row           | SQLite                |
| `recap-approval`             | `recap-approval.schema.json`             | SQLite `recap_approvals` row                       | SQLite                |
| `recap-export-manifest`      | `recap-export-manifest.schema.json`      | SQLite `recap_exports` row                         | SQLite                |

## Session package path layout

All paths are relative to one session package directory. Where that directory lives (the data root)
is ADR-009. Paths in contracts are package-relative POSIX paths (`/` separators, no `.`/`..`
segments, no drive letters).

```text
<session package>/
  manifest.json                                  ADR-006: lifecycle, seal hashes, purge provenance
  fragments.jsonl                                ADR-003: one fragment record per line
  audio/<speaker_id>/<n>.<ext>                   source audio fragments (sealed, purgeable)
  foundry.jsonl                                  Foundry event envelopes (optional, sealed when present)
  chunk-plans/<plan_hash_hex>.json               ASR chunk plan, content-addressed (T08)
  transcript/<transcription_run_id>/
    segments.jsonl                               immutable transcription segments
    raw/                                         raw ASR output kept for audit (T09)
  classify/<classification_run_id>/
    results.jsonl                                labels, corrections, flags
  recap/<revision>/
    recap.json                                   generated draft (immutable)
    recap.md                                     rendered Markdown with footnotes (T13)
```

`<transcription_run_id>` and `<classification_run_id>` are ULIDs; `<revision>` is the integer recap
revision (`1`, `2`, ...). A run directory is written once and never modified after its job succeeds.

## Regenerating schemas

```sh
npm run schemas -w @sargas-recap/contracts
```

`packages/contracts/test/schemas.test.ts` fails when a committed `.schema.json` differs from the
TypeBox source, so commit the regenerated files with the source change.
