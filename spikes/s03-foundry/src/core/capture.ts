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
 * Glue between hook probes and storage. Counts every hook fire, but only issues + buffers events when this client is
 * the designated writer. The ledger is updated synchronously *before* buffering so loss can be measured.
 */
export class CaptureController {
  private seq = 0;
  ignored = 0;
  readonly fires: Record<string, number> = {};

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

  capture(input: CaptureInput): CapturedEvent | null {
    this.fires[input.hook] = (this.fires[input.hook] ?? 0) + 1;
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
