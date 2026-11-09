# ADR-011: Review projection details

- Status: Accepted
- Date: 2026-11-09
- Task: T12 (#30)
- Related: ADR-001, ADR-002, ADR-005

## Context

T12 implements ADR-005. Three things it needed were not decided there: how a GM sees what the
effective text replaced, what an override means when it says nothing about recap inclusion, and how
an unreconciled override with no counterpart ever leaves the queue, given that an unreconciled
exclusion blocks the recap (ADR-005, point 7).

## Decision

1. **New derived contract `effective-transcript-review`.** The `effective-transcript` contract holds
   only the effective values. The review view adds, per segment, `text_original`, `text_hash`,
   `text_corrected`, `text_override`, `corrections`, the classification label before overrides, the
   segment and classification flags, ASR confidence and the attached `override_id`; and per
   unreconciled override, its run, reason and exclusions. Like the plain projection it is derived,
   never stored, and owned by nothing (ADR-001). It is a new contract so that `effective-transcript`
   and `review-override` keep their v1 schemas (ADR-002).
2. **Text precedence is override, then corrected, then original.** `text_corrected` is not treated as
   verified: a `spelling` correction has no glossary backing, so the review view always carries the
   original and the corrections.
3. **Recap inclusion, first match wins:**
   1. any `exclusion_reasons` on the attached override: `exclude`, even over an explicit `include`;
   2. an explicit GM decision (`include`, `exclude` or `unresolved`);
   3. no label yet: `unresolved`;
   4. effective label `mixed` with a `text_override`: `include` (ADR-005, point 8);
   5. `defaultRecapInclusion(effective label)`.
4. **"No decision" is `NULL` in `review_overrides.recap_inclusion`.** An override that only sets a
   label or a review status must not freeze the inclusion or hold back an in-character line, and an
   explicit `unresolved` must still hold one back, so the two have to differ. The `review-override`
   contract has no value for "no decision", so the row reads as `unresolved` there; the projection
   uses the stored value. This is the only place where the row and the contract differ in meaning.
5. **`review_required` also covers ASR doubts.** It is true when classification asked for review or
   the segment has `repetition_loop` or `low_confidence`. Flags never remove a segment.
6. **Reconciliation state is decided from identity on every projection** (ADR-005, point 4). The
   stored `reconciliation` column records the outcome, with a history entry; a stale value cannot
   cause an override to be applied.
7. **An unreconciled override leaves the queue in one of two explicit ways.**
   - Reconcile: a new row on a chosen segment of the active run (ADR-005, point 6). One old override
     may be applied to several segments (a split). The review status resets to `pending` when the
     target's text differs. A segment that already has an override is refused (a merge): the GM
     changes that override by hand, then discards the other.
   - **Discard (new):** `dismissed_at` retires the row, with a history entry. Without it an exclusion
     whose segment no longer exists would block the recap forever. Only an unreconciled override can
     be discarded, and only by an explicit GM command.
8. **The active runs are derived from jobs.** The active transcription run is the latest succeeded
   `transcribe` job. The active classification is the latest succeeded `classify` job whose inputs
   include that run's segments, so after a retranscription the old labels are not joined to the new
   segments.

## Consequences

- T13 reads `unreconciledExclusions()` to enforce ADR-005, point 7, and uses the effective
  `recap_inclusion`; `possible_spoiler` stays a visible flag and does not change inclusion by itself.
- T14 reads `effective-transcript-review` and lists `needs_reconciliation` first.
- A `review-override` record alone cannot show whether `unresolved` was a decision.
- A cleaned text is carried by a reconcile as it was written; the GM can change it afterwards.

## Alternatives considered

- **Add fields to `effective-transcript` and `review-override`.** Rejected for now: any added field
  requires a `schema_version` bump (ADR-002), and how to treat earlier unbumped changes is awaiting a
  GM decision.
- **`unresolved` also meaning "no decision".** Rejected: an explicit `unresolved` on an in-character
  line would be silently ignored.
- **Seed `recap_inclusion` from the label when the override is created.** Rejected: it would freeze
  a value derived from a classification run, so a rerun could leave an OOC line included.
- **Merging two overrides into one automatically.** Rejected: two cleaned texts or labels have no
  safe merge, and the GM can do it in one command.
