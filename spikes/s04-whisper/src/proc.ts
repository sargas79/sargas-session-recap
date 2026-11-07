/** Process + file helpers. Always argument arrays, never a shell. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

export interface ProcResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  wallMs: number;
  stdout: string;
  stderr: string;
  spawnError: string | null;
}

export function runProcess(bin: string, args: readonly string[], opts: { timeoutMs?: number; cwd?: string } = {}): Promise<ProcResult> {
  return new Promise((resolve) => {
    const started = performance.now();
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    const child = spawn(bin, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    });
    const timer =
      opts.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            child.kill();
          }, opts.timeoutMs)
        : null;
    const finish = (r: Omit<ProcResult, "wallMs" | "stdout" | "stderr" | "timedOut">): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        ...r,
        timedOut,
        wallMs: Math.round(performance.now() - started),
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    };
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e) => finish({ exitCode: null, signal: null, spawnError: e.message }));
    child.on("close", (code, signal) => finish({ exitCode: code, signal, spawnError: null }));
  });
}

/** True if `bin -version` (or given probe args) can be spawned and exits 0. */
export async function isAvailable(bin: string, probeArgs: readonly string[] = ["-version"]): Promise<boolean> {
  const r = await runProcess(bin, probeArgs, { timeoutMs: 15_000 });
  return r.spawnError === null && r.exitCode === 0;
}

export async function sha256File(file: string): Promise<{ sha256: string; bytes: number }> {
  const { size } = await stat(file);
  const h = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(file)
      .on("data", (d) => h.update(d))
      .on("end", () => resolve())
      .on("error", reject);
  });
  return { sha256: h.digest("hex"), bytes: size };
}
