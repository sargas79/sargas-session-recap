// Enforces the dependency direction from ADR-008:
// - packages/contracts/src must not import Node built-ins (it is bundled into the browser module);
// - packages/foundry-module must never depend on packages/core.
import { readFileSync, readdirSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const packagesDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const contractsSrc = join(packagesDir, 'contracts', 'src');
const coreDir = join(packagesDir, 'core');
const foundryDir = join(packagesDir, 'foundry-module');

const SOURCE_EXT = /\.(?:[cm]?[jt]s|tsx|jsx)$/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && SOURCE_EXT.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter(
      (file) => !file.split(sep).includes('node_modules') && !file.split(sep).includes('dist'),
    );
}

/** Every module specifier: static/type imports, re-exports, dynamic import() and require(). */
function importSpecifiers(source: string): string[] {
  const info = ts.preProcessFile(source, true, true);
  return info.importedFiles.map((ref) => ref.fileName);
}

function isNodeBuiltin(specifier: string): boolean {
  return specifier.startsWith('node:') || isBuiltin(specifier);
}

function importsCore(file: string, specifier: string): boolean {
  if (specifier === '@sargas-recap/core' || specifier.startsWith('@sargas-recap/core/'))
    return true;
  if (!specifier.startsWith('.')) return false;
  const target = relative(coreDir, resolve(dirname(file), specifier));
  return !target.startsWith('..');
}

function violations(files: string[], rule: (file: string, specifier: string) => boolean): string[] {
  return files.flatMap((file) =>
    importSpecifiers(readFileSync(file, 'utf8'))
      .filter((specifier) => rule(file, specifier))
      .map((specifier) => `${relative(packagesDir, file)} imports ${specifier}`),
  );
}

describe('dependency direction (ADR-008)', () => {
  it('detects the forbidden patterns it is meant to catch', () => {
    const sample = [
      "import { readFileSync } from 'node:fs';",
      "import path from 'path';",
      "import type { Stats } from 'fs/promises';",
      "export * from 'crypto';",
      "const m = await import('node:os');",
      "import { x } from '@sargas-recap/core';",
    ].join('\n');
    const specs = importSpecifiers(sample);
    expect(specs.filter(isNodeBuiltin)).toEqual([
      'node:fs',
      'path',
      'fs/promises',
      'crypto',
      'node:os',
    ]);
    expect(importsCore(join(foundryDir, 'src', 'a.ts'), '@sargas-recap/core')).toBe(true);
    expect(importsCore(join(foundryDir, 'src', 'a.ts'), '../../core/src/index.ts')).toBe(true);
    expect(importsCore(join(foundryDir, 'src', 'a.ts'), '@sargas-recap/contracts')).toBe(false);
  });

  it('contracts/src imports no Node built-ins', () => {
    const files = sourceFiles(contractsSrc);
    expect(files.length).toBeGreaterThan(0);
    expect(violations(files, (_file, specifier) => isNodeBuiltin(specifier))).toEqual([]);
  });

  it('foundry-module source and scripts never import core', () => {
    const files = [
      ...sourceFiles(join(foundryDir, 'src')),
      ...sourceFiles(join(foundryDir, 'scripts')),
    ];
    expect(files.length).toBeGreaterThan(0);
    expect(violations(files, importsCore)).toEqual([]);
  });

  it('foundry-module/src imports no Node built-ins', () => {
    const files = sourceFiles(join(foundryDir, 'src'));
    expect(violations(files, (_file, specifier) => isNodeBuiltin(specifier))).toEqual([]);
  });

  it('foundry-module package.json does not depend on core', () => {
    const pkg = JSON.parse(readFileSync(join(foundryDir, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    const deps = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
      .map((key) => pkg[key])
      .filter(
        (value): value is Record<string, string> => typeof value === 'object' && value !== null,
      )
      .flatMap((value) => Object.keys(value));
    expect(deps).not.toContain('@sargas-recap/core');
    expect(deps).toContain('@sargas-recap/contracts');
  });
});
