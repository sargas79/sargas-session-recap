/**
 * Race-free hard kill of a child process (THROWAWAY spike), used by kill-test.ts.
 *
 * `watchExit` must be called right after spawn, so an exit that happens while the driver waits for the
 * human (e.g. a token/login failure) is still observed. `hardKill` then refuses an already-exited child
 * (there is nothing to kill and no meaningful kill time) and fails if the signal could not be sent,
 * instead of waiting forever for an `exit` event that already fired.
 */
import type { ChildProcess } from "node:child_process";

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface ExitWatch {
  readonly exited: Promise<ExitInfo>;
  /** Set as soon as the child exits. */
  info(): ExitInfo | null;
}

export function watchExit(child: ChildProcess): ExitWatch {
  let info: ExitInfo | null = child.exitCode !== null || child.signalCode !== null ? { code: child.exitCode, signal: child.signalCode } : null;
  const exited = info
    ? Promise.resolve(info)
    : new Promise<ExitInfo>((resolve) => {
        child.once("exit", (code, signal) => {
          info = { code, signal };
          resolve(info);
        });
      });
  return { exited, info: () => info };
}

/** Records the kill instant on the monotonic clock, sends SIGKILL, and waits for the exit. */
export async function hardKill(child: ChildProcess, watch: ExitWatch): Promise<{ killHrNs: bigint; exit: ExitInfo }> {
  const already = watch.info();
  if (already) {
    throw new Error(`child already exited before the kill (code ${already.code}, signal ${already.signal}); no kill measurement taken`);
  }
  const killHrNs = process.hrtime.bigint();
  if (!child.kill("SIGKILL")) {
    const late = watch.info();
    throw new Error(late ? `child exited before the kill signal was delivered (code ${late.code})` : "failed to send SIGKILL to the child");
  }
  const exit = await watch.exited;
  return { killHrNs, exit };
}
