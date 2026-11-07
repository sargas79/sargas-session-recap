import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SPIKE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function isUnder(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Outputs contain transcripts of real audio. Refuse output directories inside
 * a git checkout, except the git-ignored `spikes/s04-whisper/results/`.
 */
export function assertSafeOutDir(outDir: string): void {
  const abs = path.resolve(outDir);
  if (isUnder(abs, path.join(SPIKE_DIR, "results"))) return;
  let dir = abs;
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) {
      throw new Error(
        `refusing outDir inside a git checkout (${dir}). Use a folder outside the repo, or ${path.join(SPIKE_DIR, "results")} (git-ignored).`,
      );
    }
    const up = path.dirname(dir);
    if (up === dir) return;
    dir = up;
  }
}

export function die(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(2);
}

export function toInt(v: string | undefined, name: string, def: number): number {
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n)) die(`--${name} must be an integer`);
  return n;
}
