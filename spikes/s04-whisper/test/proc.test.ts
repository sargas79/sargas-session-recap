import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runProcess, sha256File } from "../src/proc.ts";
import { makeSilentWav, readWavInfo } from "../src/wav.ts";

const tmp = mkdtempSync(path.join(os.tmpdir(), "s04-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("runProcess", () => {
  it("passes arguments verbatim without a shell and captures output", async () => {
    const tricky = "a b & echo pwned; $(x) 'q' \"dq\" ação";
    const r = await runProcess(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1))); process.stderr.write('err')", tricky]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([tricky]);
    expect(r.stderr).toBe("err");
    expect(r.wallMs).toBeGreaterThanOrEqual(0);
  });

  it("reports spawn errors and timeouts", async () => {
    const missing = await runProcess(path.join(tmp, "does-not-exist.exe"), []);
    expect(missing.spawnError).not.toBeNull();
    const slow = await runProcess(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 200 });
    expect(slow.timedOut).toBe(true);
  });
});

describe("file helpers", () => {
  it("hashes files and reads WAV durations from disk", async () => {
    const wav = path.join(tmp, "silence.wav");
    writeFileSync(wav, makeSilentWav(1234));
    expect((await readWavInfo(wav)).durationMs).toBe(1234);
    const txt = path.join(tmp, "abc.txt");
    writeFileSync(txt, "abc");
    expect(await sha256File(txt)).toEqual({
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      bytes: 3,
    });
  });
});
