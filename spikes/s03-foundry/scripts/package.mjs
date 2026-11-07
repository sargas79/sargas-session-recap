// Packages dist/module/ into a zip plus a standalone manifest for manual install via manifest URL.
//
// The URLs default to the GitHub release asset pattern for a tag the GM creates LATER by hand:
//   https://github.com/sargas79/sargas-session-recap/releases/download/<tag>/module.json
// This script creates no release and uploads nothing. Override with env vars:
//   S03_RELEASE_TAG (default s03-spike-v<version>), S03_REPO (default sargas79/sargas-session-recap)
import { zipSync, strToU8 } from "fflate";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const moduleDir = join(root, "dist", "module");

const manifest = JSON.parse(await readFile(join(moduleDir, "module.json"), "utf8"));
const repo = process.env.S03_REPO ?? "sargas79/sargas-session-recap";
const tag = process.env.S03_RELEASE_TAG ?? `s03-spike-v${manifest.version}`;
const zipName = `${manifest.id}.zip`;
const base = `https://github.com/${repo}/releases/download/${tag}`;
manifest.manifest = `${base}/module.json`;
manifest.download = `${base}/${zipName}`;
const manifestText = JSON.stringify(manifest, null, 2) + "\n";

async function walk(dir) {
  const files = [];
  for (const name of await readdir(dir)) {
    const full = join(dir, name);
    if ((await stat(full)).isDirectory()) files.push(...(await walk(full)));
    else files.push(full);
  }
  return files;
}

const entries = {};
for (const file of await walk(moduleDir)) {
  const rel = relative(moduleDir, file).split(sep).join("/");
  if (rel.endsWith(".map")) continue; // keep the zip small; maps stay in dist/ for local debugging
  // Zip root = module folder contents (module.json at the zip root), the layout Foundry's installer expects.
  entries[rel] = rel === "module.json" ? strToU8(manifestText) : new Uint8Array(await readFile(file));
}
// Fixed mtime so the zip is reproducible.
const zip = zipSync(entries, { level: 9, mtime: new Date("2026-01-01T00:00:00Z") });

await writeFile(join(root, "dist", zipName), zip);
await writeFile(join(root, "dist", "module.json"), manifestText);
console.log(`packaged dist/${zipName} (${zip.length} bytes) and dist/module.json`);
console.log(`manifest URL (valid only after the GM creates release ${tag} with both assets): ${manifest.manifest}`);
