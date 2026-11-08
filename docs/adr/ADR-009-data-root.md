# ADR-009: Data root and app-state locations

- Status: Accepted
- Date: 2026-11-07
- Issue: [#45](https://github.com/sargas79/sargas-session-recap/issues/45) (`T25`), gaps G-4 and G-5
- Related: ADR-001 (ownership), ADR-004 (identity), ADR-006 (package layout), T04 (#20 config),
  T07 (#23 jobs), T12 (#30 overrides), T23 (#47 tools download)
- Amended: T07 (#23) added `state/locks/` to the layout (`DataPaths.locksDir`, `sessionLockFile()`)

## Context

Session packages hold private audio and transcripts. ADR-006 defines what is inside a package but
not where packages live, and ADR-001 makes SQLite the owner of job and review state without saying
where the database is or how its schema changes. If modules picked locations on their own, private
data could end up inside the git checkout and one `git add -A` from a commit. A schema change without
a migration framework could also corrupt an operator's only copy of their review state.

## Decision

### Resolution order

The data root is resolved once per command, first match wins:

| #   | Source                      | Notes                                                        |
| --- | --------------------------- | ------------------------------------------------------------ |
| 1   | `--data-root <dir>`         | Relative values resolve against the current directory.       |
| 2   | `RECAP_DATA_ROOT` env var   | Empty or blank counts as unset.                              |
| 3   | `data_root` in config (T04) | Relative values resolve against the config file's directory. |
| 4   | Platform default            | See below.                                                   |

Platform defaults (per user, never inside the repo):

| Platform | Default                                                                         |
| -------- | ------------------------------------------------------------------------------- |
| Windows  | `%LOCALAPPDATA%\sargas-recap` (fallback `<home>\AppData\Local\sargas-recap`)    |
| Linux    | `$XDG_DATA_HOME/sargas-recap` when absolute, else `~/.local/share/sargas-recap` |
| macOS    | `~/Library/Application Support/sargas-recap`                                    |

`%LOCALAPPDATA%` (not roaming `%APPDATA%`) is used because audio and SQLite files are large, and
SQLite with WAL must not sit on a synced or network location. User names with spaces or non-ASCII
characters are supported: paths are passed as strings end to end (Node and `better-sqlite3` use the
wide-character Windows APIs), and tests cover both.

### Layout

```text
<root>/
  campaigns/<campaign_id>/sessions/<session_id>/   one session package (ADR-006 layout inside)
  state/recap.sqlite                               app state owned by SQLite (ADR-001), WAL mode
  state/backups/                                   pre-migration backups of recap.sqlite
  state/locks/<campaign_id>/<session_id>.lock      per-session job lock mirror (T07; the row in SQLite is authoritative)
  tools/                                           downloaded tools such as whisper (T23)
  logs/                                            structured logs (allowlisted fields only)
```

- `packages/core/src/paths/` is the only code that builds these paths (`openDataRoot()`,
  `createDataPaths()`). Modules must not join data-root segments by hand.
- `campaign_id` and `session_id` must be ADR-004 slugs (`[a-z0-9-]`, 1-64 chars, no leading or
  trailing hyphen) and must not be a Windows device name (`con`, `nul`, `com1`, ...). This makes a
  path segment unable to escape its parent (`..`, `/`, `\`, drive letters are impossible). Safe
  resolution of package-relative paths inside a package (symlinks, reserved names) remains T03's job.
- Directories are created lazily by the code that writes into them; resolving or checking a root
  (`recap doctor`) never creates anything.

### Data root inside a git working tree

After resolution, recap walks up from the root (inclusive; the root need not exist yet) looking for
a `.git` directory or a `.git` file (worktrees and submodules). If it finds one, the command refuses
with `PATHS_DATA_ROOT_IN_REPO` unless `--allow-in-repo` is passed. The `.gitignore` entries for audio,
transcripts and SQLite files stay as a second safety net. If a home directory is itself a git
repository (dotfiles), the default root is refused too; set `RECAP_DATA_ROOT` or pass
`--allow-in-repo`.

### SQLite migrations

- Driver: `better-sqlite3` pinned to an exact version, **12.11.1** (types `@types/better-sqlite3`
  9.6.0). Its install script runs `prebuild-install`, which downloads the prebuilt binary for the
  running Node ABI (Node 24 = `node-v137`, win32-x64 and linux-x64 among others) from the project's
  GitHub releases. No compiler is needed. It falls back to `node-gyp` only when no prebuild matches.
  This was verified with `npm ci` on Windows 11 without Visual Studio Build Tools. That settles plan
  risk 8 for SQLite, so the `node:sqlite` fallback is not needed and is not implemented. If it is
  ever needed, it goes behind `openDatabase()`/`SqliteDatabase` in `packages/core/src/db/`.
- Why not 13.x: 13.0.3 bundles its binaries in the tarball and opts out of node-gyp with
  `"gypfile": false`. `npm install` honours that, but `npm ci` (npm 11.19) builds from lockfile
  metadata that does not record `gypfile`. It then runs a synthetic `node-gyp rebuild` and fails on a
  machine without Build Tools. Revisit when npm keeps `gypfile` for lockfile installs.
- Installing therefore needs network access to `github.com` for the prebuild (or a C++ toolchain).
  The download is cached by the prebuild cache in `%LOCALAPPDATA%\npm-cache\_prebuilds`.
- Migrations are `packages/core/src/db/migrations/NNNN_name.sql`, numbered from `0001` without gaps
  and **forward-only**: a shipped file is never edited, renumbered or deleted. The build copies them
  to `dist/db/migrations/` (`scripts/copy-migrations.js`).
- `0001_init.sql` creates only `schema_migrations(version, name, checksum, applied_at)`. Its
  highest `version` is the schema version, and it is the only source of truth for it
  (`PRAGMA user_version` is not used). Jobs (T07) and overrides (T12) come in later migrations.
- On every open (`openDatabase()`/`openStateDatabase()`):
  1. set `busy_timeout` (default 5 s), `journal_mode=WAL` (refuse if WAL cannot be enabled),
     `synchronous=NORMAL` and `foreign_keys=ON`;
  2. refuse a database whose version is newer than the code (`DB_SCHEMA_TOO_NEW`, no downgrades),
     whose applied migrations no longer match the shipped files (`DB_MIGRATION_MODIFIED`, SHA-256
     over LF-normalized SQL), or that has tables but no `schema_migrations` (`DB_NOT_RECAP`);
  3. if a migration is pending and the database already has a version, take a backup with SQLite's
     online backup API to `state/backups/recap-v<NNNN>-<UTC timestamp>.sqlite` (a brand-new database
     has nothing to back up);
  4. apply **all** pending migrations in one `BEGIN IMMEDIATE` transaction, re-reading the version
     under the write lock (concurrent openers serialize, and the second one finds nothing to do),
     record each in `schema_migrations`, run `foreign_key_check`, then commit.
- Any failure rolls the whole batch back: the database stays at the version it had before the open,
  and the backup stays on disk. Migrations must therefore be transactional SQL. They must not contain
  `BEGIN`/`COMMIT` (detected) or `PRAGMA foreign_keys`, `journal_mode` or `VACUUM`, because those do
  not work inside a transaction.
- Backups are never deleted automatically; pruning them is an operator decision.

### `recap doctor`

Doctor reports the resolved root and its source, whether it exists, whether it is refused for being
inside a git working tree, free disk space (`fs.statfs` on the nearest existing ancestor), and the
DB schema version (`not initialized`, `ok`, `pending`, or `UNUSABLE` for a newer or broken DB). It
opens an existing database read-only and never creates the root or the database.

## Consequences

- Every module receives a `DataPaths` object; tests point it at a temp directory with
  `--data-root`/`RECAP_DATA_ROOT` or `openDataRoot({ flag })`.
- T04 passes the config's `data_root` (and the config file's directory) into `openDataRoot()`; it
  does not decide precedence itself.
- T07 adds `0002_jobs.sql` (or the next free number), T12 adds the overrides table, each with a test
  that migrates from every prior version.
- Moving to a newer recap is safe (forward migration with a backup); going back to an older recap
  after a migration is refused until the operator restores a backup.
- The data root can be copied or backed up as one directory.

## Alternatives considered

- **`sessions/` inside the repository.** Rejected: private data one command away from a commit; the
  `.gitignore` alone is too easy to bypass.
- **Roaming `%APPDATA%`.** Rejected: large files in a roaming profile, and sync tools break SQLite WAL.
- **One transaction per migration.** Rejected: an interrupted batch would leave an intermediate
  version that no released recap had ever produced.
- **`PRAGMA user_version` as the version.** Rejected as the only record: no history or checksums.
  Keeping both would allow them to disagree.
- **Copying the DB file for backups.** Rejected: a plain copy can miss pages still in the WAL. The online
  backup API produces a consistent snapshot.
- **`node:sqlite`.** Kept as a documented fallback only: it is not yet marked stable in Node 24,
  and `better-sqlite3` 12.11.1 installs from a prebuild without native build steps.
