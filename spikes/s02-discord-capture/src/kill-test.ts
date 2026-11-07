/**
 * Forced-kill case driver (THROWAWAY). Human step for the live run:
 *   npm run kill-test -- [path/to/s02.config.json]
 * Spawns the harness (inherits env, so S02_DISCORD_TOKEN passes through without being printed), waits
 * for Enter, then hard-kills it (SIGKILL; TerminateProcess on Windows), records the kill instant on the
 * same system-wide monotonic clock (process.hrtime.bigint), and runs recovery with that kill time to
 * report the per-fragment loss bound. The opted-in reader must be speaking continuously at the kill.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { recoverAll } from "./recovery.js";

const cfgPath = process.argv[2] ?? "s02.config.json";
const cfg = loadConfig(cfgPath);
const here = path.dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, ["--import", "tsx", path.join(here, "main.ts"), cfgPath], { stdio: ["ignore", "inherit", "inherit"] });

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
await rl.question("Harness running. Start the session with /spike start, have a reader talk continuously, then press Enter to hard-kill...\n");
rl.close();
const killHrNs = process.hrtime.bigint();
const killWall = new Date().toISOString();
child.kill("SIGKILL");
await new Promise((r) => child.once("exit", r));
const rec = { kill_hr_ns: killHrNs.toString(), kill_wall_iso: killWall, signal: "SIGKILL" };
fs.mkdirSync(cfg.output_root, { recursive: true });
fs.writeFileSync(path.join(cfg.output_root, `kill-record-${killWall.replace(/[-:.]/g, "")}.json`), JSON.stringify(rec, null, 2) + "\n");
const reports = recoverAll(cfg.output_root, { killHrNs });
console.log(JSON.stringify(reports.filter((r) => r.actions.length || r.abnormal_end), null, 2));
