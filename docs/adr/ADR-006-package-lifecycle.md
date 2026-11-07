# ADR-006: Session package lifecycle and path layout

- Status: Accepted
- Date: 2026-11-07
- Task: T02 (#18)
- Related: ADR-001, ADR-003, ADR-009 (reserved, #45), T03 (#19), T05 (#22), T06 (#25)

## Context

A session package holds private audio and everything derived from it. Source audio must be provably
unchanged after capture, derived artifacts must be traceable to it, and audio must eventually be
deleted (retention, consent withdrawal) without making the package look corrupt. Both the import
adapter (T05) and the optional Discord bot (T06) produce packages that must pass the same validator.

## Decision

### States

```text
capturing ──seal──► sealed ──first stage starts──► processing ──GM keeps package──► retained
                       │                                │                               │
                       └────────────── purge-audio (explicit) ──────────────────────────┴──► audio-purged
```

| State          | Meaning                                                                     | Manifest requirements       |
| -------------- | --------------------------------------------------------------------------- | --------------------------- |
| `capturing`    | Fragments are still being written. Nothing downstream may read the package. | no `seal`, no `purge`       |
| `sealed`       | Source artifacts are final and hashed.                                      | `seal` required, no `purge` |
| `processing`   | Derived artifacts (transcript, classify, recap runs) are being added.       | `seal` required, no `purge` |
| `retained`     | Processing is done; the package is kept, audio included.                    | `seal` required, no `purge` |
| `audio-purged` | Audio was deleted on purpose; derived artifacts remain.                     | `seal` and `purge` required |

The schema enforces the requirements column (`manifest` contract, `if`/`then` rules).

- `lifecycle` is the package's storage state, owned by the manifest. It is not job state: which
  stage is running, failed or succeeded lives only in SQLite (ADR-001). A package returns from
  `retained` to `processing` when a new run is started.
- Transitions only move forward along the arrows, except `retained → processing`. `audio-purged` is
  terminal for audio: a purged package can still be reclassified or get a new recap, but cannot be
  retranscribed.

### Sealing

- `recap package seal` (T03) hashes every source artifact (`audio/**`, `fragments.jsonl`,
  `foundry.jsonl` when present) and writes `seal.artifacts[] = {path, kind, hash, bytes}` plus
  `sealed_at`. Hashes are `sha256:<hex>` of the file bytes.
- After sealing, any change to a sealed artifact is corruption; the validator reports it with the
  path. Derived artifacts are not in the seal; their hashes are recorded as job outputs (SQLite).
- The manifest itself is not in its own seal; it changes on lifecycle transitions.

### Purge

- Audio is deleted only by the explicit `recap package purge-audio` command (T03), never as a side
  effect. It records `purge = {purged_at, purged_by, reason, purged_artifacts[] = {path, hash}}` and
  sets `lifecycle: audio-purged`, then logs one line (no content, allowlisted fields only).
- A validator treats a sealed audio artifact that is listed in `purge.purged_artifacts` as
  intentionally missing, and any other missing sealed artifact as corruption.

### Path layout

Package-relative paths (where the package directory lives is ADR-009):

```text
manifest.json
fragments.jsonl
audio/<speaker_id>/<n>.<ext>
foundry.jsonl
transcript/<transcription_run_id>/segments.jsonl
transcript/<transcription_run_id>/raw/
classify/<classification_run_id>/results.jsonl
recap/<revision>/recap.json
recap/<revision>/recap.md
```

- Contracts store paths as package-relative POSIX strings matching
  `^[A-Za-z0-9_-][A-Za-z0-9._-]*(/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$` (no absolute paths, drive letters,
  backslashes, or `.`/`..` segments). T03 resolves them safely on disk (traversal, symlink escape,
  Windows reserved names).
- Run directories are written to a temporary name and renamed into place when complete (T03 atomic
  finalization), so a half-written run is never mistaken for a finished one.

## Consequences

- One validator covers bot and import packages (T05/T06 acceptance).
- Purged packages validate as `audio-purged`, not corrupt (T03 acceptance).
- Retranscription after purge is impossible by design; the operator is told why.
- The manifest is rewritten on lifecycle changes; T03's atomic write helper must be used for it.

## Alternatives considered

- **Lifecycle in SQLite.** Rejected: a package copied to another machine or validated without the
  database would lose its integrity state.
- **Seal everything, including derived runs.** Rejected: derived runs are added after sealing and
  would force re-sealing; job output hashes already cover them.
- **Delete audio by removing the directory manually.** Rejected: indistinguishable from corruption
  and leaves no provenance.
