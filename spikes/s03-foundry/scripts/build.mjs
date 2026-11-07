// Builds the throwaway module into dist/module/ (module.json + scripts/main.js).
import { build } from "esbuild";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist", "module");

await rm(join(root, "dist"), { recursive: true, force: true });
await mkdir(join(out, "scripts"), { recursive: true });

await build({
  entryPoints: [join(root, "src", "main.ts")],
  outfile: join(out, "scripts", "main.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  sourcemap: true,
  legalComments: "none",
  logLevel: "info",
});

const manifest = JSON.parse(await readFile(join(root, "module.json"), "utf8"));
await writeFile(join(out, "module.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`built ${manifest.id}@${manifest.version} -> dist/module/`);
