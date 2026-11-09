# ADR-014: Recap editing and approval details

- Status: Accepted
- Date: 2026-11-09
- Task: T15 (#35)
- Related: ADR-001, ADR-007, ADR-010, ADR-012, ADR-013

## Context

ADR-007 and ADR-010 fix the approval binding, the state machine, the fork and the hash. T15 needed
a few decisions they left open: what blocks approval beyond ADR-010's export check, what happens to
a possible spoiler the GM never looked at, where a package goes, and how a form stays safe against
a stale page.

## Decision

1. **The same release gate for approval, export and Copy Markdown.** All three are refused while
   `unreconciledExclusions()` returns anything, and while a sentence cites a line that is excluded,
   waiting for a decision or missing from the active transcription. ADR-010 required this only for
   `spoiler` and `privacy` at export; since excerpts come from the transcript, any excluded citation
   would carry excluded text out, so all exclusions count. The GM fixes it by changing the
   sentence's citations or removing the sentence.
2. **Possible spoilers are acknowledged, not excluded.** `possible_spoiler` still does not change
   inclusion (ADR-011). Approving or exporting while any is still included needs a confirmation
   naming exactly that set of segments, so a line flagged after the page loaded is refused.
3. **Every release action names the content hash it looked at.** Review, approval and export carry
   `expected_hash`; edits carry the edit count. A mismatch is a refusal, never a silent retarget.
   Transactions re-read the logs, so a concurrent CLI or tab cannot slip between check and write.
4. **A sentence may cite only included lines of the active run.** Short `<chunk>:<seq>` refs are
   accepted. Foundry events cannot be added (ADR-012, point 7). A GM-edited sentence with no
   citations is allowed and shown as such; the package gives it no footnote.
5. **`exports/` in the session package.** A package goes to `exports/recap-r<revision>-<export_id>.json`,
   outside `recap/<revision>/`, which stays immutable. `recap_exports` holds no path (ADR-010); the
   name is derived from the revision and export ID.
6. **`draft_sha256` on `recap_revisions` (migration 0005).** A fork has no job to record its
   `recap.json` hash, so the revision row does, set last: a NULL means the fork did not finish and the
   number is a burned gap (ADR-010, section 3).
7. **`recap review --reviewer <slug>`** names the operator recorded on edits, approvals and exports
   (default `gm`), so the page has no name field to forget and the API cannot be told another
   reviewer.

## Consequences

- No contract changes. `recap-sentence-edit`, `recap-editorial-transition`, `recap-approval`,
  `recap-export-manifest` and `recap-package` are used as ADR-010 defined them.
- A package excerpt comes from the effective transcript at export time, so a re-export after a
  correction can differ in excerpts while the hash stays the same (ADR-010 allows this).
- The screen offers only the latest revision. An older revision can still be exported through its
  API route.

## Alternatives considered

- **Warn instead of refuse on a citation of an excluded line.** Rejected: the export would carry its
  excerpt, and the issue allows refusal.
- **Store acknowledged spoilers with the approval.** Rejected: it adds state to an approval whose
  contract does not have it, and a repeat confirmation at export costs one checkbox.
- **Exports inside `recap/<revision>/`.** Rejected: that directory is immutable after generation.
- **A reviewer field on each form.** Rejected: nothing to verify it against, and one more place to
  mistype.
