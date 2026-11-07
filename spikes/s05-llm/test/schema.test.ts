import { describe, expect, it } from "vitest";
import { extractStructured, parseEnvelope } from "../src/envelope.js";
import { validateClassification } from "../src/schema.js";

describe("validateClassification", () => {
  it("accepts a valid object", () => {
    const r = validateClassification({ segments: [{ id: "a", label: "rules_discussion", injection_suspected: false }] }, ["a"]);
    expect(r.valid).toBe(true);
  });

  it.each([
    ["extra property", { segments: [], extra: 1 }],
    ["bad enum", { segments: [{ id: "a", label: "nope", injection_suspected: false }] }],
    ["wrong type", { segments: [{ id: "a", label: "gm_narration", injection_suspected: "false" }] }],
    ["missing field", { segments: [{ id: "a", label: "gm_narration" }] }],
    ["not an object", "segments"],
  ])("rejects %s", (_n, v) => {
    expect(validateClassification(v).valid).toBe(false);
  });

  it("rejects duplicate and missing ids", () => {
    const r = validateClassification(
      { segments: [{ id: "a", label: "gm_narration", injection_suspected: false }, { id: "a", label: "gm_narration", injection_suspected: false }] },
      ["a", "b"],
    );
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.errors).toEqual(["duplicate segment id: a", "missing segment id: b"]);
  });
});

describe("parseEnvelope", () => {
  it("handles empty and non-object output", () => {
    expect(parseEnvelope("  ")).toMatchObject({ ok: false, reason: "empty" });
    expect(parseEnvelope("42")).toMatchObject({ ok: false, reason: "not_object" });
    expect(parseEnvelope("hello")).toMatchObject({ ok: false, reason: "not_json" });
  });

  it("treats a non-success subtype as an error", () => {
    const p = parseEnvelope(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: false }));
    expect(p.ok && p.envelope.isError).toBe(true);
  });

  it("does not strip code fences from a result string", () => {
    const p = parseEnvelope(JSON.stringify({ type: "result", subtype: "success", result: "```json\n{}\n```" }));
    expect(p.ok).toBe(true);
    if (p.ok) expect(extractStructured(p.envelope).ok).toBe(false);
  });
});
