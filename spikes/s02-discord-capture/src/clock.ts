/**
 * Session clock for the S02 spike (THROWAWAY).
 *
 * The session clock is `process.hrtime.bigint()` (monotonic, nanoseconds). It is never adjusted by NTP or
 * wall-clock changes, and on Windows (QueryPerformanceCounter) and Linux (CLOCK_MONOTONIC) it is
 * system-wide, so a separate process (see kill-test.ts) can read the same timeline.
 *
 * `t0Ns` is captured once at `/spike start`. Every stored offset is an integer number of milliseconds
 * since t0. A wall-clock anchor (`t0Wall`) is stored alongside t0 for humans and for cross-process
 * alignment after a crash, where the monotonic t0 of the dead process is the only link.
 */
export interface Clock {
  /** Monotonic now in nanoseconds. */
  nowNs(): bigint;
  /** Wall clock now (ms since UNIX epoch). Only used as a human/cross-process anchor. */
  wallMs(): number;
}

export const systemClock: Clock = {
  nowNs: () => process.hrtime.bigint(),
  wallMs: () => Date.now(),
};

/** Deterministic clock for tests: time only moves when `advanceMs` is called. */
export class FakeClock implements Clock {
  private ns: bigint;
  private wall: number;
  constructor(startNs = 1_000_000_000n, startWallMs = Date.UTC(2026, 0, 1)) {
    this.ns = startNs;
    this.wall = startWallMs;
  }
  nowNs(): bigint {
    return this.ns;
  }
  wallMs(): number {
    return this.wall;
  }
  advanceMs(ms: number): void {
    this.ns += BigInt(Math.round(ms * 1_000_000));
    this.wall += ms;
  }
}

/** Integer milliseconds between two monotonic readings (rounded half away from zero). */
export function nsToMs(deltaNs: bigint): number {
  const neg = deltaNs < 0n;
  const abs = neg ? -deltaNs : deltaNs;
  const ms = Number((abs + 500_000n) / 1_000_000n);
  return neg ? -ms : ms;
}
