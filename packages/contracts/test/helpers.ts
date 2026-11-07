import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_DIR = fileURLToPath(new URL('../', import.meta.url));
export const REPO_ROOT = join(PACKAGE_DIR, '..', '..');
export const SCHEMAS_DIR = join(PACKAGE_DIR, 'schemas');
export const SRC_DIR = join(PACKAGE_DIR, 'src');
export const FIXTURES_DIR = join(REPO_ROOT, 'fixtures', 'contracts');

/** Read a text file with line endings normalized, so a CRLF checkout cannot fail comparisons. */
export function readText(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

export function readJson(path: string): unknown {
  return JSON.parse(readText(path)) as unknown;
}

export function listFiles(dir: string, predicate: (name: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((d) => d.isFile() && predicate(d.name))
    .map((d) => join(d.parentPath, d.name))
    .sort();
}
