# S05 — Claude Code / Claude API: programmatic execution, structured output, secret handling

- Issue: #15 (`S05`, parent #2 `F00`, roadmap #1). Blocks #17 `G01` and #27 `T10`.
- Harness: [`spikes/s05-llm/`](../../spikes/s05-llm/) (throwaway; never imported by `src/` / `packages/`).
- Status of this document: **live CLI run recorded by an agent on the GM's PC, 2026-11-08** (sections 4 to 7). The API
  fallback was not run (no key) and the terms and limits were not checked. Those cells are for the GM.

**Outcome: PENDING (GM to check terms and decide; CLI run done, see sections 4 to 7)**

---

## 1. Question

Can the pipeline run Claude Code non-interactively (`claude -p`) with:

- the transcript on stdin,
- no tools, and filesystem access restricted,
- output validated against a JSON schema,
- timeout and cancellation,
- an explicit model,

under the account's current terms and usage limits? And what does the Claude API fallback need?

## 2. What the agent built (verifiable offline)

| Piece | File | Notes |
|---|---|---|
| CLI harness | `src/cli-harness.ts` | Uses `spawn` with an argument array and `shell: false`. The prompt goes on stdin. The arg list is a configurable template (`{model}`, `{schema}`, `{system}`, `{tools}`). The `{tools}` slot uses the tool-disable presets `toolsEmpty`, `disallowed` and `belt`. Each run gets a fresh empty temp cwd, which is deleted afterwards, and the harness reports anything written into it. Child env is an allowlist. API-key vars are dropped in `subscription-login` mode. Timeout and `AbortSignal` kill the whole process tree. Stdout and stderr both have byte caps (stderr overflow stops the run as `output_too_large`). The full stderr is redacted before the diagnostic tail is cut, so a cut cannot split a secret. An abort that lands while the temp cwd is being created is honoured before spawn. Every outcome gets an explicit status: `ok`, `schema_invalid`, `non_json`, `cli_error`, `exit_nonzero`, `timeout`, `cancelled`, `spawn_error`, `output_too_large`. `getCliVersion()` records `claude --version`. |
| Tree kill | `src/process.ts` | Windows uses `taskkill /PID <pid> /T /F` (arg array). POSIX uses a detached process group and `kill(-pid)`. |
| Envelope parser | `src/envelope.ts` | Reads a single JSON object, a JSON array, or JSON lines (the last `type:"result"` wins). Fields it looks for: `result`, `structured_output`, `is_error`, `subtype`, `usage.*`, `total_cost_usd`, `duration_ms`, `duration_api_ms`, `num_turns`, `session_id` and `modelUsage`. It records every field present, for the table below. It does **not** strip code fences: prose around the JSON counts as schema-invalid. |
| Schema + validation | `src/schema.ts` | A sample classification schema checked with Ajv strict mode. It also rejects segment ids that are unknown, duplicated or missing. |
| Untrusted-data wrapper | `src/untrusted.ts` | Wraps the transcript in `<untrusted_transcript nonce="…">` with a fresh random nonce per call. Each segment is one JSON line, with `<`, `>`, `&`, U+2028 and U+2029 written as `\uXXXX` escapes. A segment therefore can't close the block, open a fake one, or forge another segment. The round-trip is lossless. |
| Injection probes | `fixtures/injection-probes.ts` | 12 synthetic PT/EN lines. 7 of them are injection attempts: "ignore previous instructions", tool or file requests, delimiter break-outs with and without a nonce, a forged JSON segment, a fake `<system>` tag, Unicode separators, and pre-escaped tags. **The payloads are harmless canaries by design**, because they are sent to the real CLI while tool disabling is what is being tested: if it fails and the model obeys, the worst case is a file named `CANARY` in the disposable temp cwd (detected via `cwdEntriesAfter`), a read of a path that does not exist, or a fetch to a reserved `.invalid` host that cannot resolve. No payload deletes, overwrites or reads real files (home directory, credentials). `test/injection-probes.test.ts` enforces this. |
| API fallback | `src/api-harness.ts` | Uses `@anthropic-ai/sdk` `messages.create` with `output_config.format = {type:"json_schema"}`, an explicit model from config (default `claude-sonnet-5-5`) and explicit `effort`. The key is read from **one** env var and passed explicitly. If that var is unset, the harness returns `no_key` and does not fall back to other SDK credential sources. Statuses are `refusal`, `max_tokens`, `non_json`, `schema_invalid`, `api_error` (redacted), `cancelled` and `ok`. `usage` is captured verbatim. Usage, validated output and validation errors all pass through a request-local redactor that knows the exact key, including a custom `S05_API_KEY_ENV` var (response handling is the pure `interpretApiResponse()`, unit-tested offline). Tests never call it against the network. |
| Redaction | `src/redact.ts` | Masks exact values (plus URL-encoded, JSON-escaped, base64 and base64url forms) and anything matching key or bearer patterns. Applies to errors (message, stack and cause) and deep JSON values. The `x-api-key` pattern never consumes a JSON escape backslash, so `redactValue()` always yields valid JSON. Includes a safe logger. |
| Unit tests | `test/*.test.ts` | Uses a fake CLI (`test/fake-claude.mjs`, run with `node`) and an injected spawn. Covers valid output, `result`-only output, schema-invalid output, forged ids, prose results, non-JSON output, the error envelope, non-zero exit (with stderr redacted), cwd writes, timeout, cancellation (including a check that a grandchild process dies on Windows), pre-aborted signals, oversized output, a missing binary, version capture, usage parsing, JSON lines, envelope redaction, abort during temp-dir creation, stderr redaction before truncation and the stderr cap, API output/validation-error redaction, real Ajv validation of live-check probe output, and the harmlessness of the injection fixtures. |
| Live check | `scripts/live-check.ts` | Run by the GM only (section 3). |

