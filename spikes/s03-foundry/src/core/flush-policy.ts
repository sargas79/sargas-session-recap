import type { CapturedEvent } from "./types.js";

/**
 * Flush policy (documented in docs/spikes/S03-foundry.md):
 * 1. Size: flush as soon as `maxBatch` events are buffered.
 * 2. Time: otherwise flush `maxDelayMs` after the first unflushed event was buffered (one timer, not reset per event,
 *    so worst-case in-memory residence is bounded by maxDelayMs plus one IndexedDB commit).
 * 3. Lifecycle: flush immediately on `visibilitychange` to hidden and on `pagehide`. The browser does not wait for the
 *    IndexedDB commit on unload; whether that last flush lands is exactly what the refresh/tab-kill measurement tests.
 * 4. Failure: a failed batch is put back at the front of the buffer (order preserved) and retried on the next trigger.
 * Flushes are serialized; a flush requested while one is in flight runs after it with whatever is buffered then.
 */
export interface FlushPolicy {
  maxBatch: number;
  maxDelayMs: number;
}

export const DEFAULT_FLUSH_POLICY: FlushPolicy = Object.freeze({ maxBatch: 10, maxDelayMs: 500 });

export type FlushReason = "size" | "timer" | "visibilitychange" | "pagehide" | "manual";

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>),
};

export interface WriterStats {
  buffered: number;
  flushedEvents: number;
  flushes: number;
  failures: number;
  lastFlushReason: FlushReason | null;
  lastError: string | null;
}

export type BatchSink = (batch: readonly CapturedEvent[]) => Promise<void>;

export interface LifecycleTarget {
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}

export class BufferedWriter {
  private buffer: CapturedEvent[] = [];
  private timer: unknown = null;
  private chain: Promise<void> = Promise.resolve();
  private readonly s: Omit<WriterStats, "buffered"> = {
    flushedEvents: 0,
    flushes: 0,
    failures: 0,
    lastFlushReason: null,
    lastError: null,
  };

  constructor(
    private readonly sink: BatchSink,
    private readonly policy: FlushPolicy = DEFAULT_FLUSH_POLICY,
    private readonly timers: Timers = defaultTimers,
  ) {
    if (!(policy.maxBatch >= 1) || !(policy.maxDelayMs >= 0)) throw new Error("invalid flush policy");
  }

  get stats(): WriterStats {
    return { buffered: this.buffer.length, ...this.s };
  }

  push(ev: CapturedEvent): void {
    this.buffer.push(ev);
    if (this.buffer.length >= this.policy.maxBatch) {
      void this.flush("size");
    } else if (this.timer === null) {
      this.timer = this.timers.setTimeout(() => {
        this.timer = null;
        void this.flush("timer");
      }, this.policy.maxDelayMs);
    }
  }

  /** Returns a promise that settles after this flush (and any earlier queued flush) has finished. Never rejects. */
  flush(reason: FlushReason = "manual"): Promise<void> {
    if (this.timer !== null) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
    this.chain = this.chain.then(() => this.runFlush(reason));
    return this.chain;
  }

  /** Resolves when already-queued flushes have settled, without triggering a new one. */
  idle(): Promise<void> {
    return this.chain;
  }

  private async runFlush(reason: FlushReason): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    try {
      await this.sink(batch);
      this.s.flushedEvents += batch.length;
      this.s.flushes++;
      this.s.lastFlushReason = reason;
      this.s.lastError = null;
    } catch (err) {
      this.s.failures++;
      this.s.lastError = err instanceof Error ? err.message : String(err);
      this.buffer = [...batch, ...this.buffer];
    }
  }

  /** Wire visibilitychange (hidden) and pagehide flushes. Returns a detach function. */
  attachLifecycle(win: LifecycleTarget, doc: LifecycleTarget & { visibilityState: string }): () => void {
    const onVisibility = () => {
      if (doc.visibilityState === "hidden") void this.flush("visibilitychange");
    };
    const onPageHide = () => void this.flush("pagehide");
    doc.addEventListener("visibilitychange", onVisibility);
    win.addEventListener("pagehide", onPageHide);
    return () => {
      doc.removeEventListener("visibilitychange", onVisibility);
      win.removeEventListener("pagehide", onPageHide);
    };
  }
}
