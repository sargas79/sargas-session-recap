/**
 * Forced-kill case driver (THROWAWAY). Human step for the live run:
 *   npm run kill-test -- [path/to/s02.config.json]
 * Spawns the harness (inherits env, so S02_DISCORD_TOKEN passes through without being printed), waits
 * for Enter, then hard-kills it (SIGKILL; TerminateProcess on Windows), records the kill instant on the
 * same system-wide monotonic clock (process.hrtime.bigint), and runs recovery with that kill time to
 * report the per-fragment loss bound. The opted-in reader must be speaking continuously at the kill.
 * If the harness exits on its own before Enter (e.g. login failure), no kill time is recorded; recovery
 * still runs without one and the driver exits non-zero.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { hardKill, watchExit } from "./hard-kill.js";
import { recoverAll } from "./recovery.js";

const cfgPath = process.argv[2] ?? "s02.config.json";
const cfg = loadConfig(cfgPath);
const here = path.dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, ["--import", "tsx", path.join(here, "main.ts"), cfgPath], { stdio: ["ignore", "inherit", "inherit"] });
// Registered immediately, so an early exit while we wait for Enter is not missed.
const watch = watchExit(child);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
await rl.question("Harness running. Start the session with /spike start, have a reader talk continuously, then press Enter to hard-kill...\n");
rl.close();

let killHrNs: bigint | undefined;
try {
  const killWall = new Date().toISOString();
  const res = await hardKill(child, watch);
  killHrNs = res.killHrNs;
  const rec = { kill_hr_ns: killHrNs.toString(), kill_wall_iso: killWall, signal: "SIGKILL", exit: res.exit };
  fs.mkdirSync(cfg.output_root, { recursive: true });
  fs.writeFileSync(path.join(cfg.output_root, `kill-record-${killWall.replace(/[-:.]/g, "")}.json`), JSON.stringify(rec, null, 2) + "\n");
} catch (e) {
  console.error(`kill-test: ${(e as Error).message}`);
  process.exitCode = 1;
}
const reports = recoverAll(cfg.output_root, killHrNs === undefined ? {} : { killHrNs });
console.log(JSON.stringify(reports.filter((r) => r.actions.length || r.abnormal_end), null, 2));
