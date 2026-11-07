import { makeEventId, makeRecordId } from "../src/core/ids.js";
import type { KeyValue } from "../src/core/durability.js";
import type { CapturedEvent } from "../src/core/types.js";

export function ev(sessionId: string, seq: number, overrides: Partial<CapturedEvent> = {}): CapturedEvent {
  return {
    eventId: makeEventId({ kind: "chat", source: `src-${seq}`, discriminator: "create" }),
    recordId: makeRecordId(sessionId, seq),
    sessionId,
    seq,
    category: "rolls",
    hook: "createChatMessage",
    capturedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    initiatorHash: null,
    localDiscriminator: false,
    summary: { synthetic: true },
    ...overrides,
  };
}

export class MemoryKV implements KeyValue {
  readonly map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
}

let dbCounter = 0;
export function uniqueDbName(): string {
  return `s03-test-${process.pid}-${++dbCounter}`;
}
