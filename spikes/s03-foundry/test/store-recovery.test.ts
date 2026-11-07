import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { CaptureController } from "../src/core/capture.js";
import { IssueLedger, ledgerPrefix, recover } from "../src/core/durability.js";
import { BufferedWriter } from "../src/core/flush-policy.js";
import { openEventStore } from "../src/core/store.js";
import { ev, MemoryKV, uniqueDbName } from "./helpers.js";

describe("IndexedDB append-only store", () => {
  it("appends batches and never overwrites an existing record", async () => {
    const store = await openEventStore({ dbName: uniqueDbName() });
    await store.append([ev("A", 1), ev("A", 2)]);
    await expect(store.append([ev("A", 2, { summary: { overwritten: true } })])).rejects.toBeTruthy();
    const all = await store.getAll();
    expect(all).toHaveLength(2);
    expect(all.find((e) => e.seq === 2)?.summary).toEqual({ synthetic: true });
    store.close();
  });

  it("counts per session and lists sessions", async () => {
    const store = await openEventStore({ dbName: uniqueDbName() });
    await store.append([ev("A", 1), ev("A", 2), ev("B", 1)]);
    expect(await store.countBySession("A")).toBe(2);
    expect(await store.countBySession("B")).toBe(1);
    expect(await store.countBySession("C")).toBe(0);
    expect((await store.sessionIds()).sort()).toEqual(["A", "B"]);
    store.close();
  });
});

describe("reload recovery and loss measurement", () => {
  it("after a simulated reload, persisted events survive and unflushed ones are reported as lost", async () => {
    const dbName = uniqueDbName();
    const kv = new MemoryKV(); // stands in for window.localStorage, which survives the reload

    // --- page load 1 --------------------------------------------------------------------------------------------
    const store1 = await openEventStore({ dbName });
    const ledger1 = new IssueLedger(kv, "load-1", "W");
    const writer1 = new BufferedWriter((b) => store1.append(b), { maxBatch: 5, maxDelayMs: 60_000 });
    const cap1 = new CaptureController("load-1", writer1, ledger1, () => true);
    const mark = (n: number) =>
      cap1.capture({ category: "marker", hook: "manual-mark", kind: "mark", source: "load-1", discriminator: n, initiatorHash: null, summary: {} });
    for (let i = 1; i <= 10; i++) {
      mark(i);
      if (i % 5 === 0) await writer1.idle(); // size-triggered batches of 5 commit
    }
    mark(11);
    mark(12); // below maxBatch, timer (60 s) not yet due: these two live only in memory
    expect(writer1.stats.buffered).toBe(2);
    // Simulated tab kill: the in-memory buffer (2 events) is discarded, the DB connection dies, no pagehide flush.
    store1.close();

    // --- page load 2 --------------------------------------------------------------------------------------------
    const store2 = await openEventStore({ dbName });
    const ledger2 = new IssueLedger(kv, "load-2", "W");
    const report = await recover(store2, ledger2.snapshot(), "load-2");
    expect(report.persistedTotal).toBe(10);
    expect(report.priorSessions).toEqual([
      expect.objectContaining({ sessionId: "load-1", issued: 12, persisted: 10, lost: 2 }),
    ]);
    // Recovered records are readable and intact.
    const all = await store2.getAll();
    expect(all.map((e) => e.seq).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    store2.close();
  });

  it("reports zero loss when the lifecycle flush committed before the reload", async () => {
    const dbName = uniqueDbName();
    const kv = new MemoryKV();
    const store1 = await openEventStore({ dbName });
    const ledger1 = new IssueLedger(kv, "L1", "W");
    const writer1 = new BufferedWriter((b) => store1.append(b), { maxBatch: 50, maxDelayMs: 60_000 });
    const cap1 = new CaptureController("L1", writer1, ledger1, () => true);
    for (let i = 0; i < 7; i++) {
      cap1.capture({ category: "marker", hook: "manual-mark", kind: "mark", source: "L1", discriminator: i + 1, initiatorHash: null, summary: {} });
    }
    await writer1.flush("pagehide");
    store1.close();

    const store2 = await openEventStore({ dbName });
    const report = await recover(store2, new IssueLedger(kv, "L2", "W").snapshot(), "L2");
    expect(report.priorSessions[0]).toMatchObject({ issued: 7, persisted: 7, lost: 0 });
    store2.close();
  });

  it("non-writer clients issue nothing and are not counted as loss", async () => {
    const store = await openEventStore({ dbName: uniqueDbName() });
    const kv = new MemoryKV();
    const writer = new BufferedWriter((b) => store.append(b));
    const cap = new CaptureController("X", writer, new IssueLedger(kv, "X", "W"), () => false);
    expect(cap.capture({ category: "rolls", hook: "createChatMessage", kind: "chat", source: "m", discriminator: "create", initiatorHash: null, summary: {} })).toBeNull();
    expect(cap.ignored).toBe(1);
    expect(cap.emitted["createChatMessage"]).toBe(1);
    expect(cap.issued).toBe(0);
    store.close();
  });

  it("tolerates a corrupt ledger", () => {
    const kv = new MemoryKV();
    const p = ledgerPrefix("W");
    kv.setItem(`${p}a`, "{not json");
    expect(IssueLedger.read(kv, "W")).toEqual({});
    kv.setItem(`${p}b`, JSON.stringify({ issued: "x" }));
    kv.setItem(`${p}c`, JSON.stringify({ issued: 3, startedAt: "t" }));
    kv.setItem(`${p}d`, "null");
    expect(IssueLedger.read(kv, "W")).toEqual({ c: { issued: 3, startedAt: "t" } });
  });
});
