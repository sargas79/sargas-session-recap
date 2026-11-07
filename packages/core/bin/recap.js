#!/usr/bin/env node
// Committed shim so npm can link the `recap` bin at install time, before the
// TypeScript build has produced dist/. Run `npm run build` first.
import { existsSync } from 'node:fs';

const entry = new URL('../dist/cli/main.js', import.meta.url);

if (!existsSync(entry)) {
  process.stderr.write('recap: build output not found. Run `npm run build` from the repo root.\n');
  process.exit(1);
}

await import(entry.href);
