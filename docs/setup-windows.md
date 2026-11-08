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
  db:       not initialized (created at schema v1 on first use)
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
  db:       not initialized (created at schema v1 on first use)
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

## Campaign config and consent

Each campaign has a `campaign.yaml` (speakers, per-stage provider, consent records) and a
`glossary.yaml`. Keep both in the data root, never in the repository: they name real people and record
their consent. Start from the synthetic examples in `fixtures/config/`. Notepad's UTF-8 (with or without
BOM) and CRLF line endings are fine.

- Consent is recorded per speaker, per purpose (`recording`, `asr`, `classification`, `recap`) and per
  provider, with the date (`granted_on: 2026-01-10`, optional `withdrawn_on`). Keep signed forms or call
  notes next to the config and point at them with `evidence_ref`; recap never opens or copies them.
- Changing a stage's provider in `campaign.yaml` needs new consent records for that provider. Until they
  exist, processing refuses to run and names the speakers whose consent is missing.
- Invalid files are reported as `<file>:<line>:<col>: <path>: <problem>`. Values are never printed.
