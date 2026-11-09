/**
 * The effective transcript (T12): segments + one classification run + attached overrides, derived
 * on demand and never stored (ADR-001). Pure: everything it needs comes in as arguments.
 *
 * Text precedence is override, then corrected, then original. `text_corrected` is not trusted more
 * than that: a `spelling` correction needs no glossary backing, so the review view always carries
 * `text_original`, the corrections and which source won.
 */
import type {
  ClassificationLabel,
  ClassificationResult,
  EffectiveTranscript,
  EffectiveTranscriptReview,
  TranscriptionSegment,
} from '@sargas-recap/contracts';
import { orderSegments } from '../classify/windows.ts';
import { defaultRecapInclusion } from '../classify/recap-input.ts';
import type { RecapInclusion, StoredOverride } from './store.ts';

export type UnattachedReason = EffectiveTranscriptReview['needs_reconciliation'][number]['reason'];
type ReviewSegment = EffectiveTranscriptReview['segments'][number];

export interface ProjectionInput {
  readonly campaignId: string;
  readonly sessionId: string;
  readonly transcriptionRunId: string;
  readonly segments: readonly TranscriptionSegment[];
  readonly classification: {
    readonly runId: string;
    readonly results: readonly ClassificationResult[];
  } | null;
  readonly overrides: readonly StoredOverride[];
  readonly generatedAt: string;
}

/**
 * Why an override does not apply to this run, or `undefined` when it does. Identity only, as
 * ADR-005 requires: never timing, speaker or text similarity.
 */
export function unattachedReason(
  override: StoredOverride,
  transcriptionRunId: string,
  segments: ReadonlyMap<string, Pick<TranscriptionSegment, 'text_hash'>>,
): UnattachedReason | undefined {
  if (override.transcription_run_id !== transcriptionRunId) return 'run_changed';
  const segment = segments.get(override.segment_id);
  if (segment === undefined) return 'segment_missing';
  return segment.text_hash === override.base_text_hash ? undefined : 'text_changed';
}

function effectiveInclusion(
  label: ClassificationLabel | null,
  override: StoredOverride | undefined,
): RecapInclusion {
  // An exclusion always wins: a spoiler must not get in through an earlier `include`.
  if (override !== undefined && override.exclusion_reasons.length > 0) return 'exclude';
  if (override?.recap_inclusion != null) return override.recap_inclusion;
  if (label === null) return 'unresolved';
  // Mixed content enters only with cleaned text or an explicit inclusion (ADR-005).
  if (label === 'mixed' && override?.text_override !== undefined) return 'include';
  return defaultRecapInclusion(label);
}

function projectSegment(
  segment: TranscriptionSegment,
  result: ClassificationResult | undefined,
  override: StoredOverride | undefined,
): ReviewSegment {
  const corrected = result?.text_corrected;
  const textOverride = override?.text_override;
  const classified = result?.label ?? null;
  const label = override?.label_override ?? classified;
  const asrDoubt =
    segment.flags.includes('repetition_loop') || segment.flags.includes('low_confidence');
  return {
    segment_id: segment.segment_id,
    speaker_id: segment.speaker_id,
    start_offset_ms: segment.start_offset_ms,
    end_offset_ms: segment.end_offset_ms,
    timing_uncertainty_ms: segment.timing_uncertainty_ms,
    text: textOverride ?? corrected ?? segment.text_original,
    text_source:
      textOverride !== undefined ? 'override' : corrected !== undefined ? 'corrected' : 'original',
    label,
    label_source:
      override?.label_override !== undefined
        ? 'override'
        : classified !== null
          ? 'classification'
          : 'none',
    recap_inclusion: effectiveInclusion(label, override),
    exclusion_reasons: [...(override?.exclusion_reasons ?? [])],
    review_required: (result?.review_required ?? false) || asrDoubt,
    review_status: override?.review_status ?? 'pending',
    text_original: segment.text_original,
    text_hash: segment.text_hash,
    ...(corrected === undefined ? {} : { text_corrected: corrected }),
    ...(textOverride === undefined ? {} : { text_override: textOverride }),
    corrections: [...(result?.corrections ?? [])],
    classification_label: classified,
    segment_flags: [...segment.flags],
    classification_flags: [...(result?.flags ?? [])],
    ...(segment.confidence_permille === undefined
      ? {}
      : { confidence_permille: segment.confidence_permille }),
    ...(override === undefined ? {} : { override_id: override.override_id }),
  };
}

/** Builds the review view. Every segment of the run appears, whatever its flags or inclusion. */
export function projectEffectiveTranscript(input: ProjectionInput): EffectiveTranscriptReview {
  const byId = new Map(input.segments.map((segment) => [segment.segment_id, segment]));
  const results = new Map(
    (input.classification?.results ?? []).map((result) => [result.segment_id, result]),
  );
  const attached = new Map<string, StoredOverride>();
  const needsReconciliation: EffectiveTranscriptReview['needs_reconciliation'] = [];
  for (const override of input.overrides) {
    const reason = unattachedReason(override, input.transcriptionRunId, byId);
    if (reason === undefined) {
      attached.set(override.segment_id, override);
    } else {
      needsReconciliation.push({
        override_id: override.override_id,
        transcription_run_id: override.transcription_run_id,
        segment_id: override.segment_id,
        reason,
        exclusion_reasons: [...override.exclusion_reasons],
      });
    }
  }
  return {
    schema_version: 1,
    campaign_id: input.campaignId,
    session_id: input.sessionId,
    transcription_run_id: input.transcriptionRunId,
    classification_run_id: input.classification?.runId ?? null,
    generated_at: input.generatedAt,
    segments: orderSegments(input.segments).map((segment) =>
      projectSegment(segment, results.get(segment.segment_id), attached.get(segment.segment_id)),
    ),
    needs_reconciliation: needsReconciliation,
  };
}

/** The plain `effective-transcript` contract, without the review detail. */
export function toEffectiveTranscript(review: EffectiveTranscriptReview): EffectiveTranscript {
  return {
    schema_version: review.schema_version,
    campaign_id: review.campaign_id,
    session_id: review.session_id,
    transcription_run_id: review.transcription_run_id,
    classification_run_id: review.classification_run_id,
    generated_at: review.generated_at,
    segments: review.segments.map((segment) => ({
      segment_id: segment.segment_id,
      speaker_id: segment.speaker_id,
      start_offset_ms: segment.start_offset_ms,
      end_offset_ms: segment.end_offset_ms,
      timing_uncertainty_ms: segment.timing_uncertainty_ms,
      text: segment.text,
      text_source: segment.text_source,
      label: segment.label,
      label_source: segment.label_source,
      recap_inclusion: segment.recap_inclusion,
      exclusion_reasons: segment.exclusion_reasons,
      review_required: segment.review_required,
      review_status: segment.review_status,
    })),
    needs_reconciliation: review.needs_reconciliation.map(({ override_id, segment_id }) => ({
      override_id,
      segment_id,
    })),
  };
}

/** Lost `spoiler` or `privacy` exclusions: recap generation must refuse (ADR-005, T13). */
export function unreconciledExclusions(
  review: EffectiveTranscriptReview,
): EffectiveTranscriptReview['needs_reconciliation'] {
  return review.needs_reconciliation.filter(
    (entry) =>
      entry.exclusion_reasons.includes('spoiler') || entry.exclusion_reasons.includes('privacy'),
  );
}
