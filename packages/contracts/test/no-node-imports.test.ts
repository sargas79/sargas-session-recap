import { builtinModules } from 'node:module';
import { relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PACKAGE_DIR, SRC_DIR, listFiles, readJson, readText } from './helpers.ts';

// packages/contracts is bundled into the Foundry browser module (#44): no Node built-ins, no Node
// globals. tsconfig.build.json also compiles src/ without @types/node.

const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bexport\s+\*\s+from\s*)['"]([^'"]+)['"]/g;
const NODE_GLOBALS = /\b(?:process|Buffer|__dirname|__filename|require|global)\s*[.([]/;

const pkg = readJson(`${PACKAGE_DIR}/package.json`) as { dependencies?: Record<string, string> };
const DEPENDENCIES = Object.keys(pkg.dependencies ?? {});

function packageOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

const files = listFiles(SRC_DIR, (n) => n.endsWith('.ts'));

describe('contracts are browser-safe', () => {
  it('finds source files to check', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files.map((f) => [relative(SRC_DIR, f), f] as const))(
    '%s imports no Node built-ins and only declared dependencies',
    (_label, file) => {
      const text = readText(file);
      const specifiers = [...text.matchAll(SPECIFIER)].map((m) => m[1] ?? '');
      for (const spec of specifiers) {
        expect(BUILTINS.has(spec) || spec.startsWith('node:'), `built-in import ${spec}`).toBe(
          false,
        );
        if (!spec.startsWith('.')) {
          expect(DEPENDENCIES, `undeclared dependency ${spec}`).toContain(packageOf(spec));
        }
      }
      expect(NODE_GLOBALS.test(text), 'uses a Node global').toBe(false);
    },
  );

  it('detects a Node import (self-test)', () => {
    const sample = "import { readFileSync } from 'node:fs';\nimport path from 'path';";
    const found = [...sample.matchAll(SPECIFIER)].map((m) => m[1]);
    expect(found).toEqual(['node:fs', 'path']);
    expect(found.every((s) => s !== undefined && BUILTINS.has(s))).toBe(true);
  });
});
