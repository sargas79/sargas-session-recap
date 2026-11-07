# S02 — Discord/DAVE voice capture reliability and bounded crash recovery

- Issue: #12 (`S02`, SPIKE, phase 0B, wave 1). Parent: #2 `F00`. Blocks: #25 `T06`.
- Type: **human-required**. An agent prepared the harness, the offline checks and this protocol. The live call,
  the bot token and the server setup are human steps. No result below is filled in by an agent.
- Harness: `spikes/s02-discord-capture/` (throwaway, not production; must not be imported by `src/` or `packages/`).

**Outcome: PENDING (human run required)**

---

## 1. Question

Can discord.js + @discordjs/voice (with DAVE via @snazzah/davey) reliably receive and decode per-speaker audio for a
whole session with correct attribution and timing, and what is the maximum data loss on forced termination?

## 2. Timebox

3 days of agent harness work (done: harness, offline checks, this document) + **one live call** with at least 3 human
participants (pending, GM).

## 3. Versions

### 3.1 Installed for harness; must be confirmed in live run

Taken from `spikes/s02-discord-capture/package-lock.json` (exact pins, `--save-exact`). These are what the agent
installed and ran the **offline** tests with. They are not validated against a live Discord call until section 9 is
filled in. If the GM upgrades anything before the run, update this table and the lockfile in the same commit.

| Component | Version | Role |
|---|---|---|
| Node.js | 24.22.1 (npm 11.19.1) | Runtime (Windows 11, x64) |
| discord.js | 14.28.1 | Gateway, slash commands, voice-state events |
| @discordjs/voice | 0.19.2 | Voice connection, receiver, DAVE integration |
| @snazzah/davey | 0.1.12 (prebuilt `@snazzah/davey-win32-x64-msvc` 0.1.12) | DAVE (E2EE) protocol; `DAVE_PROTOCOL_VERSION` = 1 |
| opusscript | 0.0.8 | Opus decode (and beep encode); pure JS/WASM |
| prism-media | 1.3.5 | Pulled by @discordjs/voice; peer range pins opusscript to `^0.0.8` |
| Encryption | Node built-in `aes-256-gcm` | `aead_aes256_gcm_rtpsize` transport mode; no sodium library installed |
| discord-api-types | 0.38.57 | transitive |
| ws | 8.22.1 | transitive (voice websocket) |
| @discordjs/ws / @discordjs/rest | 1.2.3 / 2.6.3 | transitive (gateway / REST) |
| undici | 6.29.1 | transitive (REST) |
| tsx | 4.23.15 | runs the TS harness (`npm start`) |
| typescript / vitest / @types/node | 5.9.3 / 5.1.0 / 24.19.2 | dev only |

`node -e "console.log(require('@discordjs/voice').generateDependencyReport())"` (from the spike directory) on the agent machine reported:
opusscript 0.0.8 found, `@discordjs/opus` not found, native aes-256-gcm yes, sodium libraries not found,
@snazzah/davey 0.1.12, FFmpeg not found (not needed: the harness never transcodes). The GM should paste the same
report from the machine that runs the live call into section 9.

### 3.2 Windows install notes

- **Opus:** used **opusscript** (pure JS/WASM) instead of `@discordjs/opus` (native, needs a node-gyp toolchain or a
  matching prebuild). It installed with no build step. `opusscript@0.1.x` conflicts with prism-media 1.3.5's peer
  range (`^0.0.8`), so 0.0.8 is pinned. Decode CPU cost per speaker is part of the live "decoded quality" case.
- **Encryption:** Node 24 has native `aes-256-gcm`, which @discordjs/voice 0.19 prefers, so no `sodium-native` /
  `libsodium-wrappers` is installed. If Discord negotiates only `aead_xchacha20_poly1305_rtpsize` in the live run, the
  connection will fail; then install `libsodium-wrappers` (pure JS) and record it here.
- **DAVE:** `@snazzah/davey` ships a prebuilt Windows x64 N-API binary; no build step.
- **npm `allowScripts`:** npm 11 skipped esbuild's `postinstall` (it only validates the platform binary). tsx and
  vitest worked without it. If `npm start` ever fails with an esbuild binary error, run `npm install-scripts approve esbuild`.

## 4. What the harness does

`npm start -- s02.config.json` runs startup recovery over `output_root`, then logs in with the token from the
environment and waits for slash commands from the GM (`gm_user_id`) in the configured guild:

