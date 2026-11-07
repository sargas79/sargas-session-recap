import { describe, expect, it } from "vitest";
import { anonymize, changedPaths, hashId } from "../src/core/anonymize.js";
import { HOOK_CANDIDATES, HOOK_CATEGORIES } from "../src/core/hook-catalog.js";
import { isDesignatedWriter, resolveWriter, writerCandidates } from "../src/core/writer.js";

describe("payload anonymization", () => {
  it("hashes Foundry ids, hides free text, keeps enum slugs and numbers", () => {
    const out = anonymize({
      _id: "AbCdEfGhIjKlMnOp",
      name: "Valeros the Fighter",
      flavor: "<b>Strike</b>",
      context: { type: "attack-roll", outcome: "criticalSuccess", dc: { value: 18 } },
      total: 27,
      ok: true,
    });
    expect(out).toEqual({
      _id: hashId("AbCdEfGhIjKlMnOp"),
      name: "<str len=19>",
      flavor: "<str len=13>",
      context: { type: "attack-roll", outcome: "criticalSuccess", dc: { value: 18 } },
      total: 27,
      ok: true,
    });
  });

  it("hashes id-like keys (e.g. ownership maps) and bounds arrays/depth", () => {
    const out = anonymize({ ownership: { AbCdEfGhIjKlMnOp: 3 }, list: Array.from({ length: 12 }, (_, i) => i) }) as Record<string, any>;
    expect(Object.keys(out.ownership)).toEqual([hashId("AbCdEfGhIjKlMnOp")]);
    expect(out.list).toHaveLength(11);
    expect(out.list[10]).toBe("<+2 more>");
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 10; i++) deep = { d: deep };
    expect(JSON.stringify(anonymize(deep))).toContain("<depth>");
  });

  it("does not keep non-slug strings even under enum keys", () => {
    expect(anonymize({ type: "has spaces in it" })).toEqual({ type: "<str len=16>" });
  });

  it("flattens update diffs into dotted paths", () => {
    expect(changedPaths({ _id: "x", system: { attributes: { hp: { value: 3 } }, quantity: 2 } })).toEqual([
      "system.attributes.hp.value",
      "system.quantity",
    ]);
  });
});

describe("designated writer", () => {
  const users = [
    { id: "p1", name: "Player", active: true, isGM: false },
    { id: "gm", name: "GM", active: true, isGM: true },
    { id: "p2", name: "Away", active: false, isGM: false },
  ];

  it("only the selected user writes; unset means nobody writes", () => {
    expect(isDesignatedWriter("gm", "gm")).toBe(true);
    expect(isDesignatedWriter("p1", "gm")).toBe(false);
    expect(isDesignatedWriter("gm", "")).toBe(false);
    expect(isDesignatedWriter(undefined, "gm")).toBe(false);
  });

  it("resolves writer status", () => {
    expect(resolveWriter("", users).status).toBe("unset");
    expect(resolveWriter("gm", users).status).toBe("active");
    expect(resolveWriter("p2", users).status).toBe("offline");
    expect(resolveWriter("zz", users).status).toBe("unknown-user");
  });

  it("offers connected users, GMs first", () => {
    expect(writerCandidates(users).map((u) => u.id)).toEqual(["gm", "p1"]);
  });
});

describe("hook catalog", () => {
  it("covers every category and marks every hook as a candidate", () => {
    for (const c of HOOK_CATEGORIES) expect(HOOK_CANDIDATES.some((h) => h.category === c)).toBe(true);
    for (const h of HOOK_CANDIDATES) expect(h.verification).toBe("candidate, verify on v14/PF2e");
  });
});
