import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readManifest } from "../src/manifest.js";
import { recoverAll } from "../src/recovery.js";
import { tmpDir } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.join(here, "..");

/**
 * OFFLINE SYNTHETIC check only. A real child process is hard-killed (SIGKILL; TerminateProcess on
 * Windows) while writing; startup recovery must find the interrupted .part and bound the loss. This is
 * NOT the live S02 forced-kill result, which needs the Discord pipeline (decode, network) in the loop.
 */
describe("forced kill of a real writer process (offline, synthetic packets)", () => {
  it("leaves a detectable .part that recovery salvages with a bounded loss", async () => {
    const root = tmpDir();
    const child = spawn(process.execPath, ["--import", "tsx", path.join(here, "fixtures", "writer-child.ts"), root], {
      cwd: pkgDir,
      stdio: ["ignore", "pipe", "inherit"],
    });
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (d: Buffer) => d.toString().includes("READY") && resolve());
      child.once("exit", (c) => reject(new Error(`child exited early: ${c}`)));
    });
    await new Promise((r) => setTimeout(r, 330));
    const killHrNs = process.hrtime.bigint();
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));

    const dir = path.join(root, "s02-killtest");
    const parts = fs.readdirSync(dir).filter((f) => f.endsWith(".part"));
    expect(parts.length).toBe(1);
    const [rep] = recoverAll(root, { killHrNs });
    expect(rep!.abnormal_end).toBe(true);
    const salvaged = rep!.interrupted.filter((i) => i.status === "salvaged");
    expect(salvaged).toHaveLength(1);
    expect(salvaged[0]!.samples).toBeGreaterThan(0);
    // Loss for a speaker talking through the kill = kill offset - salvaged end. With synchronous writes a
    // process kill should lose only the in-flight 20 ms frame plus timer jitter; the generous ceiling keeps
    // slow CI green. The measured number is printed for the record.
    console.log(`[offline synthetic] loss_ms_if_speaking_at_kill = ${rep!.max_loss_ms}`);
    expect(rep!.max_loss_ms).not.toBeNull();
    expect(rep!.max_loss_ms!).toBeLessThan(500);
    const closes = readManifest(path.join(dir, "manifest.jsonl")).records.filter((r) => r.type === "fragment_close");
    expect(closes.length).toBeGreaterThanOrEqual(1); // at least one rotated fragment finalized before the kill
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".part"))).toEqual([]);
  });
});
