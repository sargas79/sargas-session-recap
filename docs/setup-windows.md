# Windows setup

The Session Recap Bot runs locally on Windows 10/11. This guide gets a development checkout working.
Later tasks add prerequisites (whisper.cpp in T23); they will be documented here.

## 1. Install Node.js 24 LTS

Pick one option.

**winget (simplest):**

```powershell
winget install --id OpenJS.NodeJS.LTS -e
```

Open a new terminal afterwards and check that `node --version` prints `v24.x`. If the LTS package has
moved past 24, install 24 explicitly with nvm-windows instead.

**nvm-windows (if you need several Node versions):**

```powershell
winget install --id CoreyButler.NVMforWindows -e
# open a new terminal, then:
nvm install 24
nvm use 24
```

The repo pins the major version in `.nvmrc` (`24`) and in `engines` in `package.json`.

## 2. Install Git

```powershell
winget install --id Git.Git -e
```

The repo uses LF line endings (`.gitattributes`: `* text=auto eol=lf`), so `core.autocrlf` doesn't matter.

## 3. Install FFmpeg (ffmpeg + ffprobe)

The audio stages probe, decode (16 kHz mono PCM) and detect silence with FFmpeg. It is an external
prerequisite and is never committed to the repository. **Minimum version: 6.0; 7.0 or newer is
recommended** (before 7.0, ffmpeg prints silence timestamps with only six significant digits, so
boundaries on recordings longer than about 16 minutes are only 10 ms precise).

**winget (simplest):**

```powershell
winget install --id Gyan.FFmpeg -e
```

Open a **new** terminal afterwards so the updated `PATH` is picked up, then check:

```powershell
ffmpeg -version
ffprobe -version
```

To upgrade later: `winget upgrade --id Gyan.FFmpeg -e`.

**Manual install (no winget, or a specific build):**

1. Download a release build (`ffmpeg-release-essentials.zip`) from <https://www.gyan.dev/ffmpeg/builds/>
   or <https://github.com/BtbN/FFmpeg-Builds/releases>.
2. Extract it, for example to `C:\Tools\ffmpeg`, so that `C:\Tools\ffmpeg\bin\ffmpeg.exe` exists.
3. Either add `C:\Tools\ffmpeg\bin` to your user `PATH`, or point recap at the executables directly:

   ```powershell
   [Environment]::SetEnvironmentVariable('RECAP_FFMPEG', 'C:\Tools\ffmpeg\bin\ffmpeg.exe', 'User')
   [Environment]::SetEnvironmentVariable('RECAP_FFPROBE', 'C:\Tools\ffmpeg\bin\ffprobe.exe', 'User')
   ```

   Open a new terminal afterwards.

**Lookup order.** recap uses the path from its config file first (T04), then `RECAP_FFMPEG` /
`RECAP_FFPROBE`, then `PATH`. An explicit path that is wrong is reported as an error; recap does not
silently fall back to another ffmpeg on `PATH`. On Windows only `ffmpeg.exe` / `ffprobe.exe` are
accepted, not `.cmd`/`.bat` wrappers, and the current directory is never searched.

Paths with spaces and non-ASCII characters (for example `D:\Sessões\sessão 12\áudio.wav`) work: recap
passes arguments to ffmpeg directly, never through a shell.

**Chunk planning** (`recap run chunk-plan --config <campaign.yaml> --glossary <glossary.yaml>`) uses
FFmpeg's silence detection on each fragment. Its settings are optional, in `campaign.yaml`:

```yaml
chunking:
  target_chunk_ms: 25000 # preferred chunk length
  max_chunk_ms: 30000 # limit when a pause allows it; speech is never cut
  min_chunk_ms: 5000 # shorter chunks are flagged, never dropped
  remove_pause_min_ms: 2000 # shorter pauses stay in the chunk audio
  removal_padding_ms: 250 # kept on each speech side of a removed pause
  silence_threshold_db: -35
  min_silence_ms: 500
```

These are the built-in defaults, and they are **provisional**: the whisper.cpp spike (S04) did not
measure chunk length, boundary drift or pause settings on real audio. Recheck them on the first
recorded session. Changing any of them invalidates the plan and everything after it.

**Transcription** (`recap run transcribe --config <campaign.yaml> --glossary <glossary.yaml>`) runs
whisper.cpp on each chunk and writes `transcript/<run>/segments.jsonl`, with whisper's own output
kept in `transcript/<run>/raw/`. It needs ffmpeg and the provisioned binary and model (`recap setup
whisper`), and every speaker in the audio must pass the consent check. Ctrl+C, a crash or a killed
process loses at most the chunk in progress: run the same command again and it continues. The first
run on a machine compiles shaders and is slower; that is not a hang.

