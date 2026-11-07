// Writes packages/contracts/schemas/<name>.schema.json from the TypeBox sources.
// Usage: npm run schemas -w @sargas-recap/contracts
// test/schemas-up-to-date.test.ts fails if the committed files differ from this output.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACT_NAMES, serializeJsonSchema } from '../src/registry.ts';

const outDir = fileURLToPath(new URL('../schemas/', import.meta.url));
mkdirSync(outDir, { recursive: true });

const expected = new Set(CONTRACT_NAMES.map((name) => `${name}.schema.json`));
for (const file of readdirSync(outDir)) {
  if (file.endsWith('.schema.json') && !expected.has(file)) rmSync(join(outDir, file));
}
for (const name of CONTRACT_NAMES) {
  writeFileSync(join(outDir, `${name}.schema.json`), serializeJsonSchema(name), 'utf8');
}
process.stdout.write(`wrote ${String(expected.size)} schemas to ${outDir}\n`);
