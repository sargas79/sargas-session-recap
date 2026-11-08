# S01: Manual recap quality baseline and tuning/held-out evaluation sample

Issue: #11 (`S01`, parent #2 `F00`, roadmap #1). Blocks #17 `G01` and #34 `T20`.
Type: SPIKE, **human-required**. This file is a template prepared by an agent; every number below must be filled
in by the GM from a real run. Empty cells are intentional. Do not fill them with estimates you did not measure.

**Outcome: UNRESOLVED (not run; waived by the GM on 2026-11-08)**

The GM will not be able to run this spike and decided to continue on the assumption that a generated recap saves
review time compared with writing one from scratch. That assumption is **untested**: every result cell below stays empty
on purpose, and no baseline, label or measurement exists.

Consequences:

- No from-scratch baseline exists, so `gm_review_time_ratio` in `docs/decisions/G01-thresholds.yaml` has no S01 baseline.
- No tuning or held-out subset exists, so prompts cannot be tuned against labelled data until the GM labels a sample.
- T20 (#34) requires S01 to record PASS, which this outcome does not satisfy. The GM must change that gate before T20
  starts; T20 must not report PASS on a metric that has no threshold.

---

## 1. Question

Does a manually produced recap (whisper.cpp transcript + Claude Project classification/recap by hand) need clearly
less GM time than writing a recap from scratch, and what are the baseline omissions, unsupported claims and
editing time?

## 2. Method

1. One real PF2e session, recorded multitrack (one file per speaker) with the table's consent.
2. Local transcription with whisper.cpp, using the S04 (#14) setup and model.
3. **Before any model output exists for the session**, the GM picks ~30 min to label, freezes a tuning/held-out
   split by segment time ranges, and labels the sample (schema:
   [`fixtures/evaluation/label.schema.json`](../../fixtures/evaluation/label.schema.json)), following the
   [labelling guide](../evaluation/labelling-guide.md) sections 2 (rule 7), 5 and 8.
4. A **manual** Claude Project pass: paste the transcript, ask for segment classification (six labels from the
   labelling guide) and a Portuguese player-facing recap. No pipeline code, no prompt engineering beyond one
   reasonable prompt (out of scope for S01).
5. The GM edits the draft into a recap they would actually publish, **timing the edit**.
6. The GM estimates (or, better, separately measures on a comparable session) the time to write the recap from scratch.
7. The GM compares the draft against the final recap and the labelled sample to count omissions, unsupported claims
   and proposed-vs-completed confusions, each with a cause.

Private material (audio, transcript, Claude outputs, labels, consent) stays **outside git**, e.g.
`%USERPROFILE%\sargas-recap-private\s01\`. This file records only numbers, causes and pseudonymous references.

## 3. GM procedure (step by step)

### 3.1 Before the session

- [ ] Ask every participant for consent, separately, to: (a) recording, (b) local transcription, (c) processing of
      the transcript by Claude (Anthropic) via a Claude Project, (d) use of a labelled excerpt for evaluation/tuning.
      Record who/when/how in the private consent record outside git ([guide section 6](../evaluation/labelling-guide.md#6-consent-provenance-outside-git)).
- [ ] Assign pseudonymous track IDs (`gm`, `p1`, `p2`, ...). The ID-to-person mapping lives only in the private folder.
- [ ] Prepare the campaign glossary seed (NPCs, places, PF2e terms the table uses) in the private folder.
- [ ] Check the multitrack recorder writes one file per speaker and note each track's start offset.

### 3.2 Session

- [ ] Record the whole session. Note wall-clock start/end and any recording interruptions.
- [ ] Optional: jot timestamps of scene changes and memorable moments (helps pick the labelling sample).

### 3.3 Transcription (S04 setup)

- [ ] Run whisper.cpp per track with the S04 binary/model; keep the raw JSON output privately.
- [ ] Record: whisper.cpp version/commit, model name + file hash, GPU/backend, wall-clock processing time, audio duration.
- [ ] Merge per-track segments onto the shared session timeline (apply track offsets) into one transcript.

### 3.4 Labelling and split freeze (~30 min of audio, one evening)

- [ ] Do this **before running the Claude pass (3.5)**, so neither the sample choice nor the split nor any label is
      influenced by model output ([guide section 5](../evaluation/labelling-guide.md#5-tuning-vs-held-out-split)).
- [ ] Pick ~30 min that include roleplay, combat, at least one joke, overlapping speech and a scene change.
- [ ] Fix the tuning/held-out split by time ranges first and set `split.frozen_on`.
- [ ] Then label every segment following the [labelling guide](../evaluation/labelling-guide.md), in a private copy.
- [ ] Validate: `cd spikes\s01-labels; npm install; node src\cli.ts <private-path>\labels.json` (must print `OK`).
- [ ] Record the time spent labelling.

### 3.5 Manual Claude Project pass

- [ ] Only start once 3.4 is done and the label file validates.
- [ ] Create a Claude Project (or reuse one) with the glossary seed as project knowledge.
- [ ] Paste the merged transcript. Use one classification + recap prompt; save the exact prompt text privately.
- [ ] **Do not** paste the held-out part into any conversation used to iterate on the prompt (split frozen in 3.4).
      For the baseline you may run the whole session once, but keep that conversation separate from any prompt tuning.
- [ ] Record: model shown in the UI, number of messages, any truncation/context errors, wall-clock time, plan/usage
      indicators shown (do not assume billing details you cannot see).

### 3.6 Timing the edit

- [ ] Start a timer when you open the draft; stop it when the recap is ready to publish. Pause it for breaks.
- [ ] Record active editing minutes. Keep the draft and the final version privately for the comparison.

### 3.7 From-scratch estimate

- [ ] Record how long you normally take to write a recap of a session this long, and how you know
      (measured on session X / typical from memory). If possible, time a from-scratch recap of a comparable session.

### 3.8 Comparison

- [ ] For every recap-critical item in the labelled sample: is it in the draft? If not, count an omission and give
      its cause. Also note omissions you notice outside the sample (separate column).
- [ ] For every draft sentence: is it supported by the transcript? If not, count an unsupported claim and give its cause.
- [ ] Count proposed-vs-completed and roll-vs-narrative confusions.
- [ ] Record Claude's label vs your label for the sample segments (confusion counts in 4.5).

## 4. Results (fill in; numbers, not adjectives)

### 4.1 Session and sample

| Field | Value |
|---|---|
| Session date (YYYY-MM-DD) | |
| Session duration (min) | |
| Number of speakers / tracks | |
| Language mix (approx. % PT / EN) | |
| Consent recorded outside git (yes/no; record ID) | |
| Labelled sample duration (min) | |
| Labelled segments: tuning / held-out / excluded | |
| Split frozen on (date) | |
| Labelling time (min) | |

### 4.2 Editing time

| Measure | Value | How measured |
|---|---|---|
| GM editing time of the Claude draft (active min) | | |
| From-scratch recap time (min) | | measured / estimated from |
| Ratio editing / from-scratch | | |
| Draft length (sentences) | | |
| Final recap length (sentences) | | |
| Draft sentences kept unchanged / edited / deleted | | |
| Sentences added by GM | | |

### 4.3 Omissions (recap-critical items missing from the draft)

| # | Item type (decision/clue/npc_name/loot/action/outcome/location/other) | In labelled sample? (subset) | Segment ref (speaker, start-end ms) | Cause | Severity (critical/minor) |
|---|---|---|---|---|---|
| 1 | | | | | |
| 2 | | | | | |
| 3 | | | | | |

Cause vocabulary (extend if needed): `asr_error`, `asr_dropped_short_segment`, `misclassified_as_ooc`,
`crosstalk`, `context_limit`, `summarised_away`, `glossary_name_wrong`, `other:<text>`.

| Totals | Count |
|---|---|
| Omissions in sample (of N critical items) | |
| Omissions outside sample (noticed) | |

### 4.4 Unsupported claims (draft statements not supported by the transcript)

| # | Claim type (invented event/wrong actor/wrong name/wrong outcome/background as current/other) | Draft sentence ref | Cause | Severity |
|---|---|---|---|---|
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |

Cause vocabulary: `hallucination`, `roll_read_as_outcome`, `proposed_read_as_completed`, `ooc_included`,
`previous_session_recap_used`, `asr_error`, `speaker_attribution`, `other:<text>`.

| Totals | Count |
|---|---|
| Unsupported claims | |
| Draft sentences | |
| Unsupported claims per 10 draft sentences | |

### 4.5 Proposed vs completed and roll vs narrative confusions

| Confusion | Count | Examples (segment refs only) |
|---|---|---|
| Proposed action recapped as completed | | |
| Abandoned action recapped as completed | | |
| Completed action missing or recapped as only proposed | | |
| Roll-only outcome recapped with an invented consequence | | |

Label agreement on the sample (Claude label vs GM label, segment counts):

| GM \ Claude | ic | narration | rules | ooc | mixed | uncertain |
|---|---|---|---|---|---|---|
| ic | | | | | | |
| narration | | | | | | |
| rules | | | | | | |
| ooc | | | | | | |
| mixed | | | | | | |
| uncertain | | | | | | |

| Derived | Value |
|---|---|
| OOC segments included in recap-relevant labels by Claude | |
| Recap-relevant segments labelled `ooc` by Claude (false exclusions) | |

### 4.6 Processing time and usage

| Step | Wall-clock (min) | Tool/version | Usage (as shown; do not infer) |
|---|---|---|---|
| whisper.cpp transcription (all tracks) | | | n/a |
| Merge onto shared timeline | | | n/a |
| Claude Project classification | | model: | |
| Claude Project recap | | model: | |
| Total GM hands-on time (excl. session) | | | |

## 5. Proposed G01 thresholds (to be proposed by the GM, decided in #17)

Leave blank until the results above exist. These are proposals; G01 records the decision.

| Threshold | Proposed value | Rationale (from the numbers above) |
|---|---|---|
| Max GM editing time per session-hour (min) | | |
| Max editing / from-scratch ratio | | |
| Max critical omissions per session (or per N critical items) | | |
| Max unsupported claims per 10 recap sentences | | |
| Max proposed-vs-completed confusions per session | | |
| Max OOC inclusion rate (%) | | |
| Max false exclusion rate of recap-relevant segments (%) | | |
| Max processing wall-clock per session-hour (min) | | |

## 6. Recommendation

- Recommendation (proceed / adjust / stop):
- Reasons:
- Adjustments, if any:

## 7. Evidence and provenance

- Consent provenance: recorded outside git; record ID:
- Private evidence folder (path only, no contents):
- Label file validated with `spikes/s01-labels` (commit hash of the validator):
- Prerequisite outcomes referenced: S04 (#14) setup used:
- Links to the closing comment on #11:

## 8. Outcome

Set exactly one, as the last line of the closing comment on #11 too. FAIL is a valid outcome and does not
authorize gated work.

`Outcome: UNRESOLVED` (not run; waived by the GM on 2026-11-08, see the top of this file)
