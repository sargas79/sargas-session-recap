/**
 * PROVISIONAL `low_confidence` candidate signal.
 *
 * The thresholds below are placeholders chosen only so the harness can emit
 * something to look at. They are NOT calibrated. The GM must compare the flags
 * against the hand-checked excerpt (see docs/spikes/S04-whisper.md, section
 * "Timestamp and confidence findings") before any value is carried into T09.
 *
 * Only non-special tokens (i.e. real text tokens, not `[_BEG_]`, `[_TT_n]`,
 * `<|...|>`) contribute. A segment without token data yields `unknown`.
 */
import type { WhisperSegment, WhisperTranscript } from "./whisper-json.ts";

export interface ConfidenceThresholds {
  /** Flag when the lowest token probability is below this. */
  minTokenP: number;
  /** Flag when the arithmetic mean token probability is below this. */
  meanTokenP: number;
}

/** PROVISIONAL, uncalibrated. */
export const PROVISIONAL_THRESHOLDS: Readonly<ConfidenceThresholds> = Object.freeze({
  minTokenP: 0.35,
  meanTokenP: 0.7,
});

export type LowConfidence = "yes" | "no" | "unknown";

export interface SegmentConfidence {
  index: number;
  startMs: number;
  endMs: number;
  textTokenCount: number;
  meanP: number | null;
  minP: number | null;
  /** exp(mean(log p)); penalises single very-low tokens more than the mean. */
  geoMeanP: number | null;
  /** Fraction of text tokens with p below `minTokenP`. */
  lowTokenFraction: number | null;
  lowConfidence: LowConfidence;
  reasons: string[];
  provisional: true;
}

export function segmentConfidence(
  seg: WhisperSegment,
  thresholds: ConfidenceThresholds = PROVISIONAL_THRESHOLDS,
): SegmentConfidence {
  const ps = seg.tokens
    .filter((t) => !t.special && t.p !== null && t.text.trim().length > 0)
    .map((t) => t.p as number);

  const base = {
    index: seg.index,
    startMs: seg.startMs,
    endMs: seg.endMs,
    textTokenCount: ps.length,
    provisional: true as const,
  };

  if (ps.length === 0) {
    return {
      ...base,
      meanP: null,
      minP: null,
      geoMeanP: null,
      lowTokenFraction: null,
      lowConfidence: "unknown",
      reasons: ["no token probabilities (run with -ojf)"],
    };
  }

  const meanP = ps.reduce((a, b) => a + b, 0) / ps.length;
  const minP = Math.min(...ps);
  const geoMeanP = Math.exp(
    ps.reduce((a, p) => a + Math.log(Math.max(p, 1e-9)), 0) / ps.length,
  );
  const lowTokenFraction = ps.filter((p) => p < thresholds.minTokenP).length / ps.length;

  const reasons: string[] = [];
  if (minP < thresholds.minTokenP) reasons.push(`minP ${minP.toFixed(3)} < ${thresholds.minTokenP}`);
  if (meanP < thresholds.meanTokenP) reasons.push(`meanP ${meanP.toFixed(3)} < ${thresholds.meanTokenP}`);

  return {
    ...base,
    meanP,
    minP,
    geoMeanP,
    lowTokenFraction,
    lowConfidence: reasons.length > 0 ? "yes" : "no",
    reasons,
  };
}

export interface ConfidenceSummary {
  segments: number;
  lowConfidenceYes: number;
  lowConfidenceUnknown: number;
  /** Mean of per-segment meanP over segments that have token data. */
  meanOfMeanP: number | null;
  thresholds: ConfidenceThresholds;
  provisional: true;
}

export function summarizeConfidence(
  t: WhisperTranscript,
  thresholds: ConfidenceThresholds = PROVISIONAL_THRESHOLDS,
): { perSegment: SegmentConfidence[]; summary: ConfidenceSummary } {
  const perSegment = t.segments.map((s) => segmentConfidence(s, thresholds));
  const withP = perSegment.filter((s) => s.meanP !== null);
  return {
    perSegment,
    summary: {
      segments: perSegment.length,
      lowConfidenceYes: perSegment.filter((s) => s.lowConfidence === "yes").length,
      lowConfidenceUnknown: perSegment.filter((s) => s.lowConfidence === "unknown").length,
      meanOfMeanP:
        withP.length === 0
          ? null
          : withP.reduce((a, s) => a + (s.meanP as number), 0) / withP.length,
      thresholds: { ...thresholds },
      provisional: true,
    },
  };
}
