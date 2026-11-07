import { describe, expect, it } from "vitest";
import { compareTimelines, parseSilencedetect, planFixedChunks, planPauseChunks, type TimedText } from "../src/drift.ts";

describe("planFixedChunks", () => {
  it("covers the file contiguously without overlap", () => {
    const c = planFixedChunks(65_000, 30_000);
    expect(c).toEqual([
      { index: 0, startMs: 0, durationMs: 30_000 },
      { index: 1, startMs: 30_000, durationMs: 30_000 },
      { index: 2, startMs: 60_000, durationMs: 5000 },
    ]);
  });
  it("supports overlap", () => {
    const c = planFixedChunks(50_000, 30_000, 5000);
    expect(c.map((x) => [x.startMs, x.durationMs])).toEqual([
      [0, 30_000],
      [25_000, 25_000],
    ]);
  });
  it("handles exact multiples and short files", () => {
    expect(planFixedChunks(60_000, 30_000)).toHaveLength(2);
    expect(planFixedChunks(1000, 30_000)).toEqual([{ index: 0, startMs: 0, durationMs: 1000 }]);
  });
  it("validates inputs", () => {
    expect(() => planFixedChunks(0, 1000)).toThrow();
    expect(() => planFixedChunks(1000, 1000, 1000)).toThrow();
  });
});

describe("parseSilencedetect", () => {
  it("parses ffmpeg silencedetect output (synthetic lines)", () => {
    const stderr = [
      "[silencedetect @ 0000020a] silence_start: 0",
      "[silencedetect @ 0000020a] silence_end: 1.2 | silence_duration: 1.2",
      "size=N/A time=00:00:10.00 bitrate=N/A speed= 500x",
      "[silencedetect @ 0000020a] silence_start: 12.3456",
      "[silencedetect @ 0000020a] silence_end: 13.001 | silence_duration: 0.6554",
      "[silencedetect @ 0000020a] silence_start: 58.5",
    ].join("\r\n");
    expect(parseSilencedetect(stderr, 60_000)).toEqual([
      { startMs: 0, endMs: 1200 },
      { startMs: 12_346, endMs: 13_001 },
      { startMs: 58_500, endMs: 60_000 },
    ]);
    expect(parseSilencedetect(stderr)).toHaveLength(2);
  });
});

describe("planPauseChunks", () => {
  const opts = { targetMs: 25_000, maxMs: 30_000, minMs: 10_000 };
  it("cuts at the pause midpoint closest to the target", () => {
    const silences = [
      { startMs: 12_000, endMs: 13_000 }, // mid 12500
      { startMs: 23_000, endMs: 24_000 }, // mid 23500 <- closest to 25000
      { startMs: 50_000, endMs: 51_000 }, // mid 50500
    ];
    const plan = planPauseChunks(70_000, silences, opts);
    expect(plan.map((c) => [c.startMs, c.durationMs, c.endReason])).toEqual([
      [0, 23_500, "pause"],
      [23_500, 27_000, "pause"],
      [50_500, 19_500, "eof"],
    ]);
  });
  it("hard-cuts at maxMs when no pause is available", () => {
    const plan = planPauseChunks(65_000, [], opts);
    expect(plan.map((c) => [c.startMs, c.durationMs, c.endReason])).toEqual([
      [0, 30_000, "hard"],
      [30_000, 30_000, "hard"],
      [60_000, 5000, "eof"],
    ]);
  });
  it("chunks are contiguous and cover the file", () => {
    const plan = planPauseChunks(200_000, [{ startMs: 40_000, endMs: 41_000 }, { startMs: 90_000, endMs: 92_000 }], opts);
    let pos = 0;
    for (const c of plan) {
      expect(c.startMs).toBe(pos);
      expect(c.durationMs).toBeLessThanOrEqual(opts.maxMs);
      pos += c.durationMs;
    }
    expect(pos).toBe(200_000);
  });
  it("validates options", () => {
    expect(() => planPauseChunks(1000, [], { targetMs: 10, maxMs: 5, minMs: 1 })).toThrow();
  });
});

describe("compareTimelines", () => {
  const full: TimedText[] = [
    { startMs: 0, endMs: 4000, text: "a Kyra rola Perception" },
    { startMs: 4000, endMs: 9000, text: "deu vinte e dois critical success" },
    { startMs: 9000, endMs: 14000, text: "ela encontra o goblin escondido" },
    { startMs: 14000, endMs: 19000, text: "atrás da porta de madeira" },
  ];

  it("reports zero drift when chunked output matches", () => {
    const r = compareTimelines(full, [
      { chunk: { index: 0, startMs: 0, durationMs: 9000 }, segments: full.slice(0, 2) },
      {
        chunk: { index: 1, startMs: 9000, durationMs: 10_000 },
        segments: full.slice(2).map((s) => ({ ...s, startMs: s.startMs - 9000, endMs: s.endMs - 9000 })),
      },
    ]);
    expect(r.matched).toBe(4);
    expect(r.unmatched).toBe(0);
    expect(r.interior.meanAbsStartMs ?? 0).toBe(0);
    expect(r.nearBoundary.maxAbsStartMs).toBe(0);
    expect(r.issues).toEqual([]);
    expect(r.overallWerFullVsChunked.rate).toBe(0);
    expect(r.boundaries).toHaveLength(1);
    expect(r.boundaries[0]?.wer.rate).toBe(0);
  });

  it("measures offsets, boundary word loss and invalid timestamps", () => {
    const r = compareTimelines(
      full,
      [
        {
          chunk: { index: 0, startMs: 0, durationMs: 10_000 },
          segments: [
            { startMs: 200, endMs: 4100, text: "a Kyra rola Perception" },
            { startMs: 4100, endMs: 10_600, text: "deu vinte e dois critical success ela" }, // runs past chunk end
          ],
        },
        {
          chunk: { index: 1, startMs: 10_000, durationMs: 9000 },
          segments: [
            { startMs: 0, endMs: 4000, text: "goblin escondido" }, // lost "encontra o"
            { startMs: 3500, endMs: 3400, text: "atrás da porta de madeira" }, // reversed + non-monotonic? no: 3500 > 0
          ],
        },
      ],
      { boundaryWindowMs: 2000 },
    );
    expect(r.issues.map((i) => i.kind).sort()).toEqual(["end-past-chunk", "non-positive-length"]);
    const first = r.matches.find((m) => m.fullStartMs === 0)!;
    expect(first.deltaStartMs).toBe(200);
    expect(first.nearBoundary).toBe(false);
    expect(r.nearBoundary.n).toBeGreaterThan(0);
    expect(r.boundaries[0]?.wer.rate).toBeGreaterThan(0);
    expect(r.overallWerFullVsChunked.rate).toBeGreaterThan(0);
    expect(r.method).toMatch(/approximate/);
  });

  it("flags non-monotonic segment starts", () => {
    const r = compareTimelines(full, [
      {
        chunk: { index: 0, startMs: 0, durationMs: 20_000 },
        segments: [
          { startMs: 5000, endMs: 6000, text: "x" },
          { startMs: 1000, endMs: 2000, text: "y" },
        ],
      },
    ]);
    expect(r.issues.map((i) => i.kind)).toContain("non-monotonic");
    expect(r.unmatched).toBe(2);
  });
});
