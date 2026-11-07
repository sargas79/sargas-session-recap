# G01: Product go/no-go and draft-quality/review-time thresholds

**Outcome: PENDING (human decision)**

| Field | Value |
|---|---|
| Gate | `G01`, issue [#17](https://github.com/sargas79/sargas-session-recap/issues/17) |
| Parent | `F00`, issue #2 (roadmap #1) |
| Question | Given S01, S04 and S05 evidence, is the product worth building, and what numeric thresholds will the MVP be held to? |
| Blocks | #26 `T08`, #27 `T10`, #38 `G02` (all require G01 **PASS**) |
| Machine-readable companion | [`G01-thresholds.template.yaml`](G01-thresholds.template.yaml), copied to `G01-thresholds.yaml` once decided |

> **This is a template prepared by an agent.** Every blank field (`____`) is a GM decision.
> Agents must not fill in the decision, thresholds, chosen model/backend or outcome, and must not close #17.
> See [README](README.md).

---

## 1. Inputs

### 1.1 Required spikes (blocking)

| Spike | Issue | Evidence doc | Outcome (PASS / FAIL / UNRESOLVED) | Outcome comment link | Key numbers used below |
|---|---|---|---|---|---|
| `S01` manual recap baseline | [#11](https://github.com/sargas79/sargas-session-recap/issues/11) | [`docs/spikes/S01-manual-baseline.md`](../spikes/S01-manual-baseline.md) | ____ | ____ | ____ |
| `S04` whisper.cpp Vulkan benchmark | [#14](https://github.com/sargas79/sargas-session-recap/issues/14) | [`docs/spikes/S04-whisper.md`](../spikes/S04-whisper.md) | ____ | ____ | ____ |
| `S05` Claude Code / API backends | [#15](https://github.com/sargas79/sargas-session-recap/issues/15) | [`docs/spikes/S05-llm-backends.md`](../spikes/S05-llm-backends.md) | ____ | ____ | ____ |

S01 recommendation (proceed / adjust / stop) and its proposed thresholds: ____

### 1.2 Informational spikes (do not gate G01)

| Spike | Issue | Evidence doc | Status at decision time (PASS / FAIL / UNRESOLVED / not yet run) | Notes |
|---|---|---|---|---|
| `S02` Discord/DAVE capture | [#12](https://github.com/sargas79/sargas-session-recap/issues/12) | `docs/spikes/S02-discord-capture.md` | ____ | ____ |
| `S03` Foundry v14/PF2e | [#13](https://github.com/sargas79/sargas-session-recap/issues/13) | `docs/spikes/S03-foundry.md` | ____ | ____ |

## 2. Decision

Decision (one of `GO` / `NO-GO` / `GO-WITH-CHANGES`): ____

Reasoning (cite the evidence above): ____

## 3. Changes required (only for GO-WITH-CHANGES)

Each change must name the issue(s) it affects. Scope changes go into those issues or a new issue, not only here.

| # | Change | Affected issue(s) | Owner | Tracked in |
|---|---|---|---|---|
| 1 | ____ | ____ | ____ | ____ |
| 2 | ____ | ____ | ____ | ____ |

## 4. Thresholds

All metrics are measured by T20 `recap eval` ([#34](https://github.com/sargas79/sargas-session-recap/issues/34)) and
compared by G02 ([#38](https://github.com/sargas79/sargas-session-recap/issues/38)). Each metric is measured on one of two
bases, given per row in the "Measured on" column (YAML `measured_on`):

- **`held_out_subset`**: the GM-labelled S01 held-out subset (never the tuning subset). Used for the label-based quality
  metrics only. This subset is part of the ~30 min labelled sample, not a whole session, so it is not used for timing,
  usage or review time.
- **`full_reference_session`**: one complete recorded session (the reference session, recorded in section 4.1 and YAML
  `reference_session`), processed end to end. Used for processing time, usage and GM review time. The from-scratch
  baseline for the review-time ratio must cover the same complete session, so both sides of the ratio are the same
  workload.

Every comparison is "measured value must be **at most** the threshold". Counts use the labelling guide's definitions
(`docs/evaluation/labelling-guide.md`).

"Issue target" is the value written in #17 itself; the GM still records the binding threshold.

| YAML key | Metric | Precise definition | Unit | Measured on | Measured by (T20 `recap eval` metric) | Issue target | Baseline from S01 | Threshold | Rationale |
|---|---|---|---|---|---|---|---|---|---|
| `important_ic_labelled_ooc` | Important IC labelled OOC (decisions/clues lost) | Number of GM-labelled recap-critical IC items (decisions, clues) whose segments the pipeline labelled `ooc` and so excluded from the recap | count per session | `held_out_subset` | `false_exclusions_ic_to_ooc` (false exclusions, IC→OOC), restricted to recap-critical items | 0 | ____ | ____ | ____ |
| `ooc_labelled_ic_rate` | OOC labelled IC rate | (GM-labelled `ooc` segments the pipeline labelled IC/included) ÷ (all GM-labelled `ooc` segments) | ratio 0–1 | `held_out_subset` | `ooc_inclusion` (OOC inclusion) | — | ____ | ____ | ____ |
| `unsupported_draft_claims_per_recap` | Unsupported draft claims | Draft recap sentences/claims that their cited current-session evidence does not support, e.g. invented facts. **Includes proposed-as-done errors** (a merely proposed action stated as having happened): each one counts toward this total, even though T20 also reports them as a separate sub-count | count per recap | `held_out_subset` | `unsupported_draft_claims` (total, including proposed-as-done) | — | ____ | ____ | ____ |
| `critical_omissions` | Critical omissions | GM-labelled recap-critical items present in the session but absent from the draft recap, for any cause | count per session | `held_out_subset` | `critical_omissions` | 0 | ____ | ____ | ____ |
| `gm_review_time_ratio` | GM review time vs from-scratch | GM minutes to review/edit the draft recap of the reference session to approval ÷ GM minutes to write a recap of that same complete session from scratch (from S01, recorded in `baseline_from_scratch_minutes`) | ratio | `full_reference_session` | `editing_time` (manual entry) ÷ S01 baseline | — | ____ (from-scratch: ____ min) | ____ | ____ |
| `processing_time_per_session` | Processing time per session | Unattended wall-clock time from imported audio to draft recap (ASR + classification + recap), excluding GM review, for the complete reference session | minutes wall-clock per session | `full_reference_session` | `processing_time` | — | ____ | ____ | ____ |
| `usage_cost_per_session` | Usage / cost per session | LLM usage per session as reported by the chosen backend: input tokens, output tokens and/or USD, for the complete reference session. Only the sub-fields relevant to the chosen backend are binding | tokens and/or USD per session | `full_reference_session` | `usage` | — | ____ | ____ | ____ |

Counting rule for proposed-as-done errors: they are a subset of unsupported draft claims. T20 reports them as a
separate sub-count for diagnosis, but they are never subtracted from `unsupported_draft_claims`, and
`unsupported_draft_claims_per_recap` is checked against the total that includes them. #17 does not ask for an extra
threshold on the sub-count alone. If the GM wants one, add a key to the YAML and to this table in the same change; it
applies in addition to, not instead of, `unsupported_draft_claims_per_recap`.

### 4.1 Reference session (for `full_reference_session` metrics)

| Field | Value |
|---|---|
| Reference session (identifier; the S01 recorded session unless the GM chooses another) | ____ |
| Audio length (min) | ____ |
| From-scratch recap of this same session: GM minutes (source) | ____ |

### 4.2 YAML key reference

The companion file uses these keys, which T20 reads from `docs/decisions/G01-thresholds.yaml`:

- Top level: `schema_version`, `gate`, `issue`, `outcome` (`PENDING` / `PASS` / `FAIL`), `decision`
  (`GO` / `NO-GO` / `GO-WITH-CHANGES`), `decided_by`, `decided_on`, `decision_record`, `reference_session` (`id`, `audio_minutes`).
- `thresholds.<key>` for each key in the table above, with fields `unit`, `comparison` (always `max`), `t20_metric`,
  `issue_target`, `baseline_s01`, `threshold`, `rationale`, `measured_on` (`held_out_subset` /
  `full_reference_session`).
  - `gm_review_time_ratio` also has `baseline_from_scratch_minutes`.
  - `unsupported_draft_claims_per_recap` also has `includes_proposed_as_done` (always `true`; see the counting rule above).
  - `usage_cost_per_session.baseline_s01` and `.threshold` are maps with `input_tokens`, `output_tokens`, `usd`.
- `whisper`: `model`, `model_sha256`, `whisper_cpp_version`, `invocation`, `chunk_length_seconds`, `evidence`.
- `llm_backend`: `path`, `model_id`, `evidence`.
- `informational`: `s02_discord_status`, `s03_foundry_status`.

T20 must treat `outcome: PENDING` or a `null` binding threshold as "no thresholds recorded" and must not report PASS.

## 5. Chosen Whisper model and invocation

Must cite S04 measurements (benchmark per model, real-time factor, name/term accuracy with and without glossary prompt).

| Field | Value |
|---|---|
| Model | ____ |
| Model SHA-256 | ____ |
| whisper.cpp version/commit | ____ |
| Invocation (exact flags) | ____ |
| Chunk length (s) / pause-split strategy | ____ |
| S04 evidence (doc section + #14 outcome comment) | ____ |

## 6. Chosen LLM backend path

Must cite S05 evidence (verified, dated terms; model IDs actually available; tool disabling; schema validation; usage fields).

| Field | Value |
|---|---|
| Backend path | ____ |
| Model ID (verified) | ____ |
| Terms/usage check date | ____ |
| Fallback path (if any) | ____ |
| S05 evidence (doc section + #15 outcome comment) | ____ |

## 7. Branch status (informational)

| Branch | Source | Status | Consequence |
|---|---|---|---|
| Discord recorder (`T06`, #25) | S02 (#12) | ____ (ENABLED / DEFERRED / not yet known) | ____ |
| Foundry delivery (`F06`, T16–T19) | S03 (#13) | ____ (PASS / FAIL / not yet known) | ____ |

Per roadmap #1: Discord failure defers the bot but does not block the import path; Foundry delivery need not block
the imported-audio recap path.

## 8. Sign-off

| Field | Value |
|---|---|
| GM name | ____ |
| Date (YYYY-MM-DD) | ____ |
| `G01-thresholds.yaml` committed and matches this document | ____ (yes/no) |
| #17 outcome comment link | ____ |

Final outcome line (GM replaces the line at the top of this file):
`Outcome: PASS` (decision GO or GO-WITH-CHANGES) or `Outcome: FAIL` (decision NO-GO).