Segments are never dropped for being doubtful. They are flagged for review instead: `short`,
`low_confidence`, `timestamp_clamped` (whisper's times were out of range) and `repetition_loop`
(the model repeated itself; the text is kept as it came). The limits are optional, in
`campaign.yaml`:

```yaml
asr:
  short_segment_ms: 1000
  low_confidence_mean_permille: 700 # mean token probability x1000
  low_confidence_min_permille: 350 # lowest token probability x1000
  repetition_min_repeats: 3
  repetition_min_words: 12
  repetition_max_unit_words: 120
  prompt_max_chars: 800 # glossary terms past this stay out of the prompt
  timeout_base_ms: 600000 # per chunk: start, model load, shader compilation
  timeout_audio_multiplier: 5 # plus this many ms per ms of chunk audio
```

These are the built-in defaults, and they are **provisional**: S04 did not validate confidence,
repetition or timeout values on real table audio. Recheck them on the first recorded session.
Changing any of them except the two timeouts starts a new transcription run.

**Changing the glossary.** Editing the glossary does not change an existing transcript, and `recap
run` does not transcribe again by itself, because a new run has new segment IDs and your review
overrides would need reconciling. It tells you the transcript does not reflect the edit. To apply
it, run:

```powershell
npm run recap -- retranscribe --campaign <id> --session <id> --config <campaign.yaml> --glossary <glossary.yaml>
```

This makes a new run beside the old one, which stays as it was. If the glossary did not change it
does nothing. After `recap package purge-audio` it refuses: the audio is gone.

A glossary with accented letters reaches whisper through a response file. If your data root or model
path has non-ASCII characters, recap sends the prompt without accents instead, because whisper cannot
read both correctly on Windows.

## 4. Install dependencies and build

From the repository root:

```powershell
npm ci
npm run build
```

## 5. Check the installation

```powershell
npm run recap -- --help
npm run recap -- doctor
```

`npm exec --no -- recap doctor` works too. Don't use a bare `npx recap`: if the local bin isn't linked,
npx downloads an unrelated `recap` package from the npm registry.

`recap doctor` prints the Node version, the platform, and for ffmpeg and ffprobe whether they were found,
their version and path, and where the path came from (`config`, `env` or `PATH`). A healthy install
looks like this:

```text
recap doctor
  node:     v24.x.x
  platform: win32 x64
  ffmpeg:   ok 7.1.1-essentials_build-www.gyan.dev
            path: C:\Users\you\AppData\Local\Microsoft\WinGet\Links\ffmpeg.exe (from PATH)
  ffprobe:  ok 7.1.1-essentials_build-www.gyan.dev
            path: C:\Users\you\AppData\Local\Microsoft\WinGet\Links\ffprobe.exe (from PATH)
  data:     C:\Users\you\AppData\Local\sargas-recap (from default)
            not created yet
  disk:     412.3 GiB free (at C:\Users\you\AppData\Local)
  db:       not initialized (created at schema v2 on first use)
            path: C:\Users\you\AppData\Local\sargas-recap\state\recap.sqlite
  result:   ok
```

If a tool is missing or older than 6.0, doctor prints `MISSING` or `UNUSABLE` with a `fix:` line. A data
root inside a git checkout shows as `REFUSED`, and a database from a newer recap shows as `UNUSABLE` (see
[Data root and app state](#data-root-and-app-state)). doctor also reports whisper.cpp and Vulkan (see
[Transcription tools](#transcription-tools-whispercpp)).
Plain `recap doctor` always exits 0. Use `recap doctor --strict` in scripts: it exits 1 when a check
fails.

## 6. Development commands

| Command                | What it does                                  |
| ---------------------- | --------------------------------------------- |
| `npm test`             | Vitest (unit tests + CLI smoke test)          |
| `npm run lint`         | ESLint                                        |
| `npm run typecheck`    | TypeScript, no emit                           |
| `npm run build`        | Compile `packages/*/src` to `packages/*/dist` |
| `npm run format`       | Prettier, write                               |
| `npm run format:check` | Prettier, check only (CI)                     |

The audio integration tests generate synthetic sine + silence WAVs with ffmpeg at test time. Without
ffmpeg they are skipped locally (the test run prints `[audio integration] SKIPPED`); in CI, where the
workflow installs ffmpeg, they must run.

After changing a contract in `packages/contracts/src`, regenerate the committed JSON Schemas with
`npm run schemas -w @sargas-recap/contracts` (see `docs/adr/README.md`). `npm test` fails if they are
stale.

Prompt files (`packages/core/prompts/`) are hashed with line endings normalized, so a CRLF checkout
or an editor that saves CRLF does not count as a change. Any other edit to a committed prompt needs a
new version file; `npm test` fails otherwise (see `AGENTS.md`, section 4, "Prompts").

## Session package integrity

```powershell
npm run recap -- package validate <package-dir>      # add --json for a machine-readable report
npm run recap -- package seal <package-dir>
npm run recap -- package purge-audio <package-dir>   # asks first; --yes for scripts
```

`validate` prints the package state (`capturing`, `sealed`, ..., `audio-purged`) or `corrupt` /
`invalid`, and one line per problem naming the file, the field and the rule, never the value. It
exits 1 on errors. Windows notes:

- Package paths named like devices (`CON`, `NUL`, `COM1.wav`), ending in a dot or space, containing
  `:` (alternate data streams) or differing only in case are rejected on every OS, so a package
  stays portable.
- Junctions and symlinks are followed with `realpath`; any that lead outside the package are
  rejected. Creating a junction (`mklink /J`) needs no admin rights; the file-symlink tests are
  skipped unless Developer Mode is on.
- Writes go to a temp file (`.<name>.<pid>.<random>.tmp`), are flushed, then renamed. If antivirus or
  the indexer briefly locks the target, the rename is retried for about 1.6 s. A temp file left by a
  crash is reported as a warning and is safe to delete.

## Foundry module package

`npm run package:foundry` builds the Foundry module and writes `packages/foundry-module/dist/module.json`
and `packages/foundry-module/dist/sargas-session-recap.zip`. It needs no extra tools on Windows (the zip is
written in JavaScript). Releases are cut by pushing a `foundry-v<version>` tag; see
[`packages/foundry-module/README.md`](../packages/foundry-module/README.md).

## Transcription tools (whisper.cpp)

Local transcription uses a pinned whisper.cpp binary and model. They live under
`<data-root>\tools\whisper\`, never in the repository. `packages\core\tools.lock.json` is the committed
record of what is pinned: the whisper.cpp version and commit, the sha256 of the binary and each DLL it
loads, and the URL, size and sha256 of each model.

```text
<data-root>\tools\whisper\v1.9.5-vulkan\         whisper-cli.exe, whisper.dll, ggml*.dll
<data-root>\tools\whisper\models\                ggml-large-v3-turbo.bin
<data-root>\tools\whisper\overrides.yaml         optional, see below
```

**Set it up:**

```powershell
npm run recap -- setup whisper
```

Before anything is downloaded, recap lists each file with its source, size and sha256 and asks
`Download these files? [y/N]`. Only `y` or `yes` starts a download, and there is no flag to skip the
question, so it needs an interactive terminal. Each file must match the size and sha256 in the lock. A
corrupt, truncated or tampered download is deleted and the command fails. Re-running is safe: files that
already verify are left alone.

**Build the binary.** whisper.cpp publishes no prebuilt Windows Vulkan binary, so the GM builds it once.
You need Git, CMake, Visual Studio 2022 Build Tools (C++ workload) and the
[LunarG Vulkan SDK](https://vulkan.lunarg.com/). S04 used CMake 4.4.4, MSVC 17.14.44 and Vulkan SDK
1.4.363.0.

```powershell
git clone https://github.com/ggml-org/whisper.cpp D:\wsrc
git -C D:\wsrc checkout d1be6fde11ac6e0407606b4e42fe72d34add8037
cmake -S D:\wsrc -B D:\wvk -DGGML_VULKAN=ON
cmake --build D:\wvk --config Release -j
npm run recap -- setup whisper --from-build D:\wvk\bin\Release
```

Keep the build directory short (`D:\wvk`). The Vulkan shader sub-build goes past the Windows 260-character
path limit if the build directory is under `%LOCALAPPDATA%\sargas-recap\tools\...`, unless Windows long
paths are enabled.

`--from-build` hashes the files in that directory and copies them into the data root only if every one
matches the lock.

**After a rebuild.** Local builds are not byte-reproducible, so a new build will not match the pin. Nothing
is installed, and recap prints the new hashes as a `files` block. If you rebuilt on purpose, replace
`files` under `whisper.binary` in `tools.lock.json` with that block, commit it, and run `--from-build`
again. The binary hash is an input of the transcription stage, so existing transcripts count as out of
date after that.

**Change the model.** Set `active_model` in `tools.lock.json` to another entry of `models` (for example
`large-v3`) and run `recap setup whisper`. `large-v3-turbo` is a provisional choice from S04; Portuguese
table audio has not been tested yet. Changing the model changes the transcription stage's inputs, so
transcription runs again.

**Use your own files.** Create `<data-root>\tools\whisper\overrides.yaml`. Either path is optional, and
relative paths resolve against this file:

```yaml
schema_version: 1
binary_path: D:\wvk\bin\Release\whisper-cli.exe
model_path: D:\models\ggml-large-v3-turbo.bin
```

Overridden files are still hashed. The DLLs are looked for next to `binary_path`. A difference from the
lock is a warning in `recap doctor` and the file is still used. The job records the hash of what was
really used. A path that does not exist is an error, and recap does not fall back to the pinned file.

**Check it.** `recap doctor` adds these lines, and hashes the files each time, so it takes a few seconds:

```text
  whisper:  ok v1.9.5 (d1be6fd)
            path: C:\Users\you\AppData\Local\sargas-recap\tools\whisper\v1.9.5-vulkan\whisper-cli.exe (from lock)
            sha256: 6 files verified
  model:    ok large-v3-turbo
            path: C:\Users\you\AppData\Local\sargas-recap\tools\whisper\models\ggml-large-v3-turbo.bin (from lock)
            sha256: verified
  vulkan:   ok AMD Radeon RX 9070 XT (discrete GPU), AMD Radeon(TM) Graphics (integrated GPU)
```

Tools that are not installed yet show as `MISSING` with a `fix:` line and do not fail `--strict`. A file
that fails its hash shows as `HASH MISMATCH` and does fail it. The `vulkan` line comes from `vulkaninfo`
and shows the devices Windows exposes, not which one whisper.cpp will pick.

## Data location

Never put real session recordings or transcripts inside the repository. `sessions/`, audio files,
transcripts, SQLite databases and `.env*` files are git-ignored as a safety net.

## Data root and app state

recap keeps session packages, the state database, downloaded tools and logs under one **data root**
([ADR-009](adr/ADR-009-data-root.md)). On Windows the default is:

```text
%LOCALAPPDATA%\sargas-recap\          e.g. C:\Users\you\AppData\Local\sargas-recap
  campaigns\<campaign_id>\sessions\<session_id>\
  state\recap.sqlite                  SQLite (WAL); state\backups\ holds pre-migration copies
  state\locks\                        per-session lock files while `recap run` works on a session
  tools\
  logs\
```

User names with spaces or accents (`C:\Users\José Núñez\...`) are fine. To use another location
(for example a larger drive), pick one of these. The first one that is set wins:

```powershell
npm run recap -- doctor --data-root "D:\Recap Data"    # 1. per command
$env:RECAP_DATA_ROOT = "D:\Recap Data"                 # 2. per terminal (or set it in System settings)
# 3. data_root in the recap config (T04)
# 4. default: %LOCALAPPDATA%\sargas-recap
```

Keep the data root on a local disk. SQLite's WAL mode doesn't work on network shares, and synced folders
(OneDrive, Dropbox) can corrupt the database. recap **refuses a data root inside a git working tree**
(it looks for a `.git` folder or file in the root and every parent) so private recordings can't be
committed by accident. Pass `--allow-in-repo` only if you really mean it.

`recap doctor` shows the resolved data root and where it came from, free disk space, and the database
schema version. It never creates anything. Before the first real command runs, the database shows as
`not initialized`:

```text
  data:     C:\Users\you\AppData\Local\sargas-recap (from default)
            not created yet
  disk:     412.3 GiB free (at C:\Users\you\AppData\Local)
  db:       not initialized (created at schema v2 on first use)
            path: C:\Users\you\AppData\Local\sargas-recap\state\recap.sqlite
```

When a newer recap needs a schema upgrade, it copies the database to `state\backups\` first and then
migrates in a single transaction. If the upgrade fails, the database stays at its old version. An older
recap refuses to open a database written by a newer one (`DB_SCHEMA_TOO_NEW`). Update recap, or restore a
backup from `state\backups\`.

SQLite comes from `better-sqlite3`. During `npm ci` it downloads a prebuilt Windows binary from GitHub
(cached under `%LOCALAPPDATA%\npm-cache\_prebuilds`), so you don't need Visual Studio Build Tools or
Python. If the download is blocked (proxy, offline), it tries to compile and fails without Build Tools.
Allow `github.com` or install the "Desktop development with C++" workload.

## Running stages and job state

`recap run <stage>` brings one stage of one session up to date, together with every stage it depends
on. `recap status` shows what ran. Job state lives only in `state\recap.sqlite`
([ADR-001](adr/ADR-001-artifact-ownership.md)), never in the repository or the session package.

```powershell
npm run recap -- run classify --campaign my-campaign --session s07 `
  --config "D:\Recap Data\campaigns\my-campaign\campaign.yaml" `
  --glossary "D:\Recap Data\campaigns\my-campaign\glossary.yaml"
npm run recap -- status --campaign my-campaign --session s07     # --all for history, --json
```

`chunk-plan`, `transcribe`, `classify` and `recap` are available today.

- **Only what changed runs again.** Each job records the hashes of its inputs: upstream outputs, the
  config fields that stage actually uses, prompts and models. A stage reruns only when one of them
  changed, and the stages after it rerun only if its output changed. Editing a display name, a consent
  record or the recording provider reruns nothing.
- **One run per session.** A second `recap run` on a session that is being processed stops at once and
  names the process (pid) that holds it. Different sessions can run in parallel.
- **Ctrl+C** marks the running job `cancelled` and exits with code 130. Run the same command again to
  continue; finished stages are not redone.
- **Crashes and closed windows.** If the process dies (crash, killed from Task Manager, PC turned off),
  the next `recap run` on that session sees that the owner is gone (its pid no longer exists, or it
  sent no heartbeat for 30 s), takes the lock over, marks the stuck job `failed` with code
  `interrupted` (recoverable) and runs that stage again. Until then `recap status` shows the job with
  `owner process is gone`. A leftover `state\locks\<campaign>\<session>.lock` file is informational
  only and safe to delete.
- **Retries.** Errors a stage marks as temporary (for example a provider timeout) are retried with
  exponential backoff (1 s, 2 s, 4 s, ... capped at 30 s), 3 attempts by default; change it with
  `--max-attempts <n>`. Other errors fail the job at once. Error messages never contain transcript or
  prompt text.
- Exit codes: `0` succeeded, `1` failed or refused, `2` bad arguments, `130` cancelled.

## Classification

`recap run classify` labels every segment of the current transcription through the backend named in
`campaign.yaml` (see LLM backend). It reads the transcript only, needs no Foundry events, and keeps
working after `package purge-audio`: the earlier stages stand as they are and only classification runs.

```powershell
npm run recap -- run classify --campaign my-campaign --session s07 `
  --config "D:\Recap Data\campaigns\my-campaign\campaign.yaml" `
  --glossary "D:\Recap Data\campaigns\my-campaign\glossary.yaml"
```

- **Windows.** Core cuts the session into windows of about 20 to 30 minutes, preferring pauses. Each
  segment is classified in exactly one window; a little of the neighbouring windows goes along as
  context only. The model sees the campaign speakers and glossary, never display names.
- **Labels.** `ic`, `narration`, `rules`, `ooc`, `mixed`, `uncertain`. `mixed`, `uncertain` and
  repetition loops are marked for review. OOC stays in the results but is left out of the recap by
  default.
- **Output.** `classify\<run>\results.jsonl` (labels, corrections, flags) and
  `corrections-report.json`: names fixed, names the model could not match to the glossary, and
  corrections core refused and why. The original transcript text is never changed.
- **A failed window.** Each window is retried a bounded number of times (`--max-attempts`). If one
  still fails validation, the others are finished and kept and the job fails naming the window; run
  the same command again and only that window is sent again. Nothing is retranscribed. A provider
  failure such as a usage limit stops the run instead, with what was finished kept.
- **Prompts are a first version.** No labelled tuning data exists yet, so classification quality is
  unmeasured. Treat labels as a draft and review them.

## Review overrides

Your review decisions live in the state database, apart from the transcript and the labels. Running
classification again never changes them. The effective transcript is worked out on demand from the
latest transcription, its latest classification and your overrides.

```powershell
npm run recap -- overrides effective --campaign my-campaign --session s07 --text
npm run recap -- overrides set --campaign my-campaign --session s07 --segment <segment-id> `
  --label ic --inclusion include --status reviewed
npm run recap -- overrides set --campaign my-campaign --session s07 --segment <segment-id> `
  --text-file "D:\Recap Data\cleaned.txt"
npm run recap -- overrides set --campaign my-campaign --session s07 --segment <segment-id> `
  --exclusion spoiler
npm run recap -- overrides list --campaign my-campaign --session s07
npm run recap -- overrides history --campaign my-campaign --session s07 --override <override-id>
```

- **Accents.** PowerShell can mangle accented text passed with `--text`. Use `--text-file` with a
  UTF-8 file.
- **Clearing.** `--clear-label`, `--clear-text`, `--clear-exclusions`, and `--inclusion default` to
  take back an inclusion decision. Every change is kept in the history.
- **Recap inclusion.** An exclusion (`spoiler`, `privacy`, `off-topic`) always wins. Otherwise your
  decision applies, and without one the label decides: OOC is left out, `mixed` and `uncertain` wait
  for you. A `mixed` line goes in only with a cleaned text or `--inclusion include`.
- **Doubtful audio.** Repetition loops and low-confidence lines stay in the list, marked for review.
  `overrides effective --text` also shows the original text whenever the effective text differs.

**After `recap retranscribe`** the new run has new segment IDs, so every override of the old run
stops applying and appears under `needs reconciliation` in `overrides list`. recap never moves one
for you, even to a line with the same words. For each one:

```powershell
npm run recap -- overrides reconcile --campaign my-campaign --session s07 --override <override-id> --segment <new-segment-id>
npm run recap -- overrides reconcile --campaign my-campaign --session s07 --override <override-id> --discard
```

If a line was split, run the first command once per part. If two lines were merged and the new one
already has an override, change that override with `overrides set`, then discard the other. A recap
is refused while a `spoiler` or `privacy` exclusion is waiting here.

## Recap draft

`recap run recap` writes a Portuguese draft from the effective transcript, through the backend named
in `campaign.yaml`. It never publishes anything: the draft waits for your review.

```powershell
npm run recap -- run recap --campaign my-campaign --session s07 `
  --config "D:\Recap Data\campaigns\my-campaign\campaign.yaml" `
  --glossary "D:\Recap Data\campaigns\my-campaign\glossary.yaml"
```

- **What goes in.** Only lines whose recap inclusion is `include`. Excluded lines and lines waiting
  for your decision are not sent. Earlier recaps of the campaign and the glossary go along as
  background, which never counts as evidence.
- **Refusals.** A recap is refused, before anything is sent, while a `spoiler` or `privacy` exclusion
  is waiting for reconciliation, and when no line is included.
- **Output.** A new `recap\<revision>\` for each generation; older revisions stay as they are.
  `recap.json` is the draft, `recap.md` is the same text with footnotes, and `gm-notes.md` is for you
  alone: it lists what the draft could not support, and the lines waiting for your decision. Do not
  send that file to players.
- **Citations.** Every sentence cites transcript lines. A citation of a line that was not sent fails
  the attempt, and a sentence with no citation, or one based only on background, becomes a GM note.
- **Foundry events** are not used yet (T17, T18), so sentences cite only the transcript.
- **Prompts are a first version.** No labelled data exists, so recap quality is unmeasured. Read the
  draft against its footnotes before using it.

## Review screen

`recap review` opens one session on a page on your own machine, for correcting the transcript and
reading the draft against its evidence. Run `npm run build` first, so the page has its small script.

```powershell
npm run recap -- review --campaign my-campaign --session s07 `
  --config "D:\Recap Data\campaigns\my-campaign\campaign.yaml" `
  --glossary "D:\Recap Data\campaigns\my-campaign\glossary.yaml"
```

The command prints a link. Open it in your browser and press Ctrl+C in the terminal when you are
done. `--port` picks a port; without it a free one is used. Without `--config` and `--glossary`
everything works except regenerating the recap.

- **Private.** The server answers only on `127.0.0.1`. The link holds a secret that changes every
  run, so a link from an earlier run stops working. Do not paste it anywhere. Windows Firewall has
  nothing to allow.
- **Review queue.** Overrides waiting for reconciliation come first, then lines flagged as possible
  spoilers, then unresolved ones, then doubtful audio and spelling corrections. A line leaves the
  queue when you mark it reviewed.
- **Possible spoilers.** Recap generation does not remove them. A flagged line stays included until
  you exclude it, so check each one before regenerating.
- **What changed.** A line whose text was altered shows the original next to the result, with each
  correction. A spelling correction with no glossary entry is highlighted.
- **Corrections.** Each line has quick buttons and an `Edit override` form with the same choices as
  `recap overrides set`. If the override changed elsewhere after the page loaded, the save is refused:
  reload and redo it. The list can be filtered, and `j` / `k` move between lines.
- **Foundry events** appear in the list when the session has them. Their position is an estimate.
- **Recap panel.** Footnotes jump to the cited lines. The player-facing text and the GM notes are
  separate panels; GM notes are for you alone and never leave this page. Nothing is published from
  here.
- **Editing the recap.** Each sentence, the title and each GM note has an `Edit` form. Edited sentences
  are marked `edited — verify evidence`. A sentence can cite only lines included in the recap; give
  refs such as `0:12`. The generated draft file is never rewritten, and `Back to generated text` undoes
  an edit.
- **Approval.** A recap goes draft → reviewed → approved → exported. `Mark reviewed`, then
  `Approve this exact revision`. Approval is tied to the exact text and citations: any later change
  to the title, a sentence or its citations returns the recap to draft, and it must be reviewed and
  approved again. GM-note edits do not. Approval is refused while a spoiler or privacy exclusion
  waits for reconciliation, or while a sentence cites a line you have excluded: change its citations
  or remove the sentence. If lines flagged as possible spoilers are still included, you must confirm
  them first: nothing removes them for you.
- **Export and Copy Markdown.** Both work only on an approved revision. `Export recap package` writes
  `exports\recap-r<revision>-<id>.json` in the session folder and offers it as a download for the
  Foundry import; `Copy Markdown` copies the approved text. Neither ever contains GM notes, excluded
  lines or removed sentences. An exported revision is frozen: changing its text creates a new revision,
  and the screen moves to it. `--reviewer <slug>` (default `gm`) names who is recorded.
- **Regenerate.** Asks for a confirmation, because it sends the included lines to the provider. It
  writes a new revision, and corrections are locked until it ends. It reports `no new revision` when
  nothing changed since the last draft, and is refused while a spoiler or privacy exclusion waits for
  reconciliation.
- **Logs** carry only the route, the status and the timing, never session text.

## Campaign config and consent

Each campaign has a `campaign.yaml` (speakers, per-stage provider, consent mode and records) and a
`glossary.yaml`. Keep both in the data root, never in the repository: they name real people and record
their consent. Start from the synthetic examples in `fixtures/config/`. Notepad's UTF-8 (with or without
BOM) and CRLF line endings are fine.

- **Consent.** By default, attending your table is consent (`consent_mode: implied`): speakers need no
  `consent:` entries. Only speakers listed in `campaign.yaml` are processed, so audio from anyone else is
  refused, and every run records that consent was implied. To require dated consent records instead,
  turn record checks on for that campaign, and off again the same way:

  ```powershell
  npm run recap -- config consent on "D:\Recap Data\campaigns\my-campaign\campaign.yaml"
  npm run recap -- config consent status "D:\Recap Data\campaigns\my-campaign\campaign.yaml"
  npm run recap -- config consent off "D:\Recap Data\campaigns\my-campaign\campaign.yaml"
  ```

  This sets `consent_mode: records` (on) or `implied` (off) in `campaign.yaml`, keeping your comments.

- With record checks on, consent is recorded per speaker, per purpose (`recording`, `asr`,
  `classification`, `recap`) and per provider, with the date (`granted_on: 2026-01-10`, optional
  `withdrawn_on`). Keep signed forms or call notes next to the config and point at them with
  `evidence_ref`; recap never opens or copies them. Changing a stage's provider then needs new consent
  records for that provider; until they exist, processing refuses to run and names the speakers whose
  consent is missing.
- Invalid files are reported as `<file>:<line>:<col>: <path>: <problem>`. Values are never printed.

## LLM backend

Classification and recap call Claude through the backend named in `campaign.yaml`, one model ID per
stage. There is no built-in default model; the stages refuse to run without `llm_model`:

```yaml
provider:
  classification: claude-cli # or claude-api
  recap: claude-cli
llm_model:
  classification: claude-sonnet-5-5
  recap: claude-sonnet-5-5
```

Changing a stage's provider needs new consent records for it, unless consent checks are off.

**`claude-cli` (default path).** Uses your Claude Code login.

```powershell
winget install --id Anthropic.ClaudeCode -e
claude    # then /login, then exit
```

If a new terminal can't find `claude`, point recap at the executable. A `claude.cmd` npm shim can't be
used, because recap starts the CLI without a shell:

```powershell
[Environment]::SetEnvironmentVariable('RECAP_CLAUDE', 'C:\full\path\to\claude.exe', 'User')
```

Each run gets no tools and no MCP servers, works in an empty temporary folder that is deleted afterwards,
and receives the transcript on stdin. API-key variables are not passed to it, so an `ANTHROPIC_API_KEY`
in your environment can't silently bill the API. If a run fails with `llm-not-logged-in`, repeat
`/login`.

**`claude-api` (fallback).** Needs an API key, kept in Windows Credential Manager:

```powershell
npm run recap -- secrets set anthropic      # hidden prompt; the key is never printed
npm run recap -- secrets delete anthropic
```

`ANTHROPIC_API_KEY` is read only when `CI=true`. Never put a key in `campaign.yaml` or in the repository.

Failed output (invalid JSON, or output that breaks the contract) and temporary errors are retried up to
3 times per call, and the tokens of every attempt are added to the job. `recap status` shows them.
Error messages and logs never contain transcript text, prompts or keys.

## Importing a recording

`recap import` turns a multitrack recording (one audio file per speaker, for example a Craig export)
into a sealed session package under the data root. It needs no Discord bot, no Foundry, no network
and no database. 16-bit PCM WAV tracks are read without ffmpeg; FLAC and Ogg/Opus tracks need
`ffprobe` (see section 3).

1. Put the tracks in one folder (no sub-folders) and keep `campaign.yaml` at its default place,
   `<data root>\campaigns\<campaign id>\campaign.yaml` (or pass `--config <file>`).
2. Next to the tracks, create `recap-tracks.yaml` (or `.yml` / `.json`, or pass `--mapping <file>`):

   ```yaml
   schema_version: 1
   # recorder: craig                   # optional; must equal provider.recording in campaign.yaml
   # origin_uncertainty_ms: 0          # optional; how sure you are about session zero
   default_timing_uncertainty_ms: 0 # optional; for tracks that do not set their own
   tracks:
     - file: 1-gm.flac # file name in the folder, no sub-folders
       speaker_id: gm # a speaker_id from campaign.yaml
     - file: 2-player-ana.flac
       speaker_id: player-ana
       start_offset_ms: -1500 # optional, signed integer ms; default 0
       timing_uncertainty_ms: 40 # optional
       label: Ana's mic # optional; default: the file name
     - file: 2-player-ana-after-reconnect.flac # several files per speaker are fine
       speaker_id: player-ana
       start_offset_ms: 3600000
   ```

3. Run it (quote paths with spaces):

   ```powershell
   npm run recap -- import "D:\Recordings\2026-11-08 craig" --campaign my-campaign --session s07
   ```

What it does and what to expect:

- **Timeline.** There is no sync marker in an import, so session zero is provisional (ADR-003): it is
  wherever `start_offset_ms: 0` is. Each track's `start_offset_ms` is the session time of its first
  sample (negative means it started before zero) and is stored as `fragment_start_offset_ms` in
  `fragments.jsonl`. Craig tracks all start together, so offsets are usually 0.
- **Unmapped files.** Audio files in the folder that the mapping does not list are not imported and are
  listed as `not in the track mapping`. A mapped file that does not exist stops the import.
- **Consent.** The recording consent check (`assertConsent`, stage `recording`, the recorder's
  provider) runs for every mapped speaker. Speakers it refuses (no record, withdrawn, not in
  `campaign.yaml`) are left out and listed with the reason; the rest are imported. With
  `recap config consent off` (implied mode) every speaker listed in `campaign.yaml` is accepted, and
  unlisted speakers are still refused. The manifest records, per imported speaker, the consent mode,
  provider and policy hash that applied.
- **Originals are never modified.** Each track is hashed, copied byte for byte to
  `audio\<speaker_id>\<n>.<ext>` (numbered from 1 per speaker, in start-offset order), the copy is
  hashed, and the original is hashed again at the end. Any difference stops the import (for example a
  recorder or a sync tool still writing). Keep the originals until you no longer need them; recap
  never deletes them.
- **Supported tracks:** 16-bit PCM WAV, FLAC and Opus (8-192 kHz, 1-8 channels). Convert anything else
  losslessly first, e.g. `ffmpeg -i track.mp3 -c:a flac track.flac`.
- **The package is sealed and validated** with the same checks as `recap package validate`. It is built
  in a temp folder and only renamed into place when complete, so a failed import leaves nothing.
- **Re-import.** Importing into a session that already has a package is refused. `--replace` replaces
  it after asking (add `--yes` in scripts), but only if it was not processed yet: a package with
  transcripts, classifications or recaps, or with purged audio, is never replaced. Use a new
  `--session` id instead.
- Errors name the mapping entry (`recap-tracks.yaml /tracks/1/file`) and the fix. Logs carry only IDs,
  counts and error codes, never file names or audio.
