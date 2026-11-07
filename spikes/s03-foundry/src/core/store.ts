import type { CapturedEvent } from "./types.js";

/**
 * Append-only IndexedDB event store.
 *
 * - Object store `events`, keyPath `recordId`; writes use `add` only, so an existing record can never be overwritten.
 * - Indexes: `bySession` (loss measurement), `byEventId` (diagnostics; non-unique because dedup happens at export).
 * - Each batch is one readwrite transaction requested with `durability: "strict"` (honoured by Chromium; other engines
 *   may ignore it). `append` resolves on `complete`, i.e. only after the batch is committed.
 * - `clear()` exists only for resetting the spike between measurement runs; production code (T16) must not expose it.
 */

export const DEFAULT_DB_NAME = "sargas-recap-spike";
const DB_VERSION = 1;
const EVENTS = "events";

export interface EventStore {
  append(batch: readonly CapturedEvent[]): Promise<void>;
  getAll(): Promise<CapturedEvent[]>;
  count(): Promise<number>;
  countBySession(sessionId: string): Promise<number>;
  sessionIds(): Promise<string[]>;
  clear(): Promise<void>;
  close(): void;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("IndexedDB request failed"));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction error"));
  });
}

export interface OpenStoreOptions {
  indexedDB?: IDBFactory;
  dbName?: string;
}

export async function openEventStore(opts: OpenStoreOptions = {}): Promise<EventStore> {
  const factory = opts.indexedDB ?? globalThis.indexedDB;
  if (!factory) throw new Error("IndexedDB is not available in this environment");
  const open = factory.open(opts.dbName ?? DEFAULT_DB_NAME, DB_VERSION);
  open.onupgradeneeded = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains(EVENTS)) {
      const store = db.createObjectStore(EVENTS, { keyPath: "recordId" });
      store.createIndex("bySession", "sessionId", { unique: false });
      store.createIndex("byEventId", "eventId", { unique: false });
    }
  };
  const db = await req(open);
  return new IdbEventStore(db);
}

class IdbEventStore implements EventStore {
  constructor(private readonly db: IDBDatabase) {}

  private tx(mode: IDBTransactionMode): IDBTransaction {
    return mode === "readwrite"
      ? this.db.transaction(EVENTS, mode, { durability: "strict" })
      : this.db.transaction(EVENTS, mode);
  }

  async append(batch: readonly CapturedEvent[]): Promise<void> {
    if (batch.length === 0) return;
    const tx = this.tx("readwrite");
    const done = txDone(tx);
    const store = tx.objectStore(EVENTS);
    for (const ev of batch) store.add(ev);
    await done;
  }

  async getAll(): Promise<CapturedEvent[]> {
    const tx = this.tx("readonly");
    return (await req(tx.objectStore(EVENTS).getAll())) as CapturedEvent[];
  }

  async count(): Promise<number> {
    return req(this.tx("readonly").objectStore(EVENTS).count());
  }

  async countBySession(sessionId: string): Promise<number> {
    return req(this.tx("readonly").objectStore(EVENTS).index("bySession").count(IDBKeyRange.only(sessionId)));
  }

  async sessionIds(): Promise<string[]> {
    const index = this.tx("readonly").objectStore(EVENTS).index("bySession");
    const ids: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const cursorReq = index.openKeyCursor(null, "nextunique");
      cursorReq.onerror = () => reject(cursorReq.error ?? new Error("cursor failed"));
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return resolve();
        ids.push(String(cursor.key));
        cursor.continue();
      };
    });
    return ids;
  }

  async clear(): Promise<void> {
    const tx = this.tx("readwrite");
    const done = txDone(tx);
    tx.objectStore(EVENTS).clear();
    await done;
  }

  close(): void {
    this.db.close();
  }
}
