/**
 * Chunk planning, ffmpeg `silencedetect` parsing and timestamp-drift
 * comparison (pure). Used by src/cli/drift.ts and src/cli/silence.ts.
 *
 * All times are integer milliseconds. Comparison is segment-granular and
 * text-matched; it is a probe for the spike, not the production chunk mapper
 * (that is T08).
 */
import { normalizeText, tokenizeWords, wordErrorRate, type ErrorRate } from "./wer.ts";

export interface Chunk {
  index: number;
  startMs: number;
  durationMs: number;
}

export interface Interval {
  startMs: number;
  endMs: number;
}

export interface TimedText {
  startMs: number;
  endMs: number;
  text: string;
}

/** Fixed-length chunks; the last one is shorter. `overlapMs` repeats audio at each boundary. */
export function planFixedChunks(totalMs: number, chunkMs: number, overlapMs = 0): Chunk[] {
  if (!Number.isInteger(totalMs) || totalMs <= 0) throw new Error("totalMs must be a positive integer");
  if (!Number.isInteger(chunkMs) || chunkMs <= 0) throw new Error("chunkMs must be a positive integer");
  if (!Number.isInteger(overlapMs) || overlapMs < 0 || overlapMs >= chunkMs) throw new Error("overlapMs must be in [0, chunkMs)");
  const chunks: Chunk[] = [];
  const step = chunkMs - overlapMs;
  for (let start = 0, i = 0; start < totalMs; start += step, i++) {
    chunks.push({ index: i, startMs: start, durationMs: Math.min(chunkMs, totalMs - start) });
    if (start + chunkMs >= totalMs) break;
  }
  return chunks;
}

/**
 * Parse ffmpeg `silencedetect` stderr lines:
 *   [silencedetect @ 0x...] silence_start: 12.345
 *   [silencedetect @ 0x...] silence_end: 14.2 | silence_duration: 1.855
 * A trailing silence_start without an end is closed at `totalMs` when given.
 */
export function parseSilencedetect(stderr: string, totalMs?: number): Interval[] {
  const out: Interval[] = [];
  let open: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const s = /silence_start:\s*(-?[0-9.]+)/.exec(line);
    if (s?.[1] !== undefined) {
      open = Math.max(0, Math.round(Number(s[1]) * 1000));
      continue;
    }
    const e = /silence_end:\s*([0-9.]+)/.exec(line);
    if (e?.[1] !== undefined) {
      const end = Math.round(Number(e[1]) * 1000);
      out.push({ startMs: open ?? 0, endMs: end });
      open = null;
    }
  }
  if (open !== null && totalMs !== undefined && totalMs > open) out.push({ startMs: open, endMs: totalMs });
  return out;
}

export interface PauseSplitOptions {
  /** Preferred chunk length; cut at the pause nearest to it. */
  targetMs: number;
  /** Never exceed; hard cut when no pause is available. */
  maxMs: number;
  /** Don't cut earlier than this into a chunk. */
  minMs: number;
}

export interface PauseChunk extends Chunk {
  /** "pause" when the end was placed in a detected silence; "hard" otherwise; "eof" for the last chunk. */
  endReason: "pause" | "hard" | "eof";
}

/**
 * Pause-aware chunk plan: each cut is placed at the midpoint of a detected
 * silence within [start+minMs, start+maxMs], preferring the one closest to
 * start+targetMs; with no candidate it hard-cuts at start+maxMs.
 * Chunks are contiguous (no audio removed) so the chunk→source map is a pure offset.
 */
export function planPauseChunks(totalMs: number, silences: readonly Interval[], o: PauseSplitOptions): PauseChunk[] {
  if (!(o.minMs > 0 && o.minMs <= o.targetMs && o.targetMs <= o.maxMs)) throw new Error("require 0 < minMs <= targetMs <= maxMs");
  const mids = silences.map((s) => Math.round((s.startMs + s.endMs) / 2)).sort((a, b) => a - b);
  const chunks: PauseChunk[] = [];
  let start = 0;
  while (start < totalMs) {
    if (totalMs - start <= o.maxMs) {
      chunks.push({ index: chunks.length, startMs: start, durationMs: totalMs - start, endReason: "eof" });
      break;
    }
    const lo = start + o.minMs;
    const hi = start + o.maxMs;
    const target = start + o.targetMs;
    let best: number | null = null;
    for (const m of mids) {
      if (m < lo || m > hi) continue;
      if (best === null || Math.abs(m - target) < Math.abs(best - target)) best = m;
    }
    const end = best ?? hi;
    chunks.push({ index: chunks.length, startMs: start, durationMs: end - start, endReason: best === null ? "hard" : "pause" });
    start = end;
  }
  return chunks;
}

export interface ChunkTranscript {
  chunk: Chunk;
  /** Segments with times LOCAL to the chunk. */
  segments: readonly TimedText[];
}

export interface SegmentIssue {
  chunkIndex: number;
  kind: "end-past-chunk" | "non-positive-length" | "non-monotonic" | "start-negative";
  detail: string;
}

export interface MatchedSegment {
  chunkIndex: number;
  globalStartMs: number;
  globalEndMs: number;
  fullStartMs: number;
  fullEndMs: number;
  deltaStartMs: number;
  deltaEndMs: number;
  nearBoundary: boolean;
  similarity: number;
}

export interface DeltaStats {
  n: number;
  meanAbsStartMs: number | null;
  meanAbsEndMs: number | null;
  maxAbsStartMs: number | null;
  maxAbsEndMs: number | null;
  p95AbsStartMs: number | null;
}

export interface BoundaryCheck {
  boundaryMs: number;
  fullText: string;
  chunkedText: string;
  wer: ErrorRate;
}

