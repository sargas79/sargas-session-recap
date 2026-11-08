import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export const defaultSpawn: SpawnFn = (command, args, options) =>
  nodeSpawn(command, [...args], options);

export type KillTreeFn = (pid: number) => Promise<void>;

/**
 * Kills a process and all its descendants. Windows: `taskkill /PID <pid> /T /F`. POSIX: the child
 * was spawned `detached`, so it leads a process group and the group gets SIGKILL.
 */
export const killProcessTree: KillTreeFn = (pid) =>
  new Promise<void>((resolve) => {
    if (process.platform === 'win32') {
      const taskkill = nodeSpawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      taskkill.once('error', () => {
        resolve();
      });
      taskkill.once('close', () => {
        resolve();
      });
      return;
    }
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    resolve();
  });
