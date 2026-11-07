# Session Recap Bot — Implementation Plan

Status: draft, 2026-11-07. Source: GitHub issues #1–#42 (roadmap #1 is authoritative for scope, order and gates).
This plan doesn't change scope. It turns the roadmap into an execution sequence, fixes the technical
decisions the issues leave open, and lists the gaps that need an owner before work reaches them.

---

## 1. Where things stand

- The repository is empty (no commits). Every issue is open.
- **Only one leaf can be picked up by an agent today: #16 `T01`.** Everything else is either human-gated
  (S01, S02, S03, G01), agent-assisted (S04, S05) or blocked by T01.
- The **long pole is human work, not code**. G01 (#17) needs S01, S04 and S05 results and blocks T08 (#26)
  and T10 (#27). Without G01 the code path stops after wave 4 (T05/T07). S01 needs a real recorded,
  consented PF2e session, so it should be scheduled **now**.

## 2. Execution sequence

Lanes run in parallel. "Agent" means one PR per leaf, following AGENTS.md (created in T01).

### Lane A — Foundation (agent, starts now)

| Order | Issue | Size | Notes |
|---|---|---|---|
| A1 | #16 T01 bootstrap | S | Locks the stack (section 3). Add PR template + issue-link check. |
| A2 | #18 T02 schemas + ADR-001..007 | L | The highest-leverage PR: every later stage depends on it. Review closely. |
| A3 | #19 T03 validators/paths/hash/atomic/seal/purge | M | Windows filesystem edge cases are the risk (section 5). |
| A3 | #20 T04 campaign/glossary/consent | M | Parallel with T03. `assertConsent()` is the one choke point every provider call goes through. |
| A4 | #22 T05 multitrack import | M | First end-to-end artifact. Needs audio probing (gap G-1). |
| A4 | #23 T07 SQLite jobs | L | Parallel with T05. Includes migration framework (gap G-4). |

After A4, the import → package → job runner chain works on synthetic data with no AI and no Foundry.

### Lane B — Spikes (human + agent harnesses, starts now)

| Issue | Who | Agent can do now | Human must do |
|---|---|---|---|
| #14 S04 whisper.cpp | assisted | `spikes/s04-whisper/`: benchmark script, whisper.cpp JSON parser + synthetic fixture, WER helper, VAD comparison (whisper.cpp built-in VAD vs ffmpeg `silencedetect`) | Run on RX 9070 XT, hand-check excerpt |
| #15 S05 Claude Code/API | assisted | `spikes/s05-llm/`: `claude -p` harness (stdin, `--output-format json`, `--json-schema`, tools disabled, `--model`), cancel/timeout, mocked-CLI unit tests, prompt-injection probe | Supply credentials, verify terms + usage, run live |
| #11 S01 baseline | human | Labelling guide, label schema, synthetic label fixture | Record session, consent, manual pass, timing, labelling |
| #12 S02 Discord | human | Throwaway harness + offline fragment-finalization check | Live 3+ person call |
| #13 S03 Foundry | human | Throwaway ApplicationV2 module, IndexedDB flush harness | Host install, player-view verification |
| #17 G01 | human | `docs/decisions/G01-go-no-go.md` template with threshold fields | Decision |

Spike harnesses live under `spikes/` and are throwaway. They must not be imported by `src/`.

### Lane C — AI pipeline (agent, after G01 PASS)

```
T08 #26 chunk plan ──► T09 #28 whisper runner ──┐
T10 #27 LLM backend ────────────────────────────┴► T11 #29 classify ─► T12 #30 overrides ─► T13 #32 recap
                                                                     ─► T14 #33 review UI ─► T15 #35 approve/export
T20 #34 eval (needs T11, T13, S01 PASS)
```

T08 and T10 can run in parallel. T10 doesn't depend on T08/T09, so it can start as soon as G01 passes.

### Lane D — Foundry (agent, only if S03 PASS)

T16 #21 module → T17 #24 PF2e normalization → T18 #31 sync/alignment (also needs T11) → T19 #36 import
(also needs T15). If S03 fails, this lane is deferred. The import → recap → Markdown copy path still ships.

### Lane E — Optional Discord (only if S02 PASS)

T06 #25. Never on the critical path.

### Release

T21 #37 (fault injection, synthetic E2E in CI, human Windows + remote Foundry run, operator docs) → G02 #38.
F08 (#39–#42) stays closed off until G02.

**Critical path:** T01 → T02 → T03 → T05/T07 → [G01] → T08 → T09 → T11 → T12 → T13 → T14 → T15 → T21 → G02.
That's 12 sequential agent PRs plus 2 human gates. Code work isn't what limits the schedule; the gates are.

## 3. Technical decisions to fix in T01/T02

These are recommendations. Each should be recorded as an ADR or in T01's README so agents don't re-decide them.

| Area | Recommendation | Why |
|---|---|---|
| Runtime | Node.js 24 LTS, ESM, `"type": "module"` | Current active LTS. Pin with `engines` + `.nvmrc`. |
| Language | TypeScript strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` | Contracts-heavy code: catch shape bugs at compile time. |
| Layout | npm workspaces: `packages/core` (CLI + stages), `packages/contracts` (schemas, types, validators), `packages/foundry-module` (browser build, empty until T16) | T01 says "single package". The Foundry module is a separate browser bundle that has to share contracts. Splitting now avoids a disruptive move in T16. **Decide in T01** (see section 6). |
| Schemas | Write schemas in **TypeBox** (or Zod 4 with `toJSONSchema`), emit JSON Schema 2020-12 files, validate with Ajv | One source of truth gives "type/schema consistency" (T02) by construction. Committed `.schema.json` files can be used by the Foundry module and outside tools. |
| CLI | `commander`; command per module (`recap import`, `recap package seal`, `recap run`, …) | Simple, typed, good `--help`. |
| Tests | Vitest; fixtures under `fixtures/`; Windows + Ubuntu CI matrix | Fast, native ESM/TS. |
| Lint/format | ESLint flat config + typescript-eslint; Prettier | Standard. |
| SQLite | `better-sqlite3` behind a small repository layer; WAL mode; versioned migrations in `packages/core/src/db/migrations` | Mature, synchronous, prebuilt Windows binaries. `node:sqlite` is the fallback if native builds cause trouble. |
| Config | `yaml` package; config validated by the same Ajv schemas | T04. |
| Secrets | `@napi-rs/keyring` (Windows Credential Manager), env var fallback only for CI | `keytar` is archived. S05 confirms. |
| IDs | Run IDs: ULID. Segment/sentence IDs: deterministic within a run (`<run>:<chunk>:<n>`) | Determinism makes re-runs diffable and tests stable. |
| Logging | Structured logger with an explicit redaction allowlist. Transcript text and secrets never reach logs by default | Required by T10, T14, T21. Put it in T01 so every module uses it from the start. |
| Review UI (T14) | Server-rendered HTML + small vanilla TS/htmx client, bundled with esbuild, served by Node `http`/Fastify on 127.0.0.1 | It's a single-user local tool. A SPA framework adds weight for no benefit. |

## 4. Gaps: needed work that no issue owns

Each gap now has its own issue, with native sub-issue and blocked-by links. No existing issue's wave changed:

| Gap | Issue | Wave | Blocked by | Blocks |
|---|---|---|---|---|
| G-1 | #43 `T22` audio toolchain | 2 | #16 | #22, #26 |
| G-2 | #47 `T23` whisper.cpp provisioning | 4 | #14 (PASS), #19, #45 | #28 |
| G-3 | #44 `T24` workspace + Foundry build/release | 2 | #16 | #21 |
| G-4, G-5 | #45 `T25` data root + SQLite migrations | 3 | #18 | #22, #23, #47 |
| G-6 | #48 `T26` versioned prompts | 5 | #23, #20 | #29, #32 |
| G-7 | #46 `T27` recap editorial-state ADR | 3 | #18 | #35 |

| ID | Gap | Proposed owner |
|---|---|---|
| G-1 | **Audio toolchain.** Decoding, resampling to 16 kHz mono, duration/sample-rate probing and silence detection need ffmpeg/ffprobe (or similar). Nothing pins or installs it. | S04 recommends it. `recap doctor` (T01) checks it's installed. T05 probes. T08 does silence detection. Add to `docs/setup-windows.md`. |
| G-2 | **whisper.cpp binary + model provisioning** (download source, hash pinning, location). | S04 records it, T09 automates it with hash checks. |
| G-3 | **Foundry module build/release pipeline** (manifest, zip, GitHub release workflow). | T16, but the workspace layout belongs in T01. |
| G-4 | **SQLite schema migrations** and DB location (`%LOCALAPPDATA%\sargas-recap\`). | T07. |
| G-5 | **Data root layout** (where `sessions/` live, outside the repo by default). | T02 ADR + T01 `.gitignore`. |
| G-6 | **Prompt asset versioning.** Prompts are inputs whose hashes drive invalidation (T07). | Store under `packages/core/prompts/`, hashed like config. T10/T11/T13. |
| G-7 | **Recap editorial state location.** T15's draft/approved state must live in SQLite (per ADR-001), not in `recap.json`. | Make it explicit in T02 ADR-007. |

## 5. Engineering risks and mitigations

1. **Atomic writes on Windows (T03).** `rename` over an existing file can fail with `EPERM`/`EBUSY` while antivirus or the
   indexer holds a handle, and directory fsync isn't supported. Mitigation: temp file in the same directory, `fsync` the file
   handle, rename with bounded retry and backoff, and tests that simulate a crash before the rename.
2. **Path safety on Windows (T03).** Cover drive-relative paths (`C:foo`), UNC and `\\?\` device paths, reserved names
   (`CON`, `NUL`, `COM1`), trailing dots/spaces, alternate data streams (`a.wav:x`), case-insensitive collisions, and
   junction/symlink escapes (resolve with `realpath` and require the result to stay under the root).
3. **Timeline correctness (T02/T08/T09/T18).** Most subtle bugs will be here. Make ADR-003 concrete with integer
   milliseconds plus sample offsets, never floats in stored contracts. Property-test the chunk↔source maps
   (`fast-check`): round-trip identity, monotonicity, no lost short segments.
4. **Override reconciliation (T12).** Never match by timestamp proximity. Matching is keyed on
   (`transcription_run_id`, `segment_id`, `base_text_hash`). Anything else goes to `needs_reconciliation`.
5. **LLM output trust (T10/T11/T13).** Schema-validate everything, wrap transcript text as data, reject unknown/duplicate IDs,
   bound retries. The citation validator (T13) is a security boundary, not a nicety.
6. **Consent bypass.** One `assertConsent(campaign, speakers, provider, stage)` function (T04). Add a lint rule or test
   that fails if a backend is called anywhere except through the stage runner that enforces it.
7. **Foundry injection (T19).** Sanitize journal HTML with an allowlist. Footnotes are rendered, not trusted.
8. **Native modules on Windows CI** (`better-sqlite3`, keyring). Pin versions and cache prebuilds. Fall back to `node:sqlite` if needed.

## 6. Decisions needed from the GM/owner

1. **Workspace layout:** approve npm workspaces (`core`, `contracts`, `foundry-module`) instead of T01's literal
   "single package". If not, keep a single package and accept a restructure at T16.
2. **Audio toolchain:** OK to require ffmpeg as a documented prerequisite (G-1)?
3. **Schedule the S01 session and S03 host time now.** They gate everything past wave 4.
4. Confirm that the agent should build the S04/S05 harnesses now (they are `agent:assisted`).

## 7. Per-PR conventions (to go into AGENTS.md in T01)

- Branch `t01-bootstrap`, `t02-contracts`, …; PR title `[T01] …`; body `Closes #16`, links the prerequisite issues and gate outcomes.
- Checklist: issue acceptance criteria copied in and ticked with evidence. Tests added. Windows docs updated.
  ADR changes listed. No real data or secrets.
- CI must be green on Windows and Ubuntu. Spikes and gates are never closed by an agent.

## 8. Immediate next steps

1. Implement **T01 (#16)** with the decisions in section 3.
2. In parallel: **S05 harness**, then **S04 harness** (agent-assisted parts only).
3. GM: start S01 recording/consent, S03 host scheduling, S02 call logistics.
4. After T01 merges: **T02 (#18)**. Review it carefully before T03/T04 start.