| Command | Effect |
|---|---|
| `/spike start` | New session directory `<output_root>/s02-<UTC timestamp>/`; t0 = `process.hrtime.bigint()`; joins `voice_channel_id` with `daveEncryption: true`; posts a public "recording ON, only opted-in labels …" message. |
| `/spike mark [label]` | Logs a `mark` event (session ms, Discord interaction time, local receive time) and, if `mark_beep`, plays a 300 ms 1 kHz beep and logs `mark_beep_playing` when the player starts. |
| `/spike reconnect` | Deliberate full voice reconnect (destroy + rejoin) for the reconnect case. |
| `/spike stop` | Finalizes all fragments, writes `session_stop`, leaves. |

Per speaker: the bot subscribes **only** to allowlisted user IDs (`receiver.subscribe(userId, AfterSilence
silence_close_ms)`), decodes Opus → 48 kHz stereo → mono s16le, and writes `<label>_<seq>.wav.part`. On fragment
close (silence, rotation, discontinuity, stop) the WAV header is patched, the file fsynced and renamed to
`<label>_<seq>.wav`. Everything is recorded in `manifest.jsonl` (schema `s02-manifest/1`):

| Record | Key fields |
|---|---|
| `session_start` | `t0_hr_ns`, `t0_wall_iso`, `sample_rate` 48000, `channels` 1, `offset_algorithm` `s02-arrival-anchor/1`, params |
| `fragment_open` | `fragment_id`, `user_id`, `label`, `epoch`, `fragment_start_offset_ms`, `part_file`, `t_ms` |
| `fragment_close` | `final_file`, `samples`, `duration_ms`, `end_offset_ms`, `end_reason`, `gap_fill_count`, `gap_fill_ms`, `max_early_ms`, `packets`, `decode_errors` |
| `event` | `t_ms` (monotonic session ms), `event`, `epoch`, …: `member_join/leave`, `self_mute/unmute`, `server_mute/unmute`, `self_deaf/undeaf`, `connection_state`, `discontinuity_start/end`, `rejoin_attempt`, `dave_transitioned`, `voice_debug` (DAVE/decrypt lines only), `mark`, `mark_beep_playing`, `non_optin_audio_ignored` |
| `fragment_recovered` | written by recovery: `status` salvaged / empty / finalized_unrecorded |
| `session_stop` | `reason` (`stop_command`, `sigint`, `recovered_after_abnormal_end`, …) |

Write ordering: `fragment_open` is fsynced **before** the `.part` exists; `fragment_close` only **after** the rename.
Audio is written with synchronous `write()` (no user-space buffer) and fsynced every `flush_interval_ms`.

### 4.1 Opt-in and Discord ToS

- Only users in `allowlist` are recorded. Two layers: the bot never subscribes to anyone else (and @discordjs/voice
  0.19.2 drops packets of unsubscribed users before decryption), and `CaptureSession.onPacket` rejects any packet from a
  non-allowlisted ID before decoding. Non-opted-in IDs are never written to disk; their voice-state changes are logged
  as `non_optin: true` with no ID.
- Every participant (opted in or not) must be told before `/spike start`. The bot also announces recording publicly
  in the channel where `/spike start` was run. Participants who do not consent are simply left off the allowlist.
- The token is read only from `S02_DISCORD_TOKEN`, never logged, never in config (config validation rejects a `token`
  key) and never in the manifest. `output_root` must be outside the git repository (validation refuses otherwise);
  `.gitignore` also excludes `s02.config.json`, `*.wav`, `*.part`, manifests and reports.
- No recording, manifest, config with real IDs, or log may be committed. Evidence for section 9 is summarized numbers
  and redacted excerpts only.

## 5. `fragment_start_offset_ms` algorithm (`s02-arrival-anchor/1`)

Also in the header comment of `src/offsets.ts`. @discordjs/voice 0.19.2 gives the receiver only the decrypted Opus
payload; RTP timestamp/sequence are not exposed on `AudioReceiveStream`. The timing signal is the packet's arrival
time on a monotonic clock.

1. **Session clock.** `t0 = process.hrtime.bigint()` at `/spike start`. Monotonic, never adjusted by NTP, never
   reset during the session (including reconnects). All stored times are integer ms since t0. A wall-clock anchor
   `t0_wall_iso` is stored only for humans and cross-process alignment.
