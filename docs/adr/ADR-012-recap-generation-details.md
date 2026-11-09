# ADR-012: Recap generation details

- Status: Accepted
- Date: 2026-11-09
- Task: T13 (#32)
- Related: ADR-002, ADR-004, ADR-005, ADR-010, ADR-011

## Context

T13 turns the effective transcript into `recap/<revision>/`. ADR-004, ADR-005 and ADR-010 fix the
identities, the refusal on lost exclusions and the revision allocator, but left open what the model
is asked to return, what a claim without evidence becomes, and how earlier recaps may be used.

## Decision

1. **New contract `recap-model-output`.** The model returns only what it can know: title, sentences
   and GM notes, citing the short `<chunk>:<seq>` refs it was shown. Core fills in every other field
   and resolves the refs. The `recap` contract is unchanged (ADR-002); `LlmBackend.writeRecap` now
   returns this type, as `classify` already returned its own model type.
2. **Only effective `include` segments reach the prompt.** Excluded and unresolved segments are not
   rendered at all, so there is no context path for them. Recap generation refuses before any
   provider call while `unreconciledExclusions()` returns anything (ADR-005, point 7).
3. **A citation of anything not sent fails the attempt.** That covers invented refs, other sessions
   and excluded or unresolved segments, and it costs one of the attempt's retries.
4. **An uncited or `background` claim becomes a GM note** with reason `unsupported`, because it is
   not evidence of this session. It is a note rather than a failure so that one unsupported line
   does not discard a usable draft. A `background` sentence is demoted even with citations: its
   citations can show that someone mentioned the past, not that it happened in this session. If no
   sentence survives, the attempt fails.
5. **GM notes.** Core adds one note listing the segments waiting for a GM decision; it holds their
   IDs and a count, no words. A GM note may cite an unresolved segment; nothing ever cites an
   excluded one. Notes are kept in `gm-notes.md`, apart from `recap.md`.
6. **Earlier recaps are background only, and are filtered.** The latest recap of each of the three
   nearest earlier sessions in the campaign (by manifest `created_at`) goes in as text with no
   citations and no GM notes. A sentence goes in only while every segment it cites is still included
   in that session's effective transcript, and a recap whose transcription run is no longer active
   is skipped. The speakers of those segments join the consent check. They are recorded as job
   receipts, so regenerating an old session does not rerun every later one.
7. **Foundry events are not sent yet.** `foundry.jsonl` holds raw, system-specific payloads that may
   carry private rolls or whispers, and has no verified alignment to the transcript until T17 and
   T18. Until then `event_ids` is empty and any event citation fails the attempt.
8. **Revisions are allocated after validation passes** (`recap_revisions`, migration 0004), so a
   failed attempt costs no number; T15 adds `origin = 'fork'` rows to the same table.

## Consequences

- Prompt `recap.draft@v2` is a first draft. S01 was waived, so no labelled data exists and recap
  quality is unmeasured; the GM's review (T14, T15) is the only check on content today.
- Earlier recaps are unapproved drafts until T15 exists. T15 can narrow the selection to approved
  revisions.
- T17/T18 add the events: a new prompt version and a populated evidence set, with no contract change.

## Alternatives considered

- **Reject the whole attempt on an uncited sentence.** Rejected: the issue allows either, and a note
  keeps the draft while still telling the GM what lacked evidence.
- **Send raw Foundry payloads now.** Rejected: see point 7.
- **Allocate the revision before the model call.** Rejected: every failed attempt would burn a number.
