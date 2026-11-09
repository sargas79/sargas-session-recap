/**
 * What may reach the recap prompt (T13). Built only from the effective transcript (T12): a segment
 * goes in when its effective `recap_inclusion` is `include`, and in no other case. Excluded and
 * unresolved segments are never rendered here, so their text cannot reach the provider, not even
 * as context.
 */
import type { EffectiveTranscriptReview } from '@sargas-recap/contracts';

export type ReviewSegment = EffectiveTranscriptReview['segments'][number];

/**
 * Evidence the model was shown. Every citation is checked against this, never against the
 * transcript as a whole.
 */
export interface RecapEvidence {
  /** `<chunk>:<seq>` ref shown to the model -> full segment ID. */
  readonly segmentIdByRef: ReadonlyMap<string, string>;
  /**
   * Foundry event IDs shown to the model. Always empty for now: `foundry.jsonl` holds raw,
   * system-specific payloads with no verified alignment to the transcript until T17 and T18, so
   * events are not sent and an event citation cannot pass.
   */
  readonly eventIds: ReadonlySet<string>;
}

/** Segments the recap may use, and those held back for a GM decision. */
export interface RecapInput {
  readonly included: readonly ReviewSegment[];
  readonly unresolved: readonly ReviewSegment[];
}

export function selectRecapInput(view: EffectiveTranscriptReview): RecapInput {
  return {
    included: view.segments.filter((segment) => segment.recap_inclusion === 'include'),
    unresolved: view.segments.filter((segment) => segment.recap_inclusion === 'unresolved'),
  };
}

/** The short form of a segment ID shown to the model; the run prefix is the same for all. */
export function refOf(segmentId: string): string {
  return segmentId.split(':').slice(1).join(':');
}

export function evidenceOf(included: readonly ReviewSegment[]): RecapEvidence {
  return {
    segmentIdByRef: new Map(
      included.map((segment) => [refOf(segment.segment_id), segment.segment_id]),
    ),
    eventIds: new Set<string>(),
  };
}

function promptLine(segment: ReviewSegment): string {
  const uncertain =
    segment.segment_flags.includes('low_confidence') ||
    segment.segment_flags.includes('repetition_loop');
  return JSON.stringify({
    ref: refOf(segment.segment_id),
    speaker: segment.speaker_id,
    start_s: Math.max(0, Math.floor(segment.start_offset_ms / 1000)),
    label: segment.label,
    text: segment.text,
    ...(uncertain ? { asr_uncertain: true } : {}),
  });
}

/** One JSON object per line, so segment text cannot fake a line. */
export function segmentsData(included: readonly ReviewSegment[]): string {
  return included.map(promptLine).join('\n');
}

/** Everyone whose words are in `included`: the consent check covers exactly these. */
export function speakersOf(included: readonly ReviewSegment[]): string[] {
  return [...new Set(included.map((segment) => segment.speaker_id))].sort();
}