2. **Fragment anchor.** A fragment's first sample is placed at the arrival time of its first Opus packet:
   `fragment_start_offset_ms = round((first_packet_arrival_ns − t0_ns) / 1e6) − latency_compensation_ms`, clamped ≥ 0.
   `latency_compensation_ms` defaults to 0; it can cancel a constant capture→arrival delay measured with the
   reference marks, but cannot fix jitter.
3. **Silence gaps inside a fragment.** Samples inside a fragment are contiguous at 48 kHz. Discord stops sending during
   silence, so for each packet `drift_ms = arrival − (first_arrival + samples_written / 48 kHz)`. If
   `drift_ms > gap_fill_threshold_ms` (default 100), `floor(drift_ms / 20)` frames of zeros are written first (a gap
   fill), re-aligning sample time with arrival time. Negative drift (jitter bursts) is never "fixed" by dropping
   audio; the worst case is recorded as `max_early_ms`.
4. **Long silences end the fragment.** After `silence_close_ms` (default 1000) with no audio the receive stream ends
   and the fragment is finalized. The next utterance opens a new fragment anchored by rule 2, so long silence costs no
   disk and drift does not accumulate across fragments.
5. **Rotation.** A fragment reaching `max_fragment_ms` (default 30000) is closed (`rotate`); the next packet opens a new
   fragment anchored by rule 2. This bounds how much a single `.part` holds.
6. **Reconnect discontinuity.** When the voice connection leaves Ready, all open fragments close (`discontinuity`),
   the epoch increments and `discontinuity_start` / `discontinuity_end` (with `gap_ms`) are logged. Audio during the
   gap is lost (Discord does not replay it). Later fragments keep the same t0, so offsets stay on one session timeline;
   their higher `epoch` tells consumers that a discontinuity lies in between. No gap fill crosses a discontinuity.
7. **Process restart** (crash) means a new session and a new t0. Aligning across sessions can only use wall-clock
   anchors and is lower precision; it must be flagged as such downstream.

Expected error inside a fragment: bounded by `gap_fill_threshold_ms` + network jitter; across fragments: jitter of the
first packet only. Whether that meets ≤ ~100 ms is what case 8 measures.

## 6. Crash recovery and loss-bound method

On every startup (and via `npm run recover -- <output_root>`), `recoverAll` scans each session directory:

- **Truncated manifest tail** (kill mid-append): tail copied to `manifest.jsonl.corrupt-tail`; manifest truncated to the
  last complete line.
- **`*.wav.part`** (fragment open at the kill): header patched from file size, trailing partial sample cut, renamed to
  `*.recovered.wav`; zero-sample parts become `*.wav.empty`.
- **Final file without `fragment_close`** (kill between rename and manifest append): reported `finalized_unrecorded`.
- **`fragment_open` with no file**: reported `missing`.
- A missing `session_stop` → `abnormal_end: true`; recovery appends `session_stop` (`recovered_after_abnormal_end`).
  Each action is recorded as `fragment_recovered`, so a second run is a no-op. A `recovery-<stamp>.json` report is
  written next to the manifest.

**Loss bound measurement (live case 10).** `npm run kill-test -- s02.config.json` starts the harness as a child,
waits for Enter, then hard-kills it (`SIGKILL` → TerminateProcess on Windows) and records the kill instant on the
same system-wide monotonic clock (`process.hrtime.bigint()` is QueryPerformanceCounter on Windows), writes
`kill-record-*.json`, and runs recovery with that kill time. For each interrupted fragment:

`loss_ms_if_speaking_at_kill = kill_offset_ms − (fragment_start_offset_ms + salvaged_duration_ms)`

An opted-in reader talks continuously through the kill, so for that speaker the number is real lost audio. Repeat
at least 5 times; report the max and median. Theoretical expectation: a **process** kill loses roughly the in-flight
packets (OS page cache keeps written data); an **OS crash / power cut** can additionally lose up to
`flush_interval_ms` of unsynced data (not part of this spike unless the GM chooses to test it).

Offline synthetic check (agent machine, not live evidence): `test/kill-process.test.ts` hard-kills a real child process
writing synthetic 20 ms frames; one run printed `loss_ms_if_speaking_at_kill = 37`. The test only asserts < 500 ms.

## 7. Reference timing method (case 8)

