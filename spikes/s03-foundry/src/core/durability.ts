import type { EventStore } from "./store.js";

/**
 * Loss measurement.
 *
 * Every captured event increments a per-page-load `issued` counter that is written *synchronously* to a key-value
 * store (window.localStorage in the browser) before the event is buffered. After a refresh or tab kill, the next page
 * load compares each earlier session's `issued` with the number of records IndexedDB actually holds for it:
 * `lost = issued - persisted`. Caveat recorded in the doc: localStorage itself is not guaranteed durable on a hard
 * kill, so a measured loss of 0 is an upper bound on durability only if the ledger write survived too; the protocol
 * cross-checks with the GM's own count of "Mark" clicks.
 */

export interface KeyValue {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface LedgerEntry {
  issued: number;
  startedAt: string;
}

export const LEDGER_KEY = "sargas-recap-spike:issued-ledger";
const MAX_SESSIONS = 50;

export class IssueLedger {
  private entries: Record<string, LedgerEntry>;

  constructor(
    private readonly kv: KeyValue,
    readonly sessionId: string,
    now: () => Date = () => new Date(),
  ) {
    this.entries = IssueLedger.read(kv);
    this.entries[sessionId] = { issued: 0, startedAt: now().toISOString() };
    this.trim();
    this.write();
  }

  static read(kv: KeyValue): Record<string, LedgerEntry> {
    try {
      const raw = kv.getItem(LEDGER_KEY);
      if (!raw) return {};
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const out: Record<string, LedgerEntry> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        const e = v as Partial<LedgerEntry> | null;
        if (e && Number.isSafeInteger(e.issued) && typeof e.startedAt === "string") {
          out[k] = { issued: e.issued as number, startedAt: e.startedAt };
        }
      }
      return out;
    } catch {
      return {};
    }
  }

  recordIssued(seq: number): void {
    const current = this.entries[this.sessionId];
    if (!current) return;
    if (seq > current.issued) current.issued = seq;
    this.write();
  }

  get issued(): number {
    return this.entries[this.sessionId]?.issued ?? 0;
  }

  snapshot(): Record<string, LedgerEntry> {
    return structuredClone(this.entries);
  }

  private trim(): void {
    const keys = Object.keys(this.entries).sort((a, b) =>
      (this.entries[a]?.startedAt ?? "").localeCompare(this.entries[b]?.startedAt ?? ""),
    );
    while (keys.length > MAX_SESSIONS) {
      const k = keys.shift();
      if (k !== undefined && k !== this.sessionId) delete this.entries[k];
    }
  }

  private write(): void {
    try {
      this.kv.setItem(LEDGER_KEY, JSON.stringify(this.entries));
    } catch {
      // Quota or private-mode failure: measurement degrades, capture continues.
    }
  }
}

export interface SessionLossReport {
  sessionId: string;
  startedAt: string;
  issued: number;
  persisted: number;
  lost: number;
}

export interface RecoveryReport {
  persistedTotal: number;
  priorSessions: SessionLossReport[];
}

/**
 * Run on page load (after the store opens, before new capture starts). Reports per-session loss for every earlier
 * session the ledger knows about. Persisted records are already readable from the store; nothing needs replaying,
 * because the store is append-only and the in-memory buffer of a dead page is simply gone.
 */
export async function recover(
  store: EventStore,
  ledgerSnapshot: Record<string, LedgerEntry>,
  currentSessionId: string,
): Promise<RecoveryReport> {
  const priorSessions: SessionLossReport[] = [];
  for (const [sessionId, entry] of Object.entries(ledgerSnapshot)) {
    if (sessionId === currentSessionId) continue;
    const persisted = await store.countBySession(sessionId);
    priorSessions.push({
      sessionId,
      startedAt: entry.startedAt,
      issued: entry.issued,
      persisted,
      lost: Math.max(0, entry.issued - persisted),
    });
  }
  priorSessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return { persistedTotal: await store.count(), priorSessions };
}
