import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { anonymize, changedPaths, hashId } from "../src/core/anonymize.js";
import { CaptureController } from "../src/core/capture.js";
import { IssueLedger, recover } from "../src/core/durability.js";
import { exportJsonl, mergeJsonl } from "../src/core/export.js";
import { BufferedWriter } from "../src/core/flush-policy.js";
import { resetMeasurement } from "../src/core/reset.js";
import { openEventStore, worldDbName } from "../src/core/store.js";
import type { CapturedEvent } from "../src/core/types.js";
import { registerProbes } from "../src/foundry/probe.js";
import { ev, MemoryKV, uniqueDbName } from "./helpers.js";

const ID = "AbCdEfGhIjKlMnOp";

const markInput = (n: number) => ({
  category: "marker" as const,
  hook: "manual-mark",
  kind: "mark",
  source: "s",
  discriminator: n,
  initiatorHash: null,
  summary: {},
});

/** Minimal Hooks stand-in: `on` registers, `call` invokes every handler for a hook. */
class FakeHooks {
  private next = 1;
  readonly handlers = new Map<string, Array<(...a: unknown[]) => void>>();
  on(hook: string, fn: (...a: unknown[]) => void): number {
    const list = this.handlers.get(hook) ?? [];
    list.push(fn);
    this.handlers.set(hook, list);
    return this.next++;
  }
  call(hook: string, ...args: unknown[]): void {
    for (const fn of this.handlers.get(hook) ?? []) fn(...args);
  }
}

function probeHarness() {
  const pushed: CapturedEvent[] = [];
  const writer = { push: (e: CapturedEvent) => pushed.push(e) } as unknown as BufferedWriter;
  const ledger = new IssueLedger(new MemoryKV(), "S", "W");
  const capture = new CaptureController("S", writer, ledger, () => true);
  const hooks = new FakeHooks();
  const state = registerProbes(capture, hooks);
  return { capture, hooks, pushed, state };
}

describe("#52 anonymizer: ids embedded in compound strings", () => {
  it("hashes id components of allowlisted slug strings", () => {
    const out = anonymize({ options: [`Actor.${ID}`, `origin:item:${ID}`, "self:condition:frightened"] }) as Record<string, string[]>;
    expect(out.options).toEqual([`Actor.${hashId(ID)}`, `origin:item:${hashId(ID)}`, "self:condition:frightened"]);
    expect(JSON.stringify(out)).not.toContain(ID);
  });

  it("hashes ids embedded in keys and diff paths, still hashes whole-string ids, leaves 17+ char tokens", () => {
    expect(anonymize({ [`Actor.${ID}`]: 1 })).toEqual({ [`Actor.${hashId(ID)}`]: 1 });
    expect(changedPaths({ [`flags.${ID}`]: { v: 1 } })).toEqual([`flags.${hashId(ID)}.v`]);
    expect(anonymize(ID)).toBe(hashId(ID));
    expect(anonymize({ slug: "abcdefghijklmnopq" })).toEqual({ slug: "abcdefghijklmnopq" });
  });
});

describe("#52 ledger: concurrent tabs and per-world namespacing", () => {
  it("two tabs updating concurrently never overwrite each other's counters", () => {
    const kv = new MemoryKV();
    const tabA = new IssueLedger(kv, "A", "W");
    const tabB = new IssueLedger(kv, "B", "W");
    tabA.recordIssued(5);
    tabB.recordIssued(2);
    tabA.recordIssued(6);
    const tabC = new IssueLedger(kv, "C", "W");
    expect(tabC.snapshot()).toMatchObject({ A: { issued: 6 }, B: { issued: 2 }, C: { issued: 0 } });
  });

  it("worlds do not see each other's ledger or records", async () => {
    const kv = new MemoryKV();
    new IssueLedger(kv, "w1-load", "world1").recordIssued(3);
    expect(Object.keys(new IssueLedger(kv, "w2-load", "world2").snapshot())).toEqual(["w2-load"]);

    const base = uniqueDbName();
    const s1 = await openEventStore({ dbName: worldDbName(`${base}-1`) });
    const s2 = await openEventStore({ dbName: worldDbName(`${base}-2`) });
    await s1.append([ev("w1-load", 1)]);
    expect(await s2.count()).toBe(0);
    await s2.clear();
    expect(await s1.count()).toBe(1);
    s1.close();
    s2.close();
  });
});

describe("#52 mergeJsonl: valid JSON that is not an event", () => {
  it("counts null / scalars / arrays / incomplete objects as invalid instead of throwing", () => {
    const good = exportJsonl([ev("A", 1)]).jsonl;
    const r = mergeJsonl(good, 'null\n42\n"str"\n[]\n{}\n{"eventId":"x"}\n');
    expect(r).toMatchObject({ unique: 1, invalid: 6, total: 7, duplicates: 0 });
    expect(() => mergeJsonl("null\n")).not.toThrow();
  });
});

