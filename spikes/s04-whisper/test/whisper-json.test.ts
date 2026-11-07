import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { segmentConfidence, summarizeConfidence, PROVISIONAL_THRESHOLDS } from "../src/confidence.ts";
import { isSpecialTokenText, parseTimestampToMs, parseWhisperJson, transcriptText } from "../src/whisper-json.ts";

const fixture = (name: string): string => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

describe("parseTimestampToMs", () => {
  it("parses SRT-style timestamps to integer ms", () => {
    expect(parseTimestampToMs("00:00:00,000")).toBe(0);
    expect(parseTimestampToMs("00:01:02,345")).toBe(62_345);
    expect(parseTimestampToMs("01:00:00.5")).toBe(3_600_500);
    expect(parseTimestampToMs("bogus")).toBeNull();
  });
});

describe("parseWhisperJson (-oj)", () => {
  const t = parseWhisperJson(fixture("whisper-oj.synthetic.json"));

  it("reads metadata", () => {
    expect(t.language).toBe("pt");
    expect(t.modelType).toBe("large");
    expect(t.modelPathParam).toBe("models/ggml-large-v3-turbo.bin");
    expect(t.hasTokens).toBe(false);
    expect(t.warnings).toEqual([]);
  });

  it("produces integer-ms segments with trimmed text", () => {
    expect(t.segments.map((s) => [s.startMs, s.endMs])).toEqual([
      [0, 3480],
      [3480, 7120],
      [7120, 10000],
    ]);
    for (const s of t.segments) {
      expect(Number.isInteger(s.startMs)).toBe(true);
      expect(Number.isInteger(s.endMs)).toBe(true);
      expect(s.tokens).toEqual([]);
    }
    expect(t.segments[0]?.text).toBe("Ok, a Kyra rola Perception para procurar armadilhas.");
  });

  it("joins transcript text", () => {
    expect(transcriptText(t)).toMatch(/^Ok, a Kyra .* porta\.$/);
  });

  it("reports unknown confidence without tokens", () => {
    const { summary } = summarizeConfidence(t);
    expect(summary.lowConfidenceUnknown).toBe(3);
    expect(summary.meanOfMeanP).toBeNull();
    expect(summary.provisional).toBe(true);
  });
});

describe("parseWhisperJson (-ojf)", () => {
  const t = parseWhisperJson(fixture("whisper-ojf.synthetic.json"));

  it("parses tokens with probabilities and offsets", () => {
    expect(t.hasTokens).toBe(true);
    const s0 = t.segments[0]!;
    expect(s0.tokens).toHaveLength(10);
    expect(s0.tokens[0]).toMatchObject({ text: "[_BEG_]", special: true, startMs: 0, endMs: 0, id: 50365 });
    expect(s0.tokens[1]).toMatchObject({ text: " O", special: false, p: 0.981, startMs: 0, endMs: 300, dtwMs: null });
    expect(s0.tokens[9]?.special).toBe(true);
  });

  it("excludes special tokens from confidence", () => {
    const c = segmentConfidence(t.segments[0]!);
    expect(c.textTokenCount).toBe(8);
    expect(c.minP).toBeCloseTo(0.874);
    expect(c.lowConfidence).toBe("no");
  });

  it("flags low-confidence segments with reasons (provisional)", () => {
    const { perSegment, summary } = summarizeConfidence(t);
    expect(perSegment.map((s) => s.lowConfidence)).toEqual(["no", "no", "yes"]);
    expect(perSegment[2]?.reasons.join(" ")).toMatch(/minP .* meanP/);
    expect(perSegment[1]?.minP).toBeCloseTo(0.412);
    expect(summary.lowConfidenceYes).toBe(1);
    expect(summary.thresholds).toEqual(PROVISIONAL_THRESHOLDS);
  });

  it("respects custom thresholds", () => {
    const c = segmentConfidence(t.segments[1]!, { minTokenP: 0.5, meanTokenP: 0.5 });
    expect(c.lowConfidence).toBe("yes");
    expect(c.lowTokenFraction).toBeCloseTo(1 / 9);
  });
});

describe("parseWhisperJson robustness", () => {
  it("falls back to timestamp strings when offsets are missing", () => {
    const t = parseWhisperJson({
      transcription: [{ timestamps: { from: "00:00:01,250", to: "00:00:02,000" }, text: " a" }],
    });
    expect(t.segments[0]).toMatchObject({ startMs: 1250, endMs: 2000, text: "a" });
    expect(t.language).toBeNull();
  });

  it("converts t_dtw centiseconds to ms", () => {
    const t = parseWhisperJson({
      transcription: [{ offsets: { from: 0, to: 100 }, text: "x", tokens: [{ text: "x", p: 0.9, t_dtw: 42, offsets: { from: 0, to: 100 } }] }],
    });
    expect(t.segments[0]?.tokens[0]?.dtwMs).toBe(420);
  });

  it("warns instead of crashing on bad segments", () => {
    const t = parseWhisperJson({
      transcription: [5, { text: "no times" }, { offsets: { from: 500, to: 100 }, text: "rev" }],
    });
    expect(t.segments).toHaveLength(1);
    expect(t.warnings).toHaveLength(3);
    expect(t.warnings.join("\n")).toMatch(/end \(100\) < start \(500\)/);
  });

  it("rejects input without transcription", () => {
    expect(() => parseWhisperJson("{}")).toThrow(/transcription/);
    expect(() => parseWhisperJson("[]")).toThrow(/root/);
  });

  it("recognises special token texts", () => {
    expect(isSpecialTokenText("[_BEG_]")).toBe(true);
    expect(isSpecialTokenText("[_TT_1500]")).toBe(true);
    expect(isSpecialTokenText("<|endoftext|>")).toBe(true);
    expect(isSpecialTokenText(" [música]")).toBe(false);
    expect(isSpecialTokenText(" Shield")).toBe(false);
  });
});
