# ADR-002: `schema_version` placement

- Status: Accepted
- Date: 2026-11-07
- Task: T02 (#18)
- Related: ADR-001

## Context

Contracts are stored as whole JSON documents (`manifest.json`, `recap.json`, the recap package), as
JSON Lines (`fragments.jsonl`, `segments.jsonl`, `results.jsonl`, `foundry.jsonl`) and as SQLite rows
(job records, review overrides). Some of them are read in isolation: a JSONL stream is validated line
by line, a single SQLite row is exported, and the Foundry module reads a package with no manifest
around it. The version has to be found wherever a record can be read on its own.

## Decision

**`schema_version` is per record, in every contract, as a required top-level integer.**

- Every whole document and every JSONL line carries `schema_version`. SQLite tables that store a
  contract carry a `schema_version` column with the same meaning.
- The value is an integer starting at `1`, pinned with `const` in the schema of that version. It is
  versioned per contract: `fragment` v2 does not imply `manifest` v2.
- Any change to a contract's schema bumps that contract's `schema_version`. All schemas set
  `additionalProperties: false`, so even an added optional field is a breaking change for readers and
  needs a bump.
- The schema `$id` carries the version: `urn:sargas-recap:schema:<name>:v<version>`.
- Readers reject unknown versions with an actionable error naming the record and the version.
  Migration code (if ever needed) upgrades records explicitly; nothing guesses.
- The manifest does **not** declare versions for the other artifacts. It would duplicate what every
  record already says (ADR-001).
- Nested objects inside a record do not carry their own version.

## Consequences

- Every JSONL line can be validated alone, and a stream that mixes versions is detected per line.
- A few bytes per JSONL line. Accepted: a 4-hour session has a few thousand segments.
- A schema change is a visible diff in `packages/contracts/schemas/` and a version bump, which the PR
  checklist (ADR/schema changes) makes explicit.
- SQLite migrations (ADR-009, T25) and contract versions are independent: a migration can add a
  column without changing a contract, and a contract bump needs a migration only if the stored shape
  changes.

## Alternatives considered

- **Per manifest only** (manifest lists the version of each artifact). Rejected: records read
  outside the package (SQLite rows, the Foundry package, a single JSONL line in a test) would have no
  version, and the manifest becomes a second place that must agree with the files.
- **Per file header line in JSONL.** Rejected: JSONL tools and streaming validators treat every line
  alike; a special first line breaks `cat a.jsonl b.jsonl` and line-level validation.
- **Semantic versions (`1.2.0`).** Rejected: with closed schemas there is no compatible minor change
  to express; an integer is enough and is cheaper to compare.
