/**
 * Per-user receive-stream bookkeeping (THROWAWAY spike). Discord-free so it is testable offline.
 *
 * Why: in @discordjs/voice 0.19.2 `receiver.subscribe(userId)` returns the EXISTING stream while one is
 * still alive (it is only removed from `receiver.subscriptions` on the stream's `close`). After a short
 * disconnect the old stream can survive until its silence timeout; if we merely forgot it and subscribed
 * again we would attach a second `data` listener to the same stream and decode/write every packet twice.
 * So at a discontinuity every tracked stream is detached and destroyed (which also removes it from the
 * receiver), and every callback is tied to the specific stream it was registered on: a late `data`,
 * `end` or `close` from a stale stream never reaches the current subscription.
 */
import type { EventEmitter } from "node:events";

export interface ReceiveStreamLike extends EventEmitter {
  destroy(): unknown;
}

export interface SubscriptionHandlers {
  onData(pkt: Buffer): void;
  onEnd(): void;
  onError(e: Error): void;
}

interface Entry {
  stream: ReceiveStreamLike;
  detach(): void;
}

export class ReceiveSubscriptions {
  private readonly entries = new Map<string, Entry>();

  has(userId: string): boolean {
    return this.entries.has(userId);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Tracks `stream` as the current subscription for `userId` and wires its callbacks. */
  add(userId: string, stream: ReceiveStreamLike, h: SubscriptionHandlers): void {
    const prev = this.entries.get(userId);
    if (prev?.stream === stream) return; // same stream handed back again: never attach twice
    if (prev) this.drop(userId);
    const current = () => this.entries.get(userId)?.stream === stream;
    const onData = (pkt: Buffer) => {
      if (current()) h.onData(pkt);
    };
    const done = () => {
      if (!current()) return;
      this.entries.get(userId)!.detach();
      this.entries.delete(userId);
      h.onEnd();
    };
    // Kept attached even after detach, so a late stream error never becomes an unhandled 'error' event.
    const onError = (e: Error) => {
      if (current()) h.onError(e);
    };
    stream.on("data", onData);
    stream.once("end", done);
    stream.once("close", done);
    stream.on("error", onError);
    this.entries.set(userId, {
      stream,
      detach: () => {
        stream.off("data", onData);
        stream.off("end", done);
        stream.off("close", done);
      },
    });
  }

  /** Detaches and destroys one user's stream without calling its onEnd. */
  drop(userId: string): void {
    const e = this.entries.get(userId);
    if (!e) return;
    this.entries.delete(userId);
    e.detach();
    e.stream.destroy();
  }

  /** Detaches and destroys every stream (discontinuity, forced reconnect, stop). */
  dropAll(): void {
    for (const userId of [...this.entries.keys()]) this.drop(userId);
  }
}