export interface DriftReport {
  chunkSegments: number;
  matched: number;
  unmatched: number;
  interior: DeltaStats;
  nearBoundary: DeltaStats;
  issues: SegmentIssue[];
  boundaries: BoundaryCheck[];
  overallWerFullVsChunked: ErrorRate;
  matches: MatchedSegment[];
  method: "segment-level, text-matched (approximate)";
}

function wordSimilarity(a: string, b: string): number {
  const wa = new Set(tokenizeWords(normalizeText(a)));
  const wb = new Set(tokenizeWords(normalizeText(b)));
  if (wa.size === 0 && wb.size === 0) return 1;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / (wa.size + wb.size - inter);
}

function overlapMs(a: Interval, b: Interval): number {
  return Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));
}

function stats(ms: MatchedSegment[]): DeltaStats {
  if (ms.length === 0) {
    return { n: 0, meanAbsStartMs: null, meanAbsEndMs: null, maxAbsStartMs: null, maxAbsEndMs: null, p95AbsStartMs: null };
  }
  const s = ms.map((m) => Math.abs(m.deltaStartMs));
  const e = ms.map((m) => Math.abs(m.deltaEndMs));
  const sorted = [...s].sort((a, b) => a - b);
  const mean = (xs: number[]): number => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
  return {
    n: ms.length,
    meanAbsStartMs: mean(s),
    meanAbsEndMs: mean(e),
    maxAbsStartMs: Math.max(...s),
    maxAbsEndMs: Math.max(...e),
    p95AbsStartMs: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? null,
  };
}

function textInWindow(segs: readonly TimedText[], w: Interval): string {
  return segs
    .filter((s) => overlapMs(s, w) > 0 || (s.startMs >= w.startMs && s.startMs < w.endMs))
    .map((s) => s.text)
    .join(" ");
}

/**
 * Compare a full-file transcript against per-chunk transcripts of the same audio.
 * Detects: timestamp offsets between the two runs, segments that end past
 * their chunk, non-monotonic/zero-length segments, and word differences in a
 * window around each chunk boundary (cut, dropped or duplicated words).
 */
export function compareTimelines(
  full: readonly TimedText[],
  chunked: readonly ChunkTranscript[],
  opts: { boundaryWindowMs?: number; minSimilarity?: number; endToleranceMs?: number } = {},
): DriftReport {
  const win = opts.boundaryWindowMs ?? 2000;
  const minSim = opts.minSimilarity ?? 0.5;
  const tol = opts.endToleranceMs ?? 200;
  const issues: SegmentIssue[] = [];
  const global: (TimedText & { chunkIndex: number })[] = [];
  const boundaries = chunked.slice(1).map((c) => c.chunk.startMs);

  for (const ct of chunked) {
    let prevStart = -Infinity;
    for (const s of ct.segments) {
      const ci = ct.chunk.index;
      if (s.startMs < 0) issues.push({ chunkIndex: ci, kind: "start-negative", detail: `start ${s.startMs}` });
      if (s.endMs <= s.startMs) issues.push({ chunkIndex: ci, kind: "non-positive-length", detail: `${s.startMs}-${s.endMs}` });
      if (s.startMs < prevStart) issues.push({ chunkIndex: ci, kind: "non-monotonic", detail: `start ${s.startMs} < previous ${prevStart}` });
      if (s.endMs > ct.chunk.durationMs + tol) {
        issues.push({ chunkIndex: ci, kind: "end-past-chunk", detail: `end ${s.endMs} > chunk duration ${ct.chunk.durationMs}` });
      }
      prevStart = s.startMs;
      global.push({ chunkIndex: ci, text: s.text, startMs: s.startMs + ct.chunk.startMs, endMs: s.endMs + ct.chunk.startMs });
    }
  }

  const matches: MatchedSegment[] = [];
  let unmatched = 0;
  for (const g of global) {
    let best: { seg: TimedText; sim: number; ov: number } | null = null;
    for (const f of full) {
      const ov = overlapMs(g, f);
      const near = Math.abs(g.startMs - f.startMs) <= 5000;
      if (ov === 0 && !near) continue;
      const sim = wordSimilarity(g.text, f.text);
      if (sim < minSim) continue;
      if (!best || sim > best.sim || (sim === best.sim && ov > best.ov)) best = { seg: f, sim, ov };
    }
    if (!best) {
      unmatched++;
      continue;
    }
    const nearBoundary = boundaries.some((b) => Math.abs(g.startMs - b) <= win || Math.abs(g.endMs - b) <= win);
    matches.push({
      chunkIndex: g.chunkIndex,
      globalStartMs: g.startMs,
      globalEndMs: g.endMs,
      fullStartMs: best.seg.startMs,
      fullEndMs: best.seg.endMs,
      deltaStartMs: g.startMs - best.seg.startMs,
      deltaEndMs: g.endMs - best.seg.endMs,
      nearBoundary,
      similarity: best.sim,
    });
  }

  const boundaryChecks: BoundaryCheck[] = boundaries.map((b) => {
    const w = { startMs: b - win, endMs: b + win };
    const fullText = textInWindow(full, w);
    const chunkedText = textInWindow(global, w);
    return { boundaryMs: b, fullText, chunkedText, wer: wordErrorRate(fullText, chunkedText) };
  });

  return {
    chunkSegments: global.length,
    matched: matches.length,
    unmatched,
    interior: stats(matches.filter((m) => !m.nearBoundary)),
    nearBoundary: stats(matches.filter((m) => m.nearBoundary)),
    issues,
    boundaries: boundaryChecks,
    overallWerFullVsChunked: wordErrorRate(full.map((s) => s.text).join(" "), global.map((s) => s.text).join(" ")),
    matches,
    method: "segment-level, text-matched (approximate)",
  };
}
