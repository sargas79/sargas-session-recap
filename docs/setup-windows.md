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
[Data root and app state](#data-root-and-app-state)).
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

The real stages arrive with the transcription, classification and recap tasks; until then
`recap run` answers that no stages are registered.

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

## Campaign config and consent

Each campaign has a `campaign.yaml` (speakers, per-stage provider, consent mode and records) and a
`glossary.yaml`. Keep both in the data root, never in the repository: they name real people and record
their consent. Start from the synthetic examples in `fixtures/config/`. Notepad's UTF-8 (with or without
BOM) and CRLF line endings are fine.

- **Consent switch.** By default recap checks consent records (below). If attending your table is
  consent enough, turn the checks off for that campaign; turn them back on the same way:

  ```powershell
  npm run recap -- config consent off "D:\Recap Data\campaigns\my-campaign\campaign.yaml"
  npm run recap -- config consent status "D:\Recap Data\campaigns\my-campaign\campaign.yaml"
  npm run recap -- config consent on "D:\Recap Data\campaigns\my-campaign\campaign.yaml"
  ```

  This sets `consent_mode: implied` (off) or `records` (on) in `campaign.yaml`, keeping your comments.
  When off, speakers need no `consent:` entries, but only speakers listed in `campaign.yaml` are
  processed, and every run records that consent was implied.

- Consent is recorded per speaker, per purpose (`recording`, `asr`, `classification`, `recap`) and per
  provider, with the date (`granted_on: 2026-01-10`, optional `withdrawn_on`). Keep signed forms or call
  notes next to the config and point at them with `evidence_ref`; recap never opens or copies them.
- Changing a stage's provider in `campaign.yaml` needs new consent records for that provider. Until they
  exist, processing refuses to run and names the speakers whose consent is missing.
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
