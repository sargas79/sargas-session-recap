import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { hardKill, watchExit } from "../src/hard-kill.js";

describe("kill-test driver: hard kill without an exit race (offline)", () => {
  it("rejects a child that already exited while the driver was waiting, instead of hanging", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(3)"], { stdio: "ignore" });
    const watch = watchExit(child);
    await watch.exited; // exits before "Enter"
    await expect(hardKill(child, watch)).rejects.toThrow(/already exited.*code 3/);
  });

  it("kills a running child and resolves with the kill instant and exit info", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const watch = watchExit(child);
    await new Promise((r) => setTimeout(r, 100));
    const before = process.hrtime.bigint();
    const { killHrNs, exit } = await hardKill(child, watch);
    expect(killHrNs >= before).toBe(true);
    expect(exit.signal === "SIGKILL" || exit.code !== null).toBe(true);
  });
});
