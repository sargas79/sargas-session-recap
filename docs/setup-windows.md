# Windows setup

The Session Recap Bot runs locally on Windows 10/11. This guide gets a development checkout working.
Later tasks add prerequisites (ffmpeg in T22, whisper.cpp in T23); they will be documented here.

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

## 3. Install dependencies and build

From the repository root:

```powershell
npm ci
npm run build
```

## 4. Check the installation

```powershell
npm run recap -- --help
npm run recap -- doctor
```

`npm exec --no -- recap doctor` works too. Don't use a bare `npx recap`: if the local bin isn't linked,
npx downloads an unrelated `recap` package from the npm registry.

`recap doctor` prints the Node version and platform. It reports `no checks configured yet` until later
tasks add environment checks. It always exits 0 for now.

## 5. Development commands

| Command                | What it does                                  |
| ---------------------- | --------------------------------------------- |
| `npm test`             | Vitest (unit tests + CLI smoke test)          |
| `npm run lint`         | ESLint                                        |
| `npm run typecheck`    | TypeScript, no emit                           |
| `npm run build`        | Compile `packages/*/src` to `packages/*/dist` |
| `npm run format`       | Prettier, write                               |
| `npm run format:check` | Prettier, check only (CI)                     |

After changing a contract in `packages/contracts/src`, regenerate the committed JSON Schemas with
`npm run schemas -w @sargas-recap/contracts` (see `docs/adr/README.md`). `npm test` fails if they are
stale.

## Foundry module package

`npm run package:foundry` builds the Foundry module and writes `packages/foundry-module/dist/module.json`
and `packages/foundry-module/dist/sargas-session-recap.zip`. It needs no extra tools on Windows (the zip is
written in JavaScript). Releases are cut by pushing a `foundry-v<version>` tag; see
[`packages/foundry-module/README.md`](../packages/foundry-module/README.md).

## Data location

Never put real session recordings or transcripts inside the repository. `sessions/`, audio files,
transcripts, SQLite databases and `.env*` files are git-ignored as a safety net. The default data root
outside the repo is defined in T25.
