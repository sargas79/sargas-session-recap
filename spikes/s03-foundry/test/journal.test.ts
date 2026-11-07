import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildJournalPayload,
  gmOnlyViolations,
  IMPORT_SCHEMA,
  MAX_FILE_BYTES,
  parseImportFile,
  validateImport,
  type ImportInput,
} from "../src/core/journal.js";

const GM = "GmUserId00000001";
const fixture = (name: string) => readFileSync(join(fileURLToPath(new URL("../fixtures/", import.meta.url)), name), "utf8");

function valid(over: Partial<ImportInput> = {}): ImportInput {
  return {
    schema: IMPORT_SCHEMA,
    name: "S03 synthetic test journal",
    pages: [
      { name: "Page one", paragraphs: ["The party (synthetic) rested.", "Line A\nLine B & C"] },
      { name: "Page two", paragraphs: ["Nothing happened."] },
    ],
    ...over,
  };
}

describe("journal payload builder", () => {
  it("makes the entry and every page GM-only (default NONE, GM OWNER)", () => {
    const res = validateImport(valid());
    if (!res.ok) throw new Error(res.errors.join("; "));
    const p = buildJournalPayload(res.value, { gmUserId: GM, importedAt: "2026-01-01T00:00:00.000Z" });
    expect(p.ownership).toEqual({ default: 0, [GM]: 3 });
    expect(p.pages).toHaveLength(2);
    for (const page of p.pages) {
      expect(page.ownership).toEqual({ default: 0, [GM]: 3 });
      expect(page.type).toBe("text");
      expect(page.text.format).toBe(1);
    }
    expect(gmOnlyViolations("entry", p.ownership, [GM])).toEqual([]);
    for (const page of p.pages) expect(gmOnlyViolations("page", page.ownership, [GM])).toEqual([]);
  });

  it("does not rely on INHERIT for pages", () => {
    const res = validateImport(valid());
    if (!res.ok) throw new Error("invalid");
    const p = buildJournalPayload(res.value, { gmUserId: GM, levels: { INHERIT: -1, NONE: 0, OWNER: 3 } });
    for (const page of p.pages) expect(page.ownership.default).not.toBe(-1);
  });

  it("uses runtime ownership constants when provided", () => {
    const res = validateImport(valid());
    if (!res.ok) throw new Error("invalid");
    const p = buildJournalPayload(res.value, { gmUserId: GM, levels: { INHERIT: -10, NONE: 10, OWNER: 30 }, htmlFormat: 7 });
    expect(p.ownership).toEqual({ default: 10, [GM]: 30 });
    expect(p.pages[0]?.text.format).toBe(7);
  });

  it("escapes page text into paragraphs and records a content hash flag", () => {
    const res = validateImport(valid());
    if (!res.ok) throw new Error("invalid");
    const p = buildJournalPayload(res.value, { gmUserId: GM });
    expect(p.pages[0]?.text.content).toBe("<p>The party (synthetic) rested.</p><p>Line A<br>Line B &amp; C</p>");
    expect(p.flags["sargas-recap-spike"]).toMatchObject({ source: "s03-spike-import", schema: IMPORT_SCHEMA });
    expect(String(p.flags["sargas-recap-spike"]?.contentHash)).toMatch(/^[0-9a-f]{8}$/);
  });

  it("refuses a non-id gm user", () => {
    const res = validateImport(valid());
    if (!res.ok) throw new Error("invalid");
    expect(() => buildJournalPayload(res.value, { gmUserId: "default" })).toThrow();
  });

  it("gmOnlyViolations flags player access and non-NONE defaults", () => {
    expect(gmOnlyViolations("e", { default: 2 }, [GM])).toHaveLength(1);
    expect(gmOnlyViolations("e", { default: 0, PlayerId00000001: 1 }, [GM])).toHaveLength(1);
    expect(gmOnlyViolations("e", { default: 0, PlayerId00000001: 0, [GM]: 3 }, [GM])).toEqual([]);
    expect(gmOnlyViolations("e", undefined, [GM])).toHaveLength(1);
  });
});

