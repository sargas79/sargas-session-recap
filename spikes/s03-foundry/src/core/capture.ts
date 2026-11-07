import { makeEventId, makeRecordId, type EventIdParts } from "./ids.js";
import type { IssueLedger } from "./durability.js";
import type { BufferedWriter } from "./flush-policy.js";
import type { CapturedEvent, HookCategory } from "./types.js";

export interface CaptureInput extends EventIdParts {
  category: HookCategory;
  hook: string;
  initiatorHash: string | null;
  localDiscriminator?: boolean;
  summary: Record<string, unknown>;
}

/**
 * Glue between hook probes and storage. Only issues + buffers events when this client is the designated writer (and
 * capture is not paused for a reset). The ledger is updated synchronously *before* buffering so loss can be measured.
 *
 * Two separate counters per hook:
 * - `fires`: hook invocations, counted once per call by the probe wrapper via `recordFire` *before* any filtering or
 *   payload parsing, so "fired but filtered out / unparseable" is distinguishable from "never fired".
 * - `emitted`: events produced from those invocations (0..n per invocation).
 */
export class CaptureController {
  private seq = 0;
  ignored = 0;
  /** Events dropped because capture was paused (reset in progress). */
  pausedDrops = 0;
  paused = false;
  readonly fires: Record<string, number> = {};
  readonly emitted: Record<string, number> = {};

  constructor(
    readonly sessionId: string,
    private readonly writer: BufferedWriter,
    private readonly ledger: IssueLedger,
    private readonly isWriter: () => boolean,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get issued(): number {
    return this.seq;
  }

  /** Count one hook invocation. Called once per call by the probe wrapper, independent of what gets emitted. */
  recordFire(hook: string): void {
    this.fires[hook] = (this.fires[hook] ?? 0) + 1;
  }

  /** Restart the per-page-load sequence (spike reset only; the store and ledger must have been cleared first). */
  resetSequence(): void {
    this.seq = 0;
    this.ignored = 0;
    this.pausedDrops = 0;
    for (const k of Object.keys(this.fires)) delete this.fires[k];
    for (const k of Object.keys(this.emitted)) delete this.emitted[k];
  }

  capture(input: CaptureInput): CapturedEvent | null {
    this.emitted[input.hook] = (this.emitted[input.hook] ?? 0) + 1;
    if (this.paused) {
      this.pausedDrops++;
      return null;
    }
    if (!this.isWriter()) {
      this.ignored++;
      return null;
    }
    const seq = ++this.seq;
    const ev: CapturedEvent = {
      eventId: makeEventId(input),
      recordId: makeRecordId(this.sessionId, seq),
      sessionId: this.sessionId,
      seq,
      category: input.category,
      hook: input.hook,
      capturedAt: this.now().toISOString(),
      initiatorHash: input.initiatorHash,
      localDiscriminator: input.localDiscriminator ?? false,
      summary: input.summary,
    };
    this.ledger.recordIssued(seq);
    this.writer.push(ev);
    return ev;
  }
}
