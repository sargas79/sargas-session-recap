// Copies the SQL migrations next to the compiled db module (tsc only emits .ts
// output). Replaces the target directory so a removed source file cannot linger.
import { cpSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const from = fileURLToPath(new URL('../src/db/migrations/', import.meta.url));
const to = fileURLToPath(new URL('../dist/db/migrations/', import.meta.url));

rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true, filter: (src) => !src.endsWith('.ts') });
