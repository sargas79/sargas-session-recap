// Bundles the review screen's small browser client (T14) into dist/review-ui/. `platform: browser`
// makes esbuild refuse Node built-ins, so a stray `node:` import fails the build.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

await build({
  entryPoints: [fileURLToPath(new URL('../src/review-ui/client/main.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('../dist/review-ui/client.bundle.js', import.meta.url)),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
});