describe("import validation and sanitization", () => {
  const injections: Array<[string, string]> = [
    ["script tag", "<script>alert(1)</script>"],
    ["img onerror", '<img src=x onerror="alert(1)">'],
    ["uppercase tag with spaces", "< SCRIPT >x"],
    ["closing tag", "</p>"],
    ["html comment", "<!-- x -->"],
    ["javascript url", "click javascript:alert(1)"],
    ["spaced javascript url", "java script :alert(1)"],
    ["data url", "data:text/html;base64,PHNjcmlwdD4="],
    ["event handler text", 'x onclick = "steal()"'],
    ["foundry inline roll", "[[/r 1d20]]"],
    ["foundry enricher", "@UUID[Actor.abc]{Bob}"],
    ["handlebars", "{{constructor.constructor}}"],
    ["control char", "bad\u0007bell"],
    ["bidi override", "abc\u202Edef"],
  ];

  for (const [label, text] of injections) {
    it(`rejects ${label} in paragraphs`, () => {
      const res = validateImport(valid({ pages: [{ name: "p", paragraphs: [text] }] }));
      expect(res.ok).toBe(false);
    });
  }

  it("rejects markup in entry and page names", () => {
    expect(validateImport(valid({ name: "<b>x</b>" })).ok).toBe(false);
    expect(validateImport(valid({ pages: [{ name: "<i>p</i>", paragraphs: ["ok"] }] })).ok).toBe(false);
    expect(validateImport(valid({ name: "two\nlines" })).ok).toBe(false);
  });

  it("rejects wrong schema, unknown keys and prototype keys", () => {
    expect(validateImport({ ...valid(), schema: "other" }).ok).toBe(false);
    expect(validateImport({ ...valid(), ownership: { default: 3 } }).ok).toBe(false);
    expect(parseImportFile(`{"schema":"${IMPORT_SCHEMA}","name":"n","pages":[{"name":"p","paragraphs":["x"]}],"__proto__":{"x":1}}`).ok).toBe(false);
    expect(validateImport(valid({ pages: [{ name: "p", paragraphs: ["x"], flags: {} } as never] })).ok).toBe(false);
  });

  it("rejects structural problems", () => {
    expect(validateImport(null).ok).toBe(false);
    expect(validateImport([]).ok).toBe(false);
    expect(validateImport(valid({ pages: [] })).ok).toBe(false);
    expect(validateImport(valid({ name: "   " })).ok).toBe(false);
    expect(validateImport(valid({ pages: Array.from({ length: 21 }, () => ({ name: "p", paragraphs: ["x"] })) })).ok).toBe(false);
    expect(validateImport(valid({ pages: [{ name: "p", paragraphs: ["x".repeat(4001)] }] })).ok).toBe(false);
    expect(validateImport(valid({ pages: [{ name: "p", paragraphs: [42 as never] }] })).ok).toBe(false);
  });

  it("rejects invalid JSON and oversized files before parsing", () => {
    expect(parseImportFile("{nope").ok).toBe(false);
    const big = parseImportFile(" ".repeat(MAX_FILE_BYTES + 1));
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.errors[0]).toMatch(/exceeds/);
  });

  it("accepts the committed synthetic fixture (BOM tolerated) and rejects the injection fixture", () => {
    expect(parseImportFile("\uFEFF" + fixture("test-journal.sample.json")).ok).toBe(true);
    const bad = parseImportFile(fixture("test-journal.injection.json"));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.length).toBeGreaterThanOrEqual(3);
  });

  it("allows ordinary punctuation, accents and angle-free math", () => {
    const res = validateImport(valid({ pages: [{ name: "Ação & reação", paragraphs: ["3 > 2? No: 2 < 3 is fine; a@b.c too.", "Çà va — ok!"] }] }));
    expect(res.ok).toBe(true);
  });
});
