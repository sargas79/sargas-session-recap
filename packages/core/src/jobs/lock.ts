/**
 * Per-session lock (T07). Authoritative state is the `session_locks` row, taken under
 * `BEGIN IMMEDIATE` so two processes cannot both win. The lock file under
 * `<root>/state/locks/<campaign>/<session>.lock` mirrors the row for operators (who holds the
 * session, since when) and is removed on release; a leftover file is never trusted on its own.
 *
 * A held lock is respected only while its owner looks alive: same host and pid still running, and
 * a heartbeat newer than `staleMs`. A dead owner (crash, kill) or a silent one (hung, or a reused
 * pid) is replaced, and the next run then recovers the jobs it left behind.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SqliteDatabase } from '../db/index.ts';
import { JobError } from './errors.ts';
import { heartbeatJobs } from './store.ts';

/** How often a running process refreshes its heartbeat. */
export const DEFAULT_HEARTBEAT_MS = 2_000;
/** A heartbeat older than this means the owner is gone, even if its pid is in use. */
export const DEFAULT_STALE_MS = 30_000;

export interface LockOptions {
  readonly heartbeatMs?: number | undefined;
  readonly staleMs?: number | undefined;
  /** Mirror file; usually `paths.sessionLockFile(campaign, session)`. */
  readonly lockFile?: string | undefined;
  /** Test seams. */
  readonly pid?: number | undefined;
  readonly host?: string | undefined;
  readonly nowMs?: (() => number) | undefined;
  readonly isAlive?: ((pid: number) => boolean) | undefined;
}

export interface LockHolder {
  readonly campaignId: string;
  readonly sessionId: string;
  readonly ownerPid: number;
  readonly ownerHost: string;
  readonly ownerToken: string;
  readonly acquiredAt: string;
  /** Unix ms. */
  readonly heartbeatAt: number;
}

export interface LockLiveness {
  readonly alive: boolean;
  readonly reason: 'live' | 'owner-dead' | 'heartbeat-stale';
}

export interface SessionLock {
  readonly token: string;
  readonly pid: number;
  /** The lock this one replaced because its owner was dead or stale, if any. */
  readonly replaced: LockHolder | undefined;
  /** Refreshes the lock and the owned running jobs. False when the lock was lost. */
  heartbeat(): boolean;
  /** Starts the heartbeat timer; `onLost` runs once if the lock row is gone or taken. */
  startHeartbeat(onLost: () => void): void;
  /** Stops the heartbeat and deletes the row and file if they are still ours. Idempotent. */
  release(): void;
}

interface LockRow {
  campaign_id: string;
  session_id: string;
  owner_pid: number;
  owner_host: string;
  owner_token: string;
  acquired_at: string;
  heartbeat_at: number;
}

/** True when a process with this pid exists (EPERM means it exists but belongs to someone else). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function toHolder(row: LockRow): LockHolder {
  return {
    campaignId: row.campaign_id,
    sessionId: row.session_id,
    ownerPid: row.owner_pid,
    ownerHost: row.owner_host,
    ownerToken: row.owner_token,
    acquiredAt: row.acquired_at,
    heartbeatAt: row.heartbeat_at,
  };
}

export function readSessionLock(
  db: SqliteDatabase,
  campaignId: string,
  sessionId: string,
): LockHolder | undefined {
  const row = db
    .prepare('SELECT * FROM session_locks WHERE campaign_id = ? AND session_id = ?')
    .get(campaignId, sessionId) as LockRow | undefined;
  return row === undefined ? undefined : toHolder(row);
}

/** Whether a lock holder still counts as running (see the module comment). */
export function lockLiveness(
  holder: Pick<LockHolder, 'ownerPid' | 'ownerHost' | 'heartbeatAt'>,
  options: Pick<LockOptions, 'staleMs' | 'host' | 'nowMs' | 'isAlive'> = {},
): LockLiveness {
  const host = options.host ?? os.hostname();
  const nowMs = (options.nowMs ?? Date.now)();
  const isAlive = options.isAlive ?? pidAlive;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  // A pid is only meaningful on its own host; elsewhere only the heartbeat counts.
  if (holder.ownerHost === host && !isAlive(holder.ownerPid)) {
    return { alive: false, reason: 'owner-dead' };
  }
  if (nowMs - holder.heartbeatAt > staleMs) return { alive: false, reason: 'heartbeat-stale' };
  return { alive: true, reason: 'live' };
}

