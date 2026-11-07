// Bundles src/module.ts into a browser ESM file and writes module.json.
// Usage: node scripts/build.mjs [--out-dir <dir>]   (default: packages/foundry-module/dist)
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { PACKAGE_DIR, createManifest, parseCliArgs, packageVersion } from './manifest.mjs';

const { outDir } = parseCliArgs();

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  absWorkingDir: PACKAGE_DIR,
  entryPoints: [resolve(PACKAGE_DIR, 'src/module.ts')],
  outfile: resolve(outDir, 'scripts/module.js'),
  tsconfig: resolve(PACKAGE_DIR, 'tsconfig.json'),
  bundle: true,
  format: 'esm',
  // `browser` makes esbuild refuse Node built-ins, so a stray `node:` import fails the build.
  platform: 'browser',
  target: 'es2022',
  legalComments: 'none',
  logLevel: 'warning',
});

const manifest = createManifest(packageVersion());
writeFileSync(resolve(outDir, 'module.json'), `${JSON.stringify(manifest, null, 2)}\n`);

process.stdout.write(`built ${manifest.id} ${manifest.version} -> ${outDir}\n`);