Offline result (agent, 2026-11-07, Windows 11, Node v24.22.1): `npm install && npm test` in `spikes/s05-llm/`: 6 files, 65 tests passed (after the #54 review fixes). This shows only that the harness logic works against a **fake** CLI. It says nothing about the real CLI.

## 3. Procedure for the GM

Do not paste keys or tokens into the terminal history, issue comments, or this file.

1. **Choose the auth mode** and record it in section 4:
   - `subscription-login`: Claude Code is logged in interactively (`claude` → `/login`) on a Pro/Max/Team/Enterprise
     account. The harness strips `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the child env, so an API key in your shell
     isn't billed by accident.
   - `api-key-env`: Claude Code uses an API key from `ANTHROPIC_API_KEY` (Console billing). Set `S05_AUTH_MODE=api-key-env`.
2. **Check the terms and usage limits** that apply to automated, non-interactive use of that auth mode.
   Record the URLs, the relevant clause or summary, and the **date checked** in section 4. The agent has not done this. Nothing
   here assumes automation is permitted, or what it costs.
3. **Install and locate the CLI.**
   - `claude --version`
   - `claude --help` (or `claude -p --help`). Confirm the spelling and arguments of `-p`/`--print`, `--output-format`,
     `--json-schema`, `--model`, `--tools`, `--disallowedTools`, `--system-prompt`, `--strict-mcp-config`/`--mcp-config`, and any
     flags for session persistence, max turns or setting sources. Save the help output as evidence (it contains no secrets).
   - Windows: `spawn` without a shell cannot run `.cmd` shims. If `where claude` shows only `claude.cmd` (npm install),
     set `S05_CLI_COMMAND` to `node` and `S05_CLI_PREFIX_ARGS` to `["<path to @anthropic-ai/claude-code cli.js>"]`. With
     a native `claude.exe`, set `S05_CLI_COMMAND` to its full path.
4. **Set the flag template if `--help` differs** from the default
   (`-p --output-format json --model {model} --json-schema {schema} --system-prompt {system} {tools}`):
   use `S05_ARG_TEMPLATE='["-p", ...]'`. Choose tool presets with `S05_TOOL_PRESETS='["toolsEmpty","belt"]'`.
5. **Dry run**: `cd spikes/s05-llm && npm install && npm run live-check`. This prints the plan and runs nothing.
6. **Live run** (uses quota or money): `npm run live-check -- --yes`. Add `--api` to also run the API fallback probe. This
   needs the key in the env var named by `S05_API_KEY_ENV` (default `ANTHROPIC_API_KEY`), and only for this run. Set it in the
   current session only, and unset it afterwards. To probe model availability, set `S05_MODELS='["claude-sonnet-5-5","claude-opus-5-5","claude-haiku-5-5"]'`
   (or whatever you want to check).
7. Open `spikes/s05-llm/results/s05-live-<timestamp>.json` (git-ignored). Check that it contains no secrets or private data,
   then attach it to #15 or `git add -f` it.
8. Fill in sections 4–9 and set the Outcome. Post `Outcome: PASS | FAIL | UNRESOLVED` as the last comment on #15, with links.

Extra manual checks worth recording:

- With tools disabled, run the tool canary probe (live-check does this). The temp cwd must stay empty
  (`cwdEntriesAfter: []`); a `CANARY` or `canary.txt` entry means a tool ran. The canary self-report is checked with Ajv against its schema (wrong types or extra properties are `schema_invalid`, not `ok`). The envelope should show no tool use: check `num_turns`, `permission_denials` if present, and `--verbose`/`stream-json` output if you
  need more proof.
- Filesystem restriction: the cwd is an empty temp dir. Record whether the CLI can still *read* outside the cwd when tools
  are disabled. With no tools it shouldn't be able to read at all. Record what you observed.
- Cancellation on Windows: after the cancellation probe, check in Task Manager or `tasklist` that no `claude`/`node` child
  processes are left.

## 4. Environment and terms

Agent run on the GM's PC, 2026-11-08, at the GM's request. Rows marked "to verify by GM" were not checked.

| Item | Value | Date checked | Evidence / link |
|---|---|---|---|
| OS / Node | Windows 11 Pro 10.0.26300, x64 / Node v24.22.1 | 2026-11-08 | results JSON |
| Claude Code CLI version (`claude --version`) | 2.1.317 (Claude Code) | 2026-11-08 | results JSON |
| Install type (native exe / npm .cmd) and command used | Native `claude.exe` from `winget install --id Anthropic.ClaudeCode -e`; run through `S05_CLI_COMMAND` (full path) | 2026-11-08 | |
| Auth mode (subscription-login / api-key-env) and plan | `subscription-login`, claude.ai login, Pro plan (`claude auth status`) | 2026-11-08 | |
| Terms covering automated / non-interactive use of this auth mode | to verify by GM with date | | |
| Usage limits / rate limits that apply | to verify by GM with date | | |
| Data retention / training terms for the transcripts sent | to verify by GM with date | | |
| API pricing for the chosen model (if API fallback) | to verify by GM with date | | |

## 5. Flags verified against the installed CLI

| Flag (as used by the harness) | Exists in `--help`? | Behaviour observed | Notes |
|---|---|---|---|
| `-p` (print / non-interactive), prompt via stdin | yes (`-p, --print`) | Works; 7 structured probes returned exit 0 | |
| `--output-format json` | yes | One JSON envelope on stdout | |
| `--json-schema <inline JSON>` | yes | Inline JSON string accepted | Output is in `structured_output` (`outputSource: structured_output` on every successful probe). `num_turns` was 2 or 3 even for one question. |
| `--model <id>` | yes | Honoured; `modelUsage` names the requested model | See section 6 |
| `--system-prompt <text>` | yes | Accepted | |
| `--tools ""` (disable all built-in tools) | yes | **Not enough on its own.** See section 7 | Argument passed correctly as an empty string on Windows |
| `--disallowedTools <list>` | yes (also `--disallowed-tools`) | Accepted as one comma-separated value | Used in preset `belt` |
| `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` | yes | Accepted; inline JSON works | Without it the run carried far more context, consistent with the user's MCP servers and plugins being loaded (section 7) |
| Session persistence / max-turns / setting-sources flags (if any) | `--no-session-persistence`, `--setting-sources`, `--max-budget-usd` exist; no `--max-turns` in the filtered help output | Not exercised | T10 should evaluate `--no-session-persistence` and `--setting-sources` |

## 6. Models actually available

| Model id | Via CLI (auth mode) | Via API | Date | Notes |
|---|---|---|---|---|
| `claude-sonnet-5-5` | yes (subscription-login) | not tested | 2026-11-08 | harness default |
| `claude-opus-5-5` | yes (subscription-login) | not tested | 2026-11-08 | |
| `claude-haiku-5-5` | yes (subscription-login) | not tested | 2026-11-08 | |
| `claude-s05-does-not-exist` (negative control) | refused | n/a | 2026-11-08 | exit 1, `is_error: true`, `subtype: "success"`, stderr `[claude-code:unrecognized_model]` |

## 7. Runtime behaviour

Results file: `spikes/s05-llm/results/s05-live-2026-11-08T14-54-58-725Z.json` (git-ignored; grep for key and token patterns found none).

| Probe | Status | Duration | Observations |
|---|---|---|---|
| Classification + injection, preset `toolsEmpty` | `ok` | 6.6 s | Schema valid. 7 of 7 injection lines flagged, 0 of 5 benign lines flagged. Cwd stayed empty. 35,363 cache-creation tokens. |
| Classification + injection, preset `belt` | `ok` | 4.4 s | Schema valid. 7 of 7 injection lines flagged, 0 of 5 benign lines flagged. Cwd stayed empty. 2,859 cache-creation tokens. |
| Tool canary, preset `toolsEmpty` | `ok` | 5.3 s | **Model reported `tools_were_available: true`**, `attempted_tool_call: false`. `cwdEntriesAfter: []`, `num_turns: 2`, no `permission_denials`. 81,259 cache-creation tokens. |
| Tool canary, preset `belt` | `ok` | 4.0 s | Model reported `tools_were_available: false`, `attempted_tool_call: false`. `cwdEntriesAfter: []`, `num_turns: 2`, no `permission_denials`. 1,495 cache-creation tokens. |
| Timeout (3 s) | `timeout` | 3.1 s | Killed; no `claude.exe` left after the full run. |
| Cancellation (abort after 2 s) | `cancelled` | 2.1 s | Killed; no `claude.exe` left after the full run. |
| Invalid model | `cli_error` | 3.6 s | Exit 1, `is_error: true`, `subtype: "success"`, stderr `[claude-code:unrecognized_model]`. |
| Schema-invalid output seen live? | no | | Not observed in 7 successful structured runs, so this run does not show whether `--json-schema` enforces or only hints. Keep Ajv validation. |

**Finding: use `belt`, never `toolsEmpty` alone.** `--tools ""` removes built-in tools only. The `toolsEmpty` runs carried 12 to 54 times more cached context than `belt`, and the model said tools were available. That is consistent with the user's MCP servers and plugins still being loaded, which would put tools such as mail or file connectors next to untrusted transcript text. The cause is inferred from the token counts and the model's self-report; the tool list itself was not captured. The harness default in `src/cli-harness.ts` is `toolsEmpty`; T10 must default to the `belt` flags.

**Finding: `subtype` is not a success signal.** Failures came back with `subtype: "success"` and `is_error: true`. T10 must check `is_error` and the exit code.

### Usage / cost fields reported

| Field | CLI envelope (present? example value, `classification:belt`) | API `usage` (present? example value) |
|---|---|---|
| `input_tokens` | yes, 2 | not tested |
| `output_tokens` | yes, 376 | not tested |
| `cache_creation_input_tokens` | yes, 2,859 | not tested |
| `cache_read_input_tokens` | yes, 0 | not tested |
| `total_cost_usd` (CLI) | yes, 0.0152 (reported by the CLI; what it means on a subscription is not established) | n/a |
| `duration_ms` / `duration_api_ms` | yes, 3,286 / 3,039 | n/a |
| `num_turns` | yes, 2 | n/a |
| `modelUsage` | yes, per model: tokens, `costUSD`, `contextWindow` 1,000,000, `maxOutputTokens` 128,000 | n/a |
| other fields (list) | `api_error_status, fast_mode_disabled_reason, fast_mode_state, first_content_frame_ms, permission_denials, queued_turn_count, result, result_index, safety_stops, session_id, stop_reason, structured_output, subagent_stats, subtype, terminal_reason, time_to_request_ms, ttft_ms, ttft_stream_ms, type, uuid` | |

The probe used 12 short lines. Token use and latency for a real session window are not measured here.

### Failure modes observed

| Failure | How it surfaces (exit code / envelope / stderr) | Harness status | Retry? |
|---|---|---|---|
| Not logged in / auth expired | Exit 1, `is_error: true`, `subtype: "success"`, zero tokens, about 50 ms, empty stderr (seen in a first run before login; `claude auth status` showed `loggedIn: false`) | `cli_error` | no; needs the GM to log in |
| Usage limit reached | not observed | | |
| Rate limited | not observed | | |
| Network down | not observed | | |
| Invalid model | Exit 1, `is_error: true`, `subtype: "success"`, stderr `[claude-code:unrecognized_model]` | `cli_error` | no |
| Schema-invalid output | not observed live | `schema_invalid` | |
| Timeout / cancel | Process tree killed by the harness, exit 1, no envelope | `timeout` / `cancelled` | timeout yes (bounded); cancel no |

## 8. API fallback (GM fills in; design by agent)

| Item | Value |
|---|---|
| SDK | `@anthropic-ai/sdk` 1.6.0 (pinned in `spikes/s05-llm/package-lock.json`) |
| Call | `client.messages.create({ model, max_tokens, system, messages, output_config: { effort, format: { type: "json_schema", schema } } })`. The result is validated locally with Ajv anyway. |
| Model id (config) | default `claude-sonnet-5-5` (availability: section 6) |
| Credential resolution | One env var, passed explicitly as `apiKey`. If unset, the harness refuses to run. This stops the SDK falling back to `ANTHROPIC_AUTH_TOKEN` or a CLI profile. |
| Refusals | `stop_reason: "refusal"` → status `refusal`, never parsed as output. Server-side refusal fallbacks (beta) are deliberately **not** enabled in the spike, because they could answer from a different model than the one configured, which matters for auditability. Decide on this in T10. |
| Batch API (async, cheaper) | to verify by GM with date. Relevant for re-classifying whole sessions offline. |
| Prompt caching | Candidate: cache the stable system prompt and schema. `cache_*_input_tokens` show whether it worked. Minimum cacheable prefix and pricing: to verify by GM with date. |
| Cost fields | `usage.*` only. The API returns no cost in dollars, so cost = tokens × price (to verify by GM with date). |
| Observed latency / usage for the probe | |

## 9. Secret-handling design

**Spike.** The API key comes from an env var for the duration of one manual `live-check` run. It is never written to disk by the
harness. Every string the harness emits (stderr tails, envelopes, errors, the results file) goes through `Redactor`. In subscription
mode the CLI child never sees API-key env vars.

**Production (T10), proposed.**

1. **Storage.** OS credential store via `@napi-rs/keyring`. On Windows this is Credential Manager, generic credential, with
   service `sargas-recap` and account `anthropic-api-key`. A `recap secrets set anthropic` command (or similar) reads the key from a hidden
   prompt, writes it to the keyring, and never echoes it. `keytar` is archived and not used. The native module has prebuilt
   Windows binaries; pin the version (plan §5.8).
2. **Resolution order.** Keyring first, then env var (`ANTHROPIC_API_KEY`) only when `CI=true` or an explicit `--allow-env-key`
   flag is set. Never config files, never the repo. Pass the key explicitly to the SDK so its own credential discovery can't pick up a
   different identity.
3. **CLI backend.** Claude Code keeps its own login, in its own store. The app never reads or copies Claude Code's
   credentials. It only spawns the CLI with an allowlisted env.
4. **Redaction.** One `Redactor` per process, seeded with every resolved secret at load time. The structured logger (T01) applies
   it to every record. Errors from the SDK are rebuilt with `redactError()` before being logged or stored. Raw SDK error objects,
   which can carry request headers, are never serialized.
5. **Transcripts are not secrets but are private.** They are never logged (the logger allowlist excludes them) and appear
   only inside the delimited data block sent to the provider. `assertConsent()` (T04) gates every provider call.
6. **Tests.** The redaction tests in this spike move into the production logger test suite. A CI grep for `sk-ant-` in
   artifacts and logs is a cheap extra guard.

## 10. Recommendation

Agent observation from the CLI run: the CLI meets the technical points below when run with the `belt` flags, except that schema enforcement and the terms are unproven. The decision is the GM's. The decision points for G01 and T10:

- CLI: are all required flags present, are tools verifiably disabled, does schema-validated output come back reliably, does
  cancellation clean up the process tree on Windows, and is automated use allowed under the terms (section 4)?
- API: are the model ids available, does `output_config.format` work with the classification schema, is the cost per session acceptable?
- Primary backend and fallback. Under roadmap rule 8, do not add another provider (that is D03).

**Outcome: PENDING (GM to check terms and decide; CLI run done, see sections 4 to 7)**