function writeLockFile(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temp, content, { flag: 'wx' });
  try {
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function removeLockFileIfOurs(file: string, token: string): void {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { token?: unknown };
    if (parsed.token === token) rmSync(file, { force: true });
  } catch {
    // Missing or unreadable: nothing of ours to remove.
  }
}

/**
 * Takes the session lock or throws `JOB_SESSION_LOCKED` with the holder and what to do.
 * Never waits: a second `recap run` on the same session is refused at once.
 */
export function acquireSessionLock(
  db: SqliteDatabase,
  campaignId: string,
  sessionId: string,
  options: LockOptions = {},
): SessionLock {
  const pid = options.pid ?? process.pid;
  const host = options.host ?? os.hostname();
  const nowMs = options.nowMs ?? Date.now;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const token = randomBytes(16).toString('hex');

  const take = db.transaction((): LockHolder | undefined => {
    const current = readSessionLock(db, campaignId, sessionId);
    if (current !== undefined) {
      const liveness = lockLiveness(current, { ...options, host, nowMs, staleMs });
      if (liveness.alive) {
        throw new JobError(
          'JOB_SESSION_LOCKED',
          `session ${campaignId}/${sessionId} is already being processed by pid ${current.ownerPid} on ${current.ownerHost} (since ${current.acquiredAt})`,
          {
            hint:
              'wait for that run to finish, or stop it with Ctrl+C in its window; ' +
              `if it was killed, the lock is released automatically ${Math.round(staleMs / 1000)}s after its last heartbeat`,
          },
        );
      }
      db.prepare('DELETE FROM session_locks WHERE campaign_id = ? AND session_id = ?').run(
        campaignId,
        sessionId,
      );
    }
    const now = nowMs();
    db.prepare(
      `INSERT INTO session_locks
         (campaign_id, session_id, owner_pid, owner_host, owner_token, acquired_at, heartbeat_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(campaignId, sessionId, pid, host, token, new Date(now).toISOString(), now);
    return current;
  });
  const replaced = take.immediate();

  const lockFile = options.lockFile;
  if (lockFile !== undefined) {
    try {
      writeLockFile(
        lockFile,
        `${JSON.stringify({ campaign_id: campaignId, session_id: sessionId, pid, host, token, acquired_at: new Date(nowMs()).toISOString() }, null, 2)}\n`,
      );
    } catch (error) {
      db.prepare('DELETE FROM session_locks WHERE owner_token = ?').run(token);
      throw error;
    }
  }

  let timer: NodeJS.Timeout | undefined;
  let released = false;

  const heartbeat = (): boolean => {
    if (released) return false;
    const now = nowMs();
    const held =
      db.prepare('UPDATE session_locks SET heartbeat_at = ? WHERE owner_token = ?').run(now, token)
        .changes === 1;
    if (held) heartbeatJobs(db, token, now);
    return held;
  };

  const stop = (): void => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };

  return {
    token,
    pid,
    replaced,
    heartbeat,
    startHeartbeat(onLost) {
      stop();
      timer = setInterval(() => {
        let held: boolean;
        try {
          held = heartbeat();
        } catch {
          // Busy database: try again on the next tick; staleness is measured in tens of seconds.
          return;
        }
        if (!held) {
          stop();
          onLost();
        }
      }, heartbeatMs);
      timer.unref();
    },
    release() {
      if (released) return;
      stop();
      released = true;
      try {
        db.prepare('DELETE FROM session_locks WHERE owner_token = ?').run(token);
      } finally {
        if (lockFile !== undefined) removeLockFileIfOurs(lockFile, token);
      }
    },
  };
}
