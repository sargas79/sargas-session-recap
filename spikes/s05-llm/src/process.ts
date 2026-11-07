/**
 * Process helpers: spawn abstraction (injectable for tests) and process-tree
 * kill that works on Windows (taskkill /T /F) and POSIX (process group).
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export const defaultSpawn: SpawnFn = (command, args, options) => nodeSpawn(command, [...args], options);

export type KillTreeFn = (pid: number) => Promise<void>;

/**
 * Kill a process and all of its descendants.
 *  - Windows: `taskkill /PID <pid> /T /F` (argument array, no shell).
 *  - POSIX: the child is spawned with `detached: true`, so it leads its own
 *    process group; signal the whole group with SIGKILL.
 */
export const killProcessTree: KillTreeFn = (pid) =>
  new Promise<void>((resolve) => {
    if (process.platform === "win32") {
      const tk = nodeSpawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      tk.once("error", () => resolve());
      tk.once("close", () => resolve());
      return;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    resolve();
  });

/** True if a process with this pid currently exists (best effort). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
