# ADR-007: Approval binding and Foundry import rules

- Status: Accepted
- Date: 2026-11-07
- Task: T02 (#18)
- Related: ADR-001, ADR-004, ADR-010, T15 (#35), T19 (#36)

## Context

The GM approves a recap and imports it into Foundry as a GM-only journal. Two things can go wrong:
something other than what the GM approved gets exported (an edit after approval), and importing twice
or importing an older or conflicting revision corrupts or duplicates the journal. The Foundry module
runs in the browser, so every rule has to be checkable from the package file alone.

## Decision

### Approval is bound to a content hash

- Approval applies to one `(recap_revision, content_hash)`. `content_hash` is `sha256:<hex>` over a
  canonical form of the player-facing content (sentences and their citations, excluding GM notes and
  timestamps). The exact canonicalization rule is ADR-010; the Foundry module
  reimplements it from that ADR.
- Any change to the content changes the hash and therefore invalidates the approval. Normal export
  requires an approval whose hash equals the hash of the content being exported (T15).
- The recap package carries `content_hash` and `approval.approved_content_hash`. The importer
  recomputes the hash from `content` and rejects the package unless all three are equal.
- Approval records themselves live in SQLite (ADR-001, detail in ADR-010). The package's `approval`
  block is a derived snapshot.
- GM notes are never in the package (`recap-package` schema rejects them).

### Journal identity and version

- **Identity:** one journal per `(campaign_id, session_id)`, stored in the journal's module flags.
- **Version:** `(recap_revision, content_hash)`, also stored in flags.

### Import rules

| Existing journal for `(campaign_id, session_id)`           | Incoming package                       | Result                                                                              |
| ---------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------- |
| none                                                       | valid                                  | create journal, GM-only ownership for the entry and every page                      |
| same `recap_revision`, same `content_hash`                 | —                                      | **no-op** (report "already imported")                                               |
| same `recap_revision`, different `content_hash`            | —                                      | **reject as conflict**: two different contents claim the same revision              |
| older `recap_revision` than incoming, not published        | newer revision                         | **update after explicit confirmation** in the import dialog                         |
| older `recap_revision` than incoming, published to players | newer revision                         | **explicit update decision**: keep published version or replace it; never automatic |
| newer `recap_revision` than incoming                       | older revision                         | **reject as stale**                                                                 |
| any                                                        | invalid schema, hash mismatch, bad IDs | **reject** with an actionable message (path + reason, no content echoed)            |

- Import never publishes. Publishing to players is a separate explicit action (T19).
- The importer validates the package against `recap-package.schema.json` and sanitizes all text and
  footnotes with an allowlist before rendering (plan section 5, risk 7). IDs are pattern-restricted,
  so they are safe in HTML attributes.

## Consequences

- Importing the same package twice leaves one journal (T19 acceptance).
- An edited-after-approval recap cannot be exported without re-approval.
- The Foundry module depends on `packages/contracts` for the schema and on ADR-010 for the hash; it
  needs no access to SQLite or the session package.
- A `recap_revision` is exported with at most one `content_hash`. If content changes after a
  revision was exported, the next export must use a new, higher revision number, otherwise the
  importer rejects it as a conflict. How edited content gets its revision number is decided in
  ADR-010 (fork on the first content edit after export) and implemented in T15.

## Alternatives considered

- **Approval as a boolean flag on the revision.** Rejected: edits after approval would go unnoticed.
- **Journal identity by title or by Foundry document ID.** Rejected: titles change, and document IDs
  differ per world and are unknown to the exporter.
- **Last import wins.** Rejected: silently overwrites published or newer content.
