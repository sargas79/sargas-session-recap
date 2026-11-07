import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strFromU8, unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoUrl = 'https://github.com/sargas79/sargas-session-recap';

interface Manifest {
  id: string;
  version: string;
  manifest: string;
  download: string;
  esmodules: string[];
  compatibility: { minimum: string; verified: string };
}

function runScript(script: string, ...args: string[]): string {
  return execFileSync(process.execPath, [join(packageDir, 'scripts', script), ...args], {
    cwd: packageDir,
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
  version: string;
};

let outDir: string;

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), 'foundry-module-'));
  runScript('build.mjs', '--out-dir', outDir);
  runScript('package.mjs', '--out-dir', outDir);
});

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

describe('foundry-module build', () => {
  it('produces a browser ESM bundle without Node imports', () => {
    const bundlePath = join(outDir, 'scripts', 'module.js');
    expect(existsSync(bundlePath)).toBe(true);
    const bundle = readFileSync(bundlePath, 'utf8');

    expect(bundle).toContain('sargas-session-recap');
    expect(bundle).toContain('Hooks.once("init"');
    expect(bundle).not.toMatch(/["']node:/);
    // esbuild emits a `__require` shim only for a require() it could not resolve; text such as
    // Ajv's generated `require("ajv-formats/...")` string is not a module load.
    expect(bundle).not.toMatch(/\b__require\b/);
    expect(bundle).not.toMatch(
      /(?<![\w."'`$])require\s*\(\s*["'](?:node:)?(?:fs|path|os|child_process|crypto)\b/,
    );
    // Contracts are bundled in, not left as an external import.
    expect(bundle).not.toContain('@sargas-recap/contracts');
    expect(bundle).not.toMatch(/^\s*import\s/m);
  });
});

describe('foundry-module release package', () => {
  it('keeps version and URLs consistent across package.json, module.json and the zip', () => {
    const manifestText = readFileSync(join(outDir, 'module.json'), 'utf8');
    const manifest = JSON.parse(manifestText) as Manifest;
    const tag = `foundry-v${pkg.version}`;

    expect(manifest.id).toBe('sargas-session-recap');
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.compatibility).toEqual({ minimum: '14', verified: '14' });
    expect(manifest.manifest).toBe(`${repoUrl}/releases/download/${tag}/module.json`);
    expect(manifest.download).toBe(`${repoUrl}/releases/download/${tag}/sargas-session-recap.zip`);

    const zip = unzipSync(readFileSync(join(outDir, 'sargas-session-recap.zip')));
    expect(Object.keys(zip).sort()).toEqual(['module.json', 'scripts/module.js']);

    const zippedManifestBytes = zip['module.json'];
    expect(zippedManifestBytes).toBeDefined();
    if (zippedManifestBytes === undefined) return;
    expect(strFromU8(zippedManifestBytes)).toBe(manifestText);

    for (const esmodule of manifest.esmodules) {
      expect(zip[esmodule], `zip contains ${esmodule}`).toBeDefined();
    }
  });

  it('refuses a release tag that does not match package.json', () => {
    expect(() =>
      runScript('package.mjs', '--out-dir', outDir, '--expect-tag', 'foundry-v999.0.0'),
    ).toThrow(/does not match package\.json version/);
    expect(
      runScript('package.mjs', '--out-dir', outDir, '--expect-tag', `foundry-v${pkg.version}`),
    ).toContain('packaged');
  });

  it('is byte-identical when packaged twice', () => {
    const zipPath = join(outDir, 'sargas-session-recap.zip');
    const first = readFileSync(zipPath);
    runScript('package.mjs', '--out-dir', outDir);
    expect(readFileSync(zipPath).equals(first)).toBe(true);
  });
});