Primary: **bot beep, acoustic pickup.** At least two opted-in participants use **speakers, not headphones**, with
Discord noise suppression / echo cancellation **off** (Krisp removes beeps). The GM runs `/spike mark ref-N` at least
10 times spread over the session (start, after each case, before stop). Then
`npm run analyze -- <session_dir>` finds the 1 kHz onset in every speaker's fragments and prints, per mark:
`onset_ms` per speaker (on the session timeline via rule 2/3), `delta_ms` to `mark_beep_playing`, and `spread_ms`
across speakers.

- **Cross-speaker timing error** = `spread_ms` minus the known acoustic/route difference (assume it is constant and
  subtract the session median of the per-pair difference). Target ≤ ~100 ms at every mark.
- **Drift** = change of `delta_ms` per speaker from first to last mark. Target ≤ ~100 ms over the session.

Fallback (if acoustic pickup fails): each participant records their own mic locally (Audacity/OBS) and claps 3× at
each `/spike mark`; compare clap-to-clap intervals between the local recording and the captured fragments.

## 8. GM setup steps (human)

1. **Throwaway bot application.** Discord Developer Portal → New Application `s02-spike-throwaway` → Bot. Do not make
   it public. Privileged intents: none needed (Guilds + GuildVoiceStates only; no message content, no members).
   Copy the application ID.
2. **Token.** Reset the bot token and store it in the Windows Credential Manager or a password manager. For the run,
   put it in the process environment only, e.g. PowerShell 7 `$env:S02_DISCORD_TOKEN = Read-Host -MaskInput` (not a
   committed file, not shell history). Revoke/reset the token after the spike.
3. **Test server.** A dedicated throwaway server with one voice channel and one text channel. Invite with OAuth2 URL
   scopes `bot applications.commands`; permissions: View Channel, Connect, Speak, Send Messages, Use Application
   Commands. Enable Developer Mode in Discord to copy IDs.
4. **Consent.** Each participant agrees in writing (in the text channel is fine) to being recorded for this spike, that
   audio stays on the GM's machine, and that it is deleted after the spike. Record only those IDs in the allowlist.
5. **Config.** `cd spikes/s02-discord-capture; copy s02.config.example.json s02.config.json`; fill in IDs, labels
   (`p1`, `p2`, … no real names), and `output_root` **outside the repo** (e.g.
   `%LOCALAPPDATA%\sargas-recap-spikes\s02`).
6. **Install.** `npm ci` (Node 24). `npm test` must be green. Paste the `generateDependencyReport()` output into §9.
7. **Register commands.** `npm run register-commands -- s02.config.json` (guild-scoped, appears immediately).
8. **Run.** `npm start -- s02.config.json` (or `npm run kill-test -- s02.config.json` for case 10). Clients must be on
   a DAVE-capable Discord version; the `voice_debug` / `dave_transitioned` events confirm DAVE was negotiated.
9. **After.** Fill §9 from the manifest/recovery reports, keep raw audio out of git, delete recordings when done.

## 9. Test protocol and results (live, ≥ 3 participants)

Fill every cell from logs/measurements; an assertion without evidence is a FAIL for that case. Evidence = manifest
excerpts (IDs redacted), `recovery-*.json`, `analyze` output, listening notes. Results are blank until the human run.

Run metadata (GM): date: ____ · participants (labels): ____ · client platforms/versions: ____ · bot host: ____ ·
dependency report pasted: ____ · DAVE negotiated (evidence): ____ · session duration: ____

