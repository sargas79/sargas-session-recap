# ADR-005: Review override reconciliation

- Status: Accepted
- Date: 2026-11-07
- Task: T02 (#18)
- Related: ADR-001, ADR-004, T12 (#30)

## Context

The GM spends real time on overrides: relabelling, excluding spoilers, writing a cleaned version of
mixed IC/OOC text. Those overrides must survive classification reruns and must never be attached to
the wrong segment after retranscription. Attaching by timestamp proximity is the obvious shortcut and
the obvious bug: a retranscription can split, merge or shift segments, and a spoiler exclusion that
silently lands on a neighbouring segment leaks the spoiler (plan section 5, risk 4).

## Decision

1. **Identity of an override is `(transcription_run_id, segment_id, base_text_hash)`.**
   `base_text_hash` is the segment's `text_hash` at the moment the override was created.
2. **`text_hash` definition:** `sha256:` + lowercase hex SHA-256 of the UTF-8 bytes of
   `text_original` after Unicode NFC normalization. No trimming or case folding. The transcription
   stage writes it into each segment; T03 provides the helper.
3. **Overrides key on the transcription run, not on classification.** A classification rerun
   changes `classification_run_id` and nothing else, so every override stays attached.
4. **Reapply only when the identity is valid.** When building the effective transcript, an override
   is applied iff a segment exists with the same `transcription_run_id` and `segment_id` and its
   `text_hash` equals `base_text_hash`. Otherwise the override is marked
   `reconciliation: needs_reconciliation`, is not applied, and is listed in the projection's
   `needs_reconciliation` array.
5. **Never match by timestamp proximity, speaker or text similarity.** No automatic reattachment
   across transcription runs. After retranscription, every override of the old run becomes
   `needs_reconciliation`.
6. **Reconciliation is an explicit GM action.** The review UI (T14) may _suggest_ candidates (for
   example a segment of the new run with the same `text_hash`), but applying one writes a new override
   row for the new run with `supersedes_override_id` pointing at the old one. The old row stays in
   history.
7. **Unreconciled exclusions block the recap.** While any override with a `spoiler` or `privacy`
   exclusion is `needs_reconciliation` for the active transcription run, recap generation (T13)
   refuses to run, so a lost exclusion cannot leak into a draft.
8. Mixed content enters the recap only with an explicit cleaned `text_override` or an explicit
   inclusion decision (T12).

## Consequences

- Classification reruns are safe by construction.
- Retranscription costs the GM a reconciliation pass. Accepted: correctness of exclusions matters more
  than convenience, and suggestions keep the pass short.
- The projection must surface unreconciled overrides first in the review queue (T14).
- Hash normalization (NFC) has to be implemented identically wherever the hash is computed; golden
  tests in T03 fix it.

## Alternatives considered

- **Attach by nearest timestamp.** Rejected: misattaches after resegmentation; this is the failure
  the design exists to prevent.
- **Attach by `(chunk_index, n)` across runs.** Rejected: a different chunk plan or glossary
  changes segmentation, so positions do not mean the same thing.
- **Key overrides on classification results.** Rejected: every reclassification would orphan GM
  work.
- **Auto-carry when text hash matches.** Rejected for automatic use (duplicate short lines like
  "Sim." match many segments); allowed only as a suggestion the GM confirms.
