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
  removeItem(key: string): void;
  readonly length: number;
  key(index: number): string | null;
}

export interface LedgerEntry {
  issued: number;
  startedAt: string;
}

/** Base prefix; the full per-world prefix is `<LEDGER_PREFIX>:<worldNs>:` (see ledgerPrefix). */
export const LEDGER_PREFIX = "sargas-recap-spike:issued";
const MAX_SESSIONS = 50;

/**
 * Key prefix for one world. Every page load owns exactly one key, `<prefix><sessionId>`, and only ever writes that key,
 * so concurrent tabs cannot overwrite each other's counters (no read-modify-write of a shared snapshot).
 */
export function ledgerPrefix(worldNs: string): string {
  return `${LEDGER_PREFIX}:${encodeURIComponent(worldNs)}:`;
}

function parseEntry(raw: string | null): LedgerEntry | null {
  if (!raw) return null;
  try {
    const e = JSON.parse(raw) as Partial<LedgerEntry> | null;
    if (e && typeof e === "object" && Number.isSafeInteger(e.issued) && typeof e.startedAt === "string") {
      return { issued: e.issued as number, startedAt: e.startedAt };
    }
  } catch {
    // corrupt entry: ignored
  }
  return null;
}

function keysWithPrefix(kv: KeyValue, prefix: string): string[] {
  const out: string[] = [];
  try {
    for (let i = 0; i < kv.length; i++) {
      const k = kv.key(i);
      if (k !== null && k.startsWith(prefix)) out.push(k);
    }
  } catch {
    // storage unavailable
  }
  return out;
}

export class IssueLedger {
  private entry: LedgerEntry;
  private readonly prefix: string;

  constructor(
    private readonly kv: KeyValue,
    readonly sessionId: string,
    readonly worldNs: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.prefix = ledgerPrefix(worldNs);
    this.entry = { issued: 0, startedAt: now().toISOString() };
    this.write();
    this.trim();
  }

  /** Fresh read of every session entry of one world, straight from storage (never a cached snapshot). */
  static read(kv: KeyValue, worldNs: string): Record<string, LedgerEntry> {
    const prefix = ledgerPrefix(worldNs);
    const out: Record<string, LedgerEntry> = {};
    for (const k of keysWithPrefix(kv, prefix)) {
      let raw: string | null = null;
      try {
        raw = kv.getItem(k);
      } catch {
        continue;
      }
      const e = parseEntry(raw);
      if (e) out[decodeURIComponent(k.slice(prefix.length))] = e;
    }
    return out;
  }

  recordIssued(seq: number): void {
    if (seq > this.entry.issued) this.entry.issued = seq;
    this.write();
  }

  get issued(): number {
    return this.entry.issued;
  }

  /** All sessions of this world as currently stored (includes concurrent tabs' latest counters). */
  snapshot(): Record<string, LedgerEntry> {
    return IssueLedger.read(this.kv, this.worldNs);
  }

  /**
   * Spike reset: remove every ledger entry of this world (records are being deleted too, so their counters must go,
   * otherwise the next recovery reports them as losses) and restart this page load's counter at 0.
   */
  reset(): void {
    for (const k of keysWithPrefix(this.kv, this.prefix)) {
      try {
        this.kv.removeItem(k);
      } catch {
        // ignore
      }
    }
    this.entry = { issued: 0, startedAt: this.now().toISOString() };
    this.write();
  }

  private key(sessionId: string): string {
    return `${this.prefix}${encodeURIComponent(sessionId)}`;
  }

  /** Drop the oldest sessions beyond MAX_SESSIONS (never this one). Only removes keys, never rewrites others. */
  private trim(): void {
    const all = Object.entries(IssueLedger.read(this.kv, this.worldNs))
      .filter(([id]) => id !== this.sessionId)
      .sort((a, b) => a[1].startedAt.localeCompare(b[1].startedAt));
    while (all.length > MAX_SESSIONS - 1) {
      const oldest = all.shift();
      if (!oldest) break;
      try {
        this.kv.removeItem(this.key(oldest[0]));
      } catch {
        // ignore
      }
    }
  }

  private write(): void {
    try {
      this.kv.setItem(this.key(this.sessionId), JSON.stringify(this.entry));
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
