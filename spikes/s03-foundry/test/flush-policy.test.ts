import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BufferedWriter, type LifecycleTarget } from "../src/core/flush-policy.js";
import type { CapturedEvent } from "../src/core/types.js";
import { ev } from "./helpers.js";

class FakeTarget implements LifecycleTarget {
  visibilityState = "visible";
  private listeners = new Map<string, Set<() => void>>();
  addEventListener(t: string, fn: () => void) {
    if (!this.listeners.has(t)) this.listeners.set(t, new Set());
    this.listeners.get(t)?.add(fn);
  }
  removeEventListener(t: string, fn: () => void) {
    this.listeners.get(t)?.delete(fn);
  }
  dispatch(t: string) {
    for (const fn of this.listeners.get(t) ?? []) fn();
  }
}

describe("flush policy", () => {
  let batches: CapturedEvent[][];
  const sink = async (b: readonly CapturedEvent[]) => {
    batches.push([...b]);
  };

  beforeEach(() => {
    batches = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("flushes when maxBatch is reached", async () => {
    const w = new BufferedWriter(sink, { maxBatch: 3, maxDelayMs: 10_000 });
    for (let i = 1; i <= 3; i++) w.push(ev("S", i));
    await vi.runAllTimersAsync();
    expect(batches.map((b) => b.length)).toEqual([3]);
    expect(w.stats).toMatchObject({ buffered: 0, flushedEvents: 3, flushes: 1, lastFlushReason: "size" });
  });

  it("flushes after maxDelayMs measured from the first buffered event (timer not reset)", async () => {
    const w = new BufferedWriter(sink, { maxBatch: 100, maxDelayMs: 500 });
    w.push(ev("S", 1));
    await vi.advanceTimersByTimeAsync(400);
    w.push(ev("S", 2));
    await vi.advanceTimersByTimeAsync(99);
    expect(batches).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(batches.map((b) => b.length)).toEqual([2]);
    expect(w.stats.lastFlushReason).toBe("timer");
  });

  it("flushes on visibilitychange to hidden and on pagehide", async () => {
    const win = new FakeTarget();
    const doc = new FakeTarget();
    const w = new BufferedWriter(sink, { maxBatch: 100, maxDelayMs: 10_000 });
    const detach = w.attachLifecycle(win, doc);

    w.push(ev("S", 1));
    doc.dispatch("visibilitychange"); // still visible: no flush
    await vi.advanceTimersByTimeAsync(0);
    expect(batches).toHaveLength(0);

    doc.visibilityState = "hidden";
    doc.dispatch("visibilitychange");
    await vi.advanceTimersByTimeAsync(0);
    expect(batches).toHaveLength(1);
    expect(w.stats.lastFlushReason).toBe("visibilitychange");

    w.push(ev("S", 2));
    win.dispatch("pagehide");
    await vi.advanceTimersByTimeAsync(0);
    expect(batches).toHaveLength(2);
    expect(w.stats.lastFlushReason).toBe("pagehide");

    detach();
    w.push(ev("S", 3));
    win.dispatch("pagehide");
    await vi.advanceTimersByTimeAsync(0);
    expect(batches).toHaveLength(2);
  });

  it("requeues a failed batch in order and retries on the next trigger", async () => {
    let fail = true;
    const seen: number[][] = [];
    const w = new BufferedWriter(
      async (b) => {
        if (fail) throw new Error("quota");
        seen.push(b.map((e) => e.seq));
      },
      { maxBatch: 2, maxDelayMs: 100 },
    );
    w.push(ev("S", 1));
    w.push(ev("S", 2));
    await vi.advanceTimersByTimeAsync(0);
    expect(w.stats).toMatchObject({ buffered: 2, failures: 1, lastError: "quota" });
    fail = false;
    w.push(ev("S", 3));
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([[1, 2, 3]]);
    expect(w.stats).toMatchObject({ buffered: 0, flushedEvents: 3 });
  });

  it("serializes concurrent flushes without losing or duplicating events", async () => {
    vi.useRealTimers();
    const all: number[] = [];
    const w = new BufferedWriter(
      async (b) => {
        await new Promise((r) => setTimeout(r, 5));
        all.push(...b.map((e) => e.seq));
      },
      { maxBatch: 1000, maxDelayMs: 1000 },
    );
    w.push(ev("S", 1));
    const p1 = w.flush();
    w.push(ev("S", 2));
    const p2 = w.flush();
    await Promise.all([p1, p2]);
    expect(all).toEqual([1, 2]);
  });

  it("rejects invalid policies", () => {
    expect(() => new BufferedWriter(sink, { maxBatch: 0, maxDelayMs: 1 })).toThrow();
  });
});
