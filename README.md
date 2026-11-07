# Sargas Session Recap

A local Windows tool that turns a recorded Pathfinder 2e session (Portuguese/English) into a GM-approved
recap: audio → local transcription → auditable classification → evidence-linked recap → GM review and
approval → GM-only Foundry VTT journal.

**Status:** bootstrap (T01). The CLI and module layout exist, but there's no pipeline behavior yet.

- Roadmap, scope and dependency order: [issue #1](https://github.com/sargas79/sargas-session-recap/issues/1)
- Execution plan and technical decisions: [`docs/implementation-plan.md`](docs/implementation-plan.md)
- Windows setup: [`docs/setup-windows.md`](docs/setup-windows.md)
- Rules for AI agents and PR conventions: [`AGENTS.md`](AGENTS.md)

## Layout

```
packages/
  core/        CLI (`recap`) and stage modules: capture, package, jobs, transcribe, classify, recap, review
  contracts/   canonical schemas, types and validators (T02)
```

## Quick start

```sh
npm ci
npm run build
npm run recap -- doctor
npm test
```

Requires Node.js 24 LTS.
