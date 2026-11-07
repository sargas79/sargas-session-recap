# @sargas-recap/foundry-module

Foundry VTT v14 module for the Session Recap Bot. **Placeholder (T24):** it registers itself on
`Hooks.once('init')` and logs one line with the module id. Event capture, storage and writer election
come in T16 (#21). See [ADR-008](../../docs/adr/ADR-008-workspace-layout.md) for the dependency rules:
this package may import `@sargas-recap/contracts`, never `@sargas-recap/core` or Node APIs.

## Layout

| Path                   | Purpose                                                                          |
| ---------------------- | -------------------------------------------------------------------------------- |
| `src/module.ts`        | Entry point, bundled to `dist/scripts/module.js` (browser ESM)                   |
| `src/foundry.d.ts`     | Minimal ambient types for the Foundry globals used (`Hooks`)                     |
| `module.template.json` | Static manifest fields; `version`, `manifest` and `download` are filled at build |
| `scripts/build.mjs`    | esbuild bundle + `dist/module.json`                                              |
| `scripts/package.mjs`  | `dist/sargas-session-recap.zip` (`module.json` + `scripts/*.js` at the root)     |
| `scripts/manifest.mjs` | Shared version/URL helpers                                                       |

## Commands

From the repository root (PowerShell or Git Bash):

```powershell
npm run build                 # builds every workspace, including this bundle and dist/module.json
npm run package:foundry       # build + zip -> packages/foundry-module/dist/
npm test                      # includes the build smoke, manifest consistency and dependency-direction tests
```

Both scripts accept `--out-dir <dir>`. `package.mjs` also accepts `--expect-tag foundry-v<version>` and fails
if the tag doesn't match `package.json`.

## Versions and URLs

- The version comes from this package's `package.json`.
- `manifest` and `download` point at the GitHub release for tag `foundry-v<version>`:
  `https://github.com/sargas79/sargas-session-recap/releases/download/foundry-v<version>/module.json` and
  `.../sargas-session-recap.zip`.

## Releasing

1. Bump `version` in `packages/foundry-module/package.json` and merge to `main`.
2. Push a tag `foundry-v<version>` (for example `foundry-v0.1.0`).
3. `.github/workflows/release-foundry.yml` checks the tag against the version, runs lint, typecheck, build
   and tests, packages the module and attaches `module.json` + the zip to the release.

## Caveats

- **Foundry v14 compatibility is unverified.** `compatibility.minimum` and `verified` are set to `"14"`, but
  nothing has been tested in a real Foundry instance. Treat `verified` as unconfirmed until spike S03 (#13)
  records a PASS.
- **Types are a stopgap.** `src/foundry.d.ts` declares only what this placeholder uses. T16 decides whether
  to adopt a real Foundry type package or keep hand-written declarations.
- The entry uses one named import from contracts to prove the bundling path. Keep to named imports:
  contracts is marked `"sideEffects": false`, so unused parts (e.g. the Ajv validators) are dropped. Once T16
  validates in the browser, Ajv is bundled; consider precompiled validators to keep the size down.
