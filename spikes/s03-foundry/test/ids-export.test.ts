import { describe, expect, it } from "vitest";
import { dedupeEvents, exportJsonl, mergeJsonl } from "../src/core/export.js";
import { EVENT_NAMESPACE, isNamespacedEventId, makeEventId, makeRecordId } from "../src/core/ids.js";
import { ev } from "./helpers.js";

describe("event id namespacing", () => {
  it("prefixes the module namespace and is deterministic", () => {
    const a = makeEventId({ kind: "chat", source: "abc", discriminator: "create" });
    expect(a).toBe(`${EVENT_NAMESPACE}:chat:abc:create`);
    expect(makeEventId({ kind: "chat", source: "abc", discriminator: "create" })).toBe(a);
    expect(isNamespacedEventId(a)).toBe(true);
  });

  it("escapes separators so segments cannot forge extra parts", () => {
    const id = makeEventId({ kind: "chat", source: "Actor.x:evil", discriminator: "1#2" });
    expect(id.split(":")).toHaveLength(4);
    expect(id).toContain("Actor.x%3Aevil");
    expect(id).toContain("1%232");
    expect(isNamespacedEventId(id)).toBe(true);
  });

  it("rejects empty or oversized segments", () => {
    expect(() => makeEventId({ kind: "", source: "a", discriminator: 1 })).toThrow();
    expect(() => makeEventId({ kind: "k", source: "x".repeat(200), discriminator: 1 })).toThrow();
  });

  it("does not accept foreign namespaces", () => {
    expect(isNamespacedEventId("other-module/v1:chat:a:b")).toBe(false);
    expect(isNamespacedEventId("sargas-recap-spike/v2:chat:a:b")).toBe(false);
    expect(isNamespacedEventId(42)).toBe(false);
  });

  it("record ids are per session and zero padded", () => {
    expect(makeRecordId("sess", 7)).toBe("sess#000000007");
    expect(() => makeRecordId("sess", 0)).toThrow();
  });
});

describe("deduplicated export", () => {
  it("keeps the earliest capture of each eventId and counts duplicates", () => {
    const shared = makeEventId({ kind: "chat", source: "msg1", discriminator: "create" });
    const events = [
      ev("B", 5, { eventId: shared, capturedAt: "2026-01-01T00:00:05.000Z" }),
      ev("A", 1, { eventId: shared, capturedAt: "2026-01-01T00:00:01.000Z" }),
      ev("A", 2),
    ];
    const { unique, duplicates } = dedupeEvents(events);
    expect(unique).toHaveLength(2);
    expect(duplicates).toBe(1);
    expect(unique[0]?.sessionId).toBe("A");
  });

  it("drops non-namespaced ids as invalid", () => {
    const r = exportJsonl([ev("A", 1), ev("A", 2, { eventId: "foreign:id" })]);
    expect(r).toMatchObject({ total: 2, unique: 1, invalid: 1, duplicates: 0 });
  });

  it("emits one JSON object per line, deterministic order", () => {
    const r = exportJsonl([ev("A", 3), ev("A", 1), ev("A", 2)]);
    const lines = r.jsonl.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => JSON.parse(l).seq)).toEqual([1, 2, 3]);
    expect(exportJsonl([]).jsonl).toBe("");
  });

  it("merging exports from two clients removes cross-client duplicates", () => {
    const shared = makeEventId({ kind: "combat-round", source: "c1", discriminator: "2.0" });
    const clientA = exportJsonl([ev("A", 1, { eventId: shared }), ev("A", 2)]).jsonl;
    const clientB = exportJsonl([ev("B", 1, { eventId: shared })]).jsonl;
    const merged = mergeJsonl(clientA, clientB, "not json\n");
    expect(merged).toMatchObject({ unique: 2, duplicates: 1, invalid: 1 });
  });
});
