# ADR-008: Workspace layout and dependency direction

- Status: Accepted
- Date: 2026-11-07
- Issue: [#44](https://github.com/sargas79/sargas-session-recap/issues/44) (`T24`), builds on T01 (#16)

## Context

The project ships two runtimes from one repository: a local Node.js CLI that runs the pipeline, and a
Foundry VTT v14 module that runs in the browser. Both must agree on the same event and recap contracts.
T01 adopted npm workspaces with `packages/core` and `packages/contracts`. T24 adds the Foundry module
package and fixes how packages may depend on each other.

## Decision

### Packages

| Package          | Name                           | Runtime | Purpose                                                                                  |
| ---------------- | ------------------------------ | ------- | ---------------------------------------------------------------------------------------- |
| `contracts`      | `@sargas-recap/contracts`      | both    | Canonical schemas, types and validators (T02). Runtime-neutral.                          |
| `core`           | `@sargas-recap/core`           | Node    | CLI (`recap`) and pipeline stages. Free to use Node APIs and native modules.             |
| `foundry-module` | `@sargas-recap/foundry-module` | browser | Foundry module bundle (esbuild, ESM), `module.json` and the release zip. Logic from T16. |

All packages are `private`, ESM and listed in the root `workspaces`. Root `build`, `lint`, `typecheck` and
`test` cover every package.

### Dependency direction

```
core ──────────► contracts ◄────────── foundry-module
```

- `core` → `contracts`: allowed.
- `foundry-module` → `contracts`: allowed. Contracts are bundled into the module by esbuild (no runtime
  dependency loading in Foundry).
- `foundry-module` → `core`: **forbidden**. Core is Node-only and would pull Node APIs into the browser.
- `contracts` → Node built-ins (`node:*`, `fs`, `path`, `crypto`, …): **forbidden**, including type-only
  imports. Contracts must stay bundleable for the browser. Third-party dependencies of contracts (for
  example TypeBox, Ajv) must be browser-compatible.
- `contracts` → `core` or `foundry-module`: forbidden (contracts is the leaf).

Enforcement: `packages/foundry-module/test/dependency-direction.test.ts` (part of `npm test`) scans
`packages/contracts/src` for Node built-in imports and `packages/foundry-module/{src,scripts}` plus its
`package.json` for any dependency on core. The esbuild build also uses `platform: 'browser'`, so a Node
built-in that slips through fails the bundle.

### Shared TypeScript configuration

- `tsconfig.base.json` holds the strict compiler options. Every package extends it.
- Node packages (`core`, `contracts`) use `module`/`moduleResolution: nodenext` and Node types from the base.
- `foundry-module/tsconfig.json` overrides for the browser: `lib` adds `dom`, `types: []` (no Node
  types), `moduleResolution: bundler`, and a `paths` entry that resolves `@sargas-recap/contracts` to
  `packages/contracts/src`. Typecheck and bundling therefore work without building contracts first, and
  contracts source is typechecked without Node types as a second guard. Its tests and build scripts run on
  Node and use `test/tsconfig.json`.
- Emit: `core` and `contracts` compile with `tsc` to `dist/`. `foundry-module` emits only via esbuild.

### Release

The module version is `packages/foundry-module/package.json#version`. A tag `foundry-v<version>` triggers
`.github/workflows/release-foundry.yml`, which fails if the tag and version differ, then builds, tests and
attaches `module.json` and `sargas-session-recap.zip` to that release. `manifest` and `download` URLs in
`module.json` point at the assets of the same release.

## Consequences

- T16 adds Foundry logic inside `packages/foundry-module/src` and may only share code with core through
  `contracts`.
- Anything both runtimes need (IDs, envelope shapes, validators) belongs in `contracts`, written without
  Node APIs.
- Adding a package requires updating the root `workspaces` list and this ADR.
