# Decision records

This directory holds the records for human decision gates (`Gxx` issues in roadmap
[#1](https://github.com/sargas79/sargas-session-recap/issues/1)).

| File | Gate | Issue | Status |
|---|---|---|---|
| [`G01-go-no-go.md`](G01-go-no-go.md) | `G01` Product go/no-go and thresholds | [#17](https://github.com/sargas79/sargas-session-recap/issues/17) | Template, outcome PENDING |
| [`G01-thresholds.template.yaml`](G01-thresholds.template.yaml) | `G01` machine-readable thresholds for T20 `recap eval` | #17 | Template, all values null |
| `G02-mvp-release.md` (not yet created) | `G02` MVP release approval | [#38](https://github.com/sargas79/sargas-session-recap/issues/38) | Not started |

## How a gate is recorded

1. The GM fills the decision record (`Gxx-*.md`) using the linked spike/evaluation evidence, and for G01 also
   copies `G01-thresholds.template.yaml` to `G01-thresholds.yaml` with the same values. Both are committed together.
2. The top line of the record changes from `Outcome: PENDING (human decision)` to `Outcome: PASS` or `Outcome: FAIL`.
3. Per roadmap #1, the outcome is recorded as **the last comment on the gate issue**, in the form
   `Outcome: PASS | FAIL` with links to the committed decision record and the evidence it relies on
   (spike docs and their own outcome comments). The GM then closes the issue.
4. Closing a gate with FAIL is valid and does **not** authorize work gated on it. Downstream issues that list
   "Requires PASS of" a gate start only after a recorded PASS.

## Rules for agents

- Agents may prepare templates, key definitions and scripts here. They **never** fill in a decision, a threshold,
  a chosen model/backend, a sign-off or an outcome, and never infer one from spike data.
- Agents never comment the outcome on, or close, a gate issue.
- Do not put secrets, real transcripts, consent records or other private session data in these files.
  Cite evidence by link or by aggregate numbers only.
- The YAML key names are a contract with T20 (#34). Changing them means bumping `schema_version` and updating the
  Markdown key reference in the same change.