| # | Case | Procedure | Pass criterion | Evidence | Measured | Result |
|---|---|---|---|---|---|---|
| 1 | Simultaneous speech | 3 people count aloud over each other for 30 s, twice | Each speaker's own voice in own track; no track missing; no `decode_errors` spike | | | |
| 2 | Long silence | Whole channel silent ≥ 10 min, then each speaker says a marked phrase after a `/spike mark` | New fragments open after silence; offsets of phrases match marks within target; no crash/disconnect | | | |
| 3 | Mute/unmute | Each speaker self-mutes 30 s mid-sentence, unmutes and continues; GM server-mutes one speaker | `self_mute/unmute`, `server_mute/unmute` events at right times; fragment closes/opens around it; no lost speech after unmute | | | |
| 4 | Mid-session join/leave | One opted-in participant leaves and rejoins; one **non-opted-in** person joins and talks | Rejoiner is recorded again with correct label; non-opted-in person produces no file, no ID on disk (`grep` for their ID = 0 hits) | | | |
| 5 | Bot reconnect | (a) `/spike reconnect`; (b) GM disconnects the bot via right-click → Disconnect; (c) optional: bot host network off 10 s | `discontinuity_start/end` with `gap_ms`; epoch increments; recording resumes without restart; offsets after reconnect still match marks | | | |
| 6 | Decoded quality | Listen to ≥ 3 minutes per speaker incl. crosstalk | Intelligible, no robotic artifacts/dropouts beyond network; note `decode_errors`, `gap_fill_*`, CPU of bot process | | | |
| 7 | Speaker attribution | Each speaker says their label at 3 different times | 100 % of utterances in the right label's files | | | |
| 8 | Timing vs reference | ≥ 10 `/spike mark` beeps across the session (§7) | Cross-speaker spread and drift ≤ ~100 ms at every mark | | | |
| 9 | Normal stop | `/spike stop` while two people are talking | Zero `.part` left; every `fragment_open` has a `fragment_close`; `session_stop` present; startup recovery reports nothing | | | |
| 10 | Forced kill | `npm run kill-test` with a reader talking continuously; ≥ 5 repetitions | `.part` detected on restart; salvaged files play; truncated manifest tail (if any) repaired; `loss_ms_if_speaking_at_kill` max/median stated | | | |

Loss bound on forced kill (numeric, from case 10): max ____ ms · median ____ ms · runs ____ · incomplete fragments
detected ____ / ____.

## 10. Offline checks (agent, no network)

`cd spikes/s02-discord-capture; npm install; npm test` — Vitest, no network, no token. Covers:

- `fragment-writer.test.ts` — `.part` while open, header + rename on finalize, refuse double finalize/overwrite, rename
  retry on EBUSY/EPERM and bounded give-up, manifest open-before-part / close-after-rename ordering, rotation,
  stop finalizes all, decode-error counting.
- `offsets.test.ts` — rule 2 anchor/compensation/clamp, rule 3 gap fill and `max_early_ms`, sample alignment after an
  intra-fragment pause, rule 4 re-anchoring after a 10-minute silence, independent anchors for simultaneous speakers,
  rule 6 reconnect discontinuity (epoch, same t0, gap logged, no gap fill), monotonic event/mark times.
- `recovery.test.ts` — simulated forced kill (open `.part` files + truncated manifest line + odd trailing byte):
  tail detection/preservation/truncation, salvage with valid header, loss computation, idempotency, empty part,
  finalized-but-unrecorded, missing file, multi-session scan.
- `kill-process.test.ts` — real child process hard-killed while writing; recovery salvages and bounds loss (synthetic).
- `allowlist.test.ts` — non-allowlisted packets never decoded/written/named; config requires allowlist, rejects
  duplicates, a token in the file, and an output root inside the repo; token only from env.
- `opus-analyze.test.ts` — opusscript decode/downmix, beep encode→decode round trip, onset detection and per-speaker
  spread on the session timeline.

Passing these says the bookkeeping is right. It says **nothing** about Discord/DAVE reliability, which only the live
run can show.

## 11. Known limitations of the harness

- Timing is arrival-based (no RTP timestamps exposed), so network jitter appears directly in anchors.
- Packet loss inside a fragment is only filled when it exceeds `gap_fill_threshold_ms`; shorter losses shorten the
  fragment slightly.
- The bot's own beep is not received by the bot; the reference relies on acoustic pickup (§7).
- DAVE's MLS group necessarily includes everyone in the channel; opt-in is enforced at subscription/decode/storage.
- One process, synchronous file I/O, no backpressure handling: fine for a spike, not for T06.

## 12. ADR stub — Discord capture

- **Status:** PENDING (decided by the GM after §9 is complete).
- **Decision:** Discord ENABLED or DEFERRED: **PENDING**
- **Rule (issue #12):** PASS only if every case in §9 works with the pinned versions in §3.1. Otherwise FAIL → the
  multitrack import adapter (#22 `T05`) is primary and #25 `T06` stays deferred.
- **If ENABLED, T06 inherits:** offset algorithm `s02-arrival-anchor/1` (or a revised version recorded here), the
  write-ordering contract, `.part` recovery, the measured loss bound, and the exact pins from §3.1.
- **Consequences / follow-ups:** ____

**Outcome: PENDING (human run required)**
