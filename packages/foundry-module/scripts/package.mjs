// Zips a built module (module.json + scripts/*.js at the zip root) into
// <out-dir>/sargas-session-recap.zip. Run scripts/build.mjs first.
// Usage: node scripts/package.mjs [--out-dir <dir>] [--expect-tag foundry-v<version>]
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { ZIP_NAME, createManifest, parseCliArgs, packageVersion, releaseTag } from './manifest.mjs';

const { outDir, expectTag } = parseCliArgs();
const version = packageVersion();

if (expectTag !== undefined && expectTag !== releaseTag(version)) {
  throw new Error(
    `tag ${expectTag} does not match package.json version ${version} (expected ${releaseTag(version)})`,
  );
}

const manifestPath = resolve(outDir, 'module.json');
if (!existsSync(manifestPath)) {
  throw new Error(`${manifestPath} is missing: run the build first`);
}
const manifestText = readFileSync(manifestPath, 'utf8');
const expected = `${JSON.stringify(createManifest(version), null, 2)}\n`;
if (manifestText !== expected) {
  throw new Error(`${manifestPath} is stale or edited: rebuild it`);
}

const scriptsDir = resolve(outDir, 'scripts');
const scripts = readdirSync(scriptsDir)
  .filter((name) => name.endsWith('.js'))
  .sort();
if (scripts.length === 0) {
  throw new Error(`no scripts/*.js in ${outDir}`);
}

// Fixed timestamp keeps the zip byte-identical across rebuilds of the same sources.
const mtime = new Date('2000-01-01T00:00:00Z');
/** @type {Record<string, [Uint8Array, { mtime: Date }]>} */
const entries = { 'module.json': [strToU8(manifestText), { mtime }] };
for (const name of scripts) {
  entries[`scripts/${name}`] = [readFileSync(resolve(scriptsDir, name)), { mtime }];
}

const zipPath = resolve(outDir, ZIP_NAME);
writeFileSync(zipPath, zipSync(entries, { level: 9 }));

process.stdout.write(
  `packaged ${releaseTag(version)} -> ${zipPath} (${Object.keys(entries).join(', ')})\n`,
);
