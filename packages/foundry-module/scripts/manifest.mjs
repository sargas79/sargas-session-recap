// Shared helpers for building and packaging the Foundry module.
// The version comes from package.json; manifest and download URLs point at the
// GitHub release for tag `foundry-v<version>`.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_URL = 'https://github.com/sargas79/sargas-session-recap';
export const MODULE_ID = 'sargas-session-recap';
export const ZIP_NAME = `${MODULE_ID}.zip`;
export const TAG_PREFIX = 'foundry-v';

/** @param {string} file */
function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** @returns {string} */
export function packageVersion() {
  const pkg = readJson(resolve(PACKAGE_DIR, 'package.json'));
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new Error('packages/foundry-module/package.json has no version');
  }
  return pkg.version;
}

/** @param {string} version */
export function releaseTag(version) {
  return `${TAG_PREFIX}${version}`;
}

/** @param {string} version */
export function releaseUrls(version) {
  const base = `${REPO_URL}/releases/download/${releaseTag(version)}`;
  return { manifest: `${base}/module.json`, download: `${base}/${ZIP_NAME}` };
}

/**
 * Builds module.json from module.template.json plus the package version and release URLs.
 * @param {string} version
 */
export function createManifest(version) {
  const template = readJson(resolve(PACKAGE_DIR, 'module.template.json'));
  if (template.id !== MODULE_ID) {
    throw new Error(`module.template.json id must be ${MODULE_ID}`);
  }
  return { ...template, version, ...releaseUrls(version) };
}

/** Resolves `--out-dir` (default: dist) relative to the current working directory. */
export function parseCliArgs() {
  const { values } = parseArgs({
    options: { 'out-dir': { type: 'string' }, 'expect-tag': { type: 'string' } },
    allowPositionals: false,
  });
  return {
    outDir: resolve(values['out-dir'] ?? resolve(PACKAGE_DIR, 'dist')),
    expectTag: values['expect-tag'],
  };
}
