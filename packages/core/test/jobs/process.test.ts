/**
 * Multi-process behaviour of `recap run`: a crash mid-stage (the child is killed) followed by
 * recovery, and two processes racing for the same session lock.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const WORKER = fileURLToPath(new URL('./worker.ts', import.meta.url));

interface Result {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface Running {
  readonly pid: number;
  readonly done: Promise<Result>;
  kill(): void;
}

let workdir: string;
let dataRoot: string;

beforeEach(() => {
  workdir = mkdtempSync(path.join(os.tmpdir(), 'recap-jobs-proc-'));
  dataRoot = path.join(workdir, 'data');
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function start(mode: 'ok' | 'hang' | 'gate', args: readonly string[]): Running {
  const child = spawn(process.execPath, [WORKER, workdir, ...args], {
    env: { ...process.env, WORKER_MODE: mode },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
  child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
  const done = new Promise<Result>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
  if (child.pid === undefined) throw new Error('worker did not start');
  return {
    pid: child.pid,
    done,
    kill: () => {
      child.kill('SIGKILL');
    },
  };
}

const session = ['--campaign', 'synthetic-vaults', '--session', 's01', '--data-root'];
const runArgs = (stage: string): string[] => ['run', stage, ...session, dataRoot];
const statusArgs = (): string[] => ['status', ...session, dataRoot];

async function waitFor(file: string, child: Running, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let exited: Result | undefined;
  void child.done.then((r) => (exited = r));
  while (!existsSync(file)) {
    if (exited !== undefined) {
      throw new Error(`worker exited early (${String(exited.code)}): ${exited.stderr}`);
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function calls(): string[] {
  const file = path.join(workdir, 'calls.log');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : [];
}

function jobRows(): { stage: string; status: string; error_code: string | null }[] {
  const db = new Database(path.join(dataRoot, 'state', 'recap.sqlite'), { readonly: true });
  try {
    return db
      .prepare('SELECT stage, status, error_code FROM jobs ORDER BY created_at, job_id')
      .all() as { stage: string; status: string; error_code: string | null }[];
  } finally {
    db.close();
  }
}

describe('recap run across processes', () => {
  it('recovers after the process is killed mid-stage, without redoing completed stages', async () => {
    const crashing = start('hang', runArgs('classify'));
    await waitFor(path.join(workdir, 'started'), crashing);
    crashing.kill();
    const killed = await crashing.done;
    expect(killed.code).not.toBe(0);

    // The killed run left its job running and its lock behind.
    expect(jobRows()).toEqual([
      { stage: 'import', status: 'succeeded', error_code: null },
      { stage: 'transcribe', status: 'running', error_code: null },
    ]);
    const lockFile = path.join(dataRoot, 'state', 'locks', 'synthetic-vaults', 's01.lock');
    expect(existsSync(lockFile)).toBe(true);

    const status = await start('ok', statusArgs()).done;
    expect(status.code).toBe(0);
    expect(status.stdout).toContain(`left by pid ${String(crashing.pid)} (owner-dead)`);
    expect(status.stdout).toContain('owner process is gone');

    const recovered = await start('ok', runArgs('classify')).done;
    expect(recovered.stderr).toBe('');
    expect(recovered.code).toBe(0);
    expect(recovered.stdout).toContain(
      `took over the session lock from pid ${String(crashing.pid)}`,
    );
    expect(recovered.stdout).toMatch(/recovered: transcribe job \w{26} was interrupted/);
    expect(recovered.stdout).toMatch(/import: up to date/);
    expect(recovered.stdout).toMatch(/transcribe: succeeded .*re-ran an interrupted job/);
    expect(recovered.stdout).toMatch(/classify: succeeded/);
    expect(recovered.stdout).toContain('result: succeeded');

    expect(calls()).toEqual(['import', 'transcribe', 'transcribe', 'classify']);
    expect(jobRows()).toEqual([
      { stage: 'import', status: 'succeeded', error_code: null },
      { stage: 'transcribe', status: 'failed', error_code: 'interrupted' },
      { stage: 'transcribe', status: 'succeeded', error_code: null },
      { stage: 'classify', status: 'succeeded', error_code: null },
    ]);
    expect(existsSync(lockFile)).toBe(false);
  });

  it('refuses a second process on the same session with an actionable error', async () => {
    const first = start('gate', runArgs('transcribe'));
    await waitFor(path.join(workdir, 'started'), first);

    const second = await start('ok', runArgs('classify')).done;
    expect(second.code).toBe(1);
    expect(second.stderr).toContain(
      `session synthetic-vaults/s01 is already being processed by pid ${String(first.pid)}`,
    );
    expect(second.stderr).toContain('fix: wait for that run to finish');

    writeFileSync(path.join(workdir, 'release'), '');
    const done = await first.done;
    expect(done.stderr).toBe('');
    expect(done.code).toBe(0);
    // The refused run created no jobs and ran no stage.
    expect(calls()).toEqual(['import', 'transcribe']);
    expect(jobRows().map((r) => r.stage)).toEqual(['import', 'transcribe']);
  });
});
