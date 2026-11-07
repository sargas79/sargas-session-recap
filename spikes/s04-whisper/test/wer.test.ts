import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildGlossaryPrompt, countPhrase, parseGlossary, termAccuracy } from "../src/glossary.ts";
import { scoreTranscript } from "../src/score.ts";
import { charErrorRate, editCounts, normalizeText, wordErrorRate } from "../src/wer.ts";

describe("normalizeText", () => {
  it("lowercases and strips punctuation by default, keeping diacritics", () => {
    expect(normalizeText("Olá, Pessoal! É a VEZ do goblin...")).toBe("olá pessoal é a vez do goblin");
  });
  it("optionally strips diacritics", () => {
    expect(normalizeText("Ação, coração e órgão", { stripDiacritics: true })).toBe("acao coracao e orgao");
  });
  it("keeps intra-word hyphens and apostrophes", () => {
    expect(normalizeText("Flat-footed, d'água — guarda-chuva’s")).toBe("flat-footed d'água guarda-chuva's");
  });
  it("can keep case", () => {
    expect(normalizeText("Kyra", { lowercase: false })).toBe("Kyra");
  });
  it("treats NFD and NFC input the same", () => {
    expect(normalizeText("coração")).toBe(normalizeText("coração"));
  });
});

describe("editCounts / WER", () => {
  it("counts substitutions, deletions and insertions", () => {
    const c = editCounts(["a", "b", "c", "d"], ["a", "x", "c", "d", "e"]);
    expect(c).toEqual({ substitutions: 1, deletions: 0, insertions: 1, hits: 3, referenceLength: 4 });
    const d = editCounts(["a", "b", "c"], ["a", "c"]);
    expect(d).toMatchObject({ deletions: 1, substitutions: 0, insertions: 0, hits: 2 });
  });

  it("is 0 for identical text after normalisation", () => {
    expect(wordErrorRate("Deu vinte e dois!", "deu vinte e dois").rate).toBe(0);
  });

  it("counts a missing accent unless diacritics are stripped", () => {
    expect(wordErrorRate("ele é forte", "ele e forte").rate).toBeCloseTo(1 / 3);
    expect(wordErrorRate("ele é forte", "ele e forte", { stripDiacritics: true }).rate).toBe(0);
  });

  it("returns null rate for empty reference and can exceed 1", () => {
    expect(wordErrorRate("", "algo").rate).toBeNull();
    expect(wordErrorRate("a", "b c d").rate).toBe(3);
  });

  it("computes CER on normalised characters", () => {
    const r = charErrorRate("goblin", "goblim");
    expect(r.substitutions).toBe(1);
    expect(r.rate).toBeCloseTo(1 / 6);
  });
});

describe("glossary", () => {
  const g = parseGlossary(JSON.parse(readFileSync(new URL("../fixtures/glossary.example.json", import.meta.url), "utf8")));

  it("validates entries", () => {
    expect(g.entries).toHaveLength(7);
    expect(() => parseGlossary({ entries: [{ term: "" }] })).toThrow(/missing term/);
    expect(() => parseGlossary({ entries: [{ term: "x", kind: "spell" }] })).toThrow(/bad kind/);
    expect(() => parseGlossary([])).toThrow();
  });

  it("builds a prompt within the length limit and reports dropped terms", () => {
    const full = buildGlossaryPrompt(g);
    expect(full.dropped).toEqual([]);
    expect(full.prompt).toContain("Shield Block, Perception");
    const short = buildGlossaryPrompt(g, { prefix: "Termos: ", maxChars: 40 });
    expect(short.prompt.length).toBeLessThanOrEqual(40);
    expect(short.dropped.length).toBeGreaterThan(0);
    expect(short.included.length + short.dropped.length).toBe(7);
  });

  it("counts phrases without overlap", () => {
    expect(countPhrase(["a", "a", "a"], ["a", "a"])).toBe(1);
    expect(countPhrase(["shield", "block", "x", "shield", "block"], ["shield", "block"])).toBe(2);
    expect(countPhrase(["a"], [])).toBe(0);
  });

  it("computes count-based term and name accuracy, accepting aliases", () => {
    const ref = "O Valeros fica flat-footed. Ele usa Shield Block. Talvez Absalom?";
    const hyp = "O Valeros fica flat footed. Ele usa shield block. Talvez Absalão?";
    const acc = termAccuracy(ref, hyp, g);
    expect(acc.method).toBe("count-based");
    expect(acc.termAccuracy).toBe(1); // flat footed via alias, Shield Block
    expect(acc.nameAccuracy).toBe(0.5); // Valeros ok, Absalom missed
    expect(acc.overallAccuracy).toBe(0.75);
    expect(acc.perTerm.find((t) => t.term === "Absalom")).toMatchObject({ refCount: 1, hypCount: 0, hits: 0 });
    expect(acc.perTerm.find((t) => t.term === "Kyra")).toMatchObject({ refCount: 0 });
  });

  it("returns null accuracy when no glossary term occurs in the reference", () => {
    expect(termAccuracy("nada aqui", "nada aqui", g).overallAccuracy).toBeNull();
  });

  it("scoreTranscript combines WER, CER and terms", () => {
    const s = scoreTranscript("Ele é o Valeros", "ele e o valeros", g);
    expect(s.wer).toBeCloseTo(0.25);
    expect(s.werNoDiacritics).toBe(0);
    expect(s.nameAccuracy).toBe(1);
    expect(scoreTranscript("a", "a", null).termAccuracy).toBeNull();
  });
});