describe("#52 probe: invocations vs emitted events", () => {
  it("counts each hook call once regardless of how many events it emits", () => {
    const { capture, hooks, pushed } = probeHarness();
    // Filtered out: no hp change. Fired, emitted nothing.
    hooks.call("updateActor", { uuid: "Actor.x" }, { name: "n" }, {}, "u");
    // Condition item whose quantity also changed: one invocation, two events.
    hooks.call("updateItem", { uuid: "Item.y", type: "condition", _stats: { modifiedTime: 1 } }, { system: { quantity: 2 } }, {}, "u");
    expect(capture.fires["updateActor"]).toBe(1);
    expect(capture.emitted["updateActor"] ?? 0).toBe(0);
    expect(capture.fires["updateItem"]).toBe(1);
    expect(capture.emitted["updateItem"]).toBe(2);
    expect(pushed).toHaveLength(2);
  });

  it("counts an invocation even when the handler throws", () => {
    const { capture, hooks, state } = probeHarness();
    const throwing = { get uuid(): string { throw new Error("boom"); } };
    hooks.call("createChatMessage", throwing, {}, "u");
    expect(capture.fires["createChatMessage"]).toBe(1);
    expect(state.errors["createChatMessage"]).toBe(1);
  });
});

describe("#52 probe: combat transitions back and forth", () => {
  it("distinct transitions into the same round/turn get distinct eventIds and survive export", () => {
    const { hooks, pushed } = probeHarness();
    const combat = { uuid: "Combat.c", round: 1, turn: 0, _stats: { modifiedTime: 100 } };
    hooks.call("combatTurn", combat, { round: 1, turn: 1 }, { direction: 1 });
    combat._stats.modifiedTime = 200;
    hooks.call("combatTurn", combat, { round: 1, turn: 0 }, { direction: -1 });
    combat._stats.modifiedTime = 300;
    hooks.call("combatTurn", combat, { round: 1, turn: 1 }, { direction: 1 });
    expect(new Set(pushed.map((e) => e.eventId)).size).toBe(3);
    expect(pushed.every((e) => !e.localDiscriminator)).toBe(true);
    expect(pushed[2]?.summary).toMatchObject({ round: 1, turn: 1 });
    expect(exportJsonl(pushed).unique).toBe(3);
  });

  it("the same transition seen by two clients still deduplicates", () => {
    const a = probeHarness();
    const b = probeHarness();
    const combat = { uuid: "Combat.c", round: 2, turn: 0, _stats: { modifiedTime: 500 } };
    a.hooks.call("combatRound", combat, { round: 2, turn: 0 }, {});
    b.hooks.call("combatRound", combat, { round: 2, turn: 0 }, {});
    expect(a.pushed[0]?.eventId).toBe(b.pushed[0]?.eventId);
  });

  it("without modifiedTime falls back to a flagged local discriminator", () => {
    const { hooks, pushed } = probeHarness();
    hooks.call("combatTurn", { uuid: "Combat.c" }, { round: 1, turn: 1 }, {});
    expect(pushed[0]?.localDiscriminator).toBe(true);
  });
});

describe("#52 coordinated reset", () => {
  it("clears records and ledger, discards buffered writes, and the next load reports no false loss", async () => {
    const dbName = uniqueDbName();
    const kv = new MemoryKV();
    const store = await openEventStore({ dbName });
    // Earlier page load with a real loss, which the reset must forget.
    new IssueLedger(kv, "old", "W").recordIssued(4);

    const ledger = new IssueLedger(kv, "cur", "W");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const writer = new BufferedWriter(
      async (b) => {
        if (calls++ === 0) await gate; // first flush is in flight while the reset starts
        await store.append(b);
      },
      { maxBatch: 2, maxDelayMs: 60_000 },
    );
    const cap = new CaptureController("cur", writer, ledger, () => true);
    cap.capture(markInput(1));
    cap.capture(markInput(2)); // size flush starts, blocked on gate
    await new Promise((r) => setTimeout(r, 0)); // let the in-flight flush take its batch
    expect(calls).toBe(1);
    cap.capture(markInput(3)); // buffered only

    const resetting = resetMeasurement({ capture: cap, writer, store, ledger });
    expect(cap.capture(markInput(99))).toBeNull(); // paused during reset
    release();
    const result = await resetting;
    expect(result.discardedBuffered).toBe(1);
    expect(await store.count()).toBe(0); // in-flight batch landed before the clear, then got cleared
    expect(cap.issued).toBe(0);
    expect(cap.paused).toBe(false);

    await writer.flush("manual");
    expect(await store.count()).toBe(0); // nothing pre-reset can repopulate the store

    cap.capture(markInput(1));
    await writer.flush("manual");
    store.close();

    const store2 = await openEventStore({ dbName });
    const report = await recover(store2, new IssueLedger(kv, "next", "W").snapshot(), "next");
    expect(report.priorSessions).toEqual([expect.objectContaining({ sessionId: "cur", issued: 1, persisted: 1, lost: 0 })]);
    store2.close();
  });
});
