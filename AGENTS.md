# AGENTS.md — rules for AI agents working in this repository

This file is binding for every AI agent (and a good default for humans). Scope, order and gates come
from the roadmap, [issue #1](https://github.com/sargas79/sargas-session-recap/issues/1). The execution
plan and technical decisions are in [`docs/implementation-plan.md`](docs/implementation-plan.md).

## 1. Picking up work

1. **Leaf issues only.** Pick a `[TASK]` or `[SPIKE]` leaf. Never implement a feature parent (`Fxx`) or the
   roadmap as one change. Parent tracking issues do not block their own children.
2. **Check prerequisites before starting.** Every issue listed under _Blocked by_ must be closed, and every
   gate under _Gate conditions_ / `gates_require_pass` must be closed **with a recorded PASS**. A closed
   failed spike does not authorize its gated work.
3. **Prefer the lowest wave.** Pick the lowest `wave:NN` whose issue is open, unblocked and labelled
   `agent:ready` (or `agent:assisted` for the agent-doable part only). Never pick `agent:human-required`,
   `agent:not-ready` or `[DEFERRED]` work.
4. **One leaf per PR.** Do not bundle leaves. Do not expand scope beyond the issue's _Deliverables_ and
   _Out of scope_.
5. **Spikes and gates are never closed by an agent.** Spikes record an explicit pass / fail / unresolved
   outcome with evidence; a human closes them. Gates (`Gxx`) are human decisions.

## 2. Human steps: stop and report

Never fabricate human-required work: experiments that need people, consent, live calls, subjective
evaluation, credentials, purchases or approvals. When you reach one, **stop and report the exact manual
step** (what, who, where, and what evidence to record). Do not simulate the result or mark it done.

## 3. Data and secrets

- **Synthetic or anonymized fixtures only.** Never commit raw session recordings, private transcripts,
  real consent records, secrets, API keys or tokens.
- Session data lives outside the repo (`sessions/`, audio, transcripts and SQLite files are git-ignored).
- **Logs must not carry content or secrets.** Use the core logger (`packages/core/src/log/`): only
  fields on its allowlist are emitted. Do not add free-text, transcript, prompt or credential fields to
  the allowlist.

## 4. Architecture guardrails

Follow the recorded decisions. Do not silently add a facts service, distributed queue, automatic
publishing to players, or an additional AI provider. Spike harnesses under `spikes/` are throwaway and must
never be imported by `packages/*`.
Every provider call (capture, ASR, classification, recap) must first pass `assertConsent()` from
`packages/core/src/config/` (T04); never reimplement or bypass the consent check. The default is
`consent_mode: implied` (attending the GM's table is consent, no records needed); the GM can require
dated records per campaign (`consent_mode: records`, `recap config consent on`). In both modes
`assertConsent()` still runs and still refuses speakers not listed in `campaign.yaml`.

### Prompts (T26)

- LLM prompts live in `packages/core/prompts/<stage>/<name>.v<N>.md` and are loaded only through the
  prompt registry (`packages/core/src/prompts/`). Classify and recap stages record the prompt they use
  as a job input (`promptJobInput()`); the runner refuses those stages without one.
- **Editing a prompt requires a version bump.** A committed `<name>.v<N>.md` is immutable: copy it to
  `<name>.v<N+1>.md`, set `version: N+1`, edit the copy, and add its hash to
  `packages/core/test/prompts/prompt-hashes.json` (the failing test prints it). Never change an
  existing line of that file. Line endings do not count as an edit (the hash normalizes them).
- **Prompts are tuned only against the S01 tuning subset.** Never show the S01 held-out subset (or
  any other evaluation data) to a prompt-tuning loop; see `docs/evaluation/labelling-guide.md`
  section 5.
- Transcript text and anything else from a session is untrusted data. It goes only into a declared
  `{{data:<slot>}}` slot, rendered inside a nonce-tagged `untrusted-data-<nonce>` block; never
  interpolate it into instruction text.

### Stack (decided in T01, see plan section 3)

| Area       | Decision                                                                                                                    |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| Runtime    | Node.js 24 LTS, ESM (`"type": "module"`), pinned via `engines` and `.nvmrc`                                                 |
| Language   | TypeScript strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`; shared `tsconfig.base.json`                  |
| Imports    | Relative imports use the `.ts` extension (rewritten to `.js` on build); erasable syntax only so Node can run `src/` direct  |
| Layout     | npm workspaces: `packages/core` (CLI + stage modules), `packages/contracts` (schemas, T02); `packages/foundry-module` (T24) |
| CLI        | `commander`, bin `recap`, one command per module                                                                            |
| Tests      | Vitest; fixtures under `fixtures/`; CI matrix ubuntu-latest + windows-latest                                                |
| Lint/style | ESLint flat config + typescript-eslint (strict, type-checked); Prettier                                                     |
| Schemas    | TypeBox (or Zod 4) → JSON Schema 2020-12, validated with Ajv (T02)                                                          |
| SQLite     | `better-sqlite3`, WAL, versioned migrations in `packages/core/src/db/migrations` (`node:sqlite` fallback)                   |
| Config     | `yaml`, validated by the same schemas (T04)                                                                                 |
| Secrets    | `@napi-rs/keyring` (Windows Credential Manager); env vars only for CI                                                       |
| IDs        | Run IDs: ULID. Segment/sentence IDs deterministic within a run (`<run>:<chunk>:<n>`)                                        |
| Logging    | Structured JSON logger with an explicit field allowlist (`packages/core/src/log/`)                                          |
| Review UI  | Server-rendered HTML + small vanilla TS/htmx client, esbuild, bound to 127.0.0.1 (T14)                                      |

## 5. PR conventions (plan section 7)

- Branch: `t01-bootstrap`, `t02-contracts`, … (lowercase stable ID + short slug).
- PR title: `[T01] …` (stable ID prefix). Commit messages start with the same prefix.
- PR body: `Closes #<issue>`, links every prerequisite issue and the recorded gate outcomes it relies on.
- Checklist (see `.github/pull_request_template.md`): the issue's acceptance criteria copied in and ticked
  with evidence; tests added; Windows docs updated; ADR/schema changes listed; no real data or secrets.
- CI must be green on **Windows and Ubuntu** before merge.

## 6. Local checks before opening a PR

```sh
npm ci
npm run lint
npm run typecheck
npm run build
npm test
npm run format:check
```

Run the CLI with `npm run recap -- <command>` or `npm exec --no -- recap <command>`. Do not use a bare
`npx recap`: if the local bin is not linked, npx falls back to an unrelated `recap` package on the npm
registry.
