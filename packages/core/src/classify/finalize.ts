/**
 * Turns one window's model output into finished records (T11). Evidence validation lives here: a
 * problem fails the attempt and costs one of the window's retries. Problem texts name refs and
 * contract paths only, never transcript words.
 */
import {
  CLASSIFICATION_FLAGS,
  validateContract,
  type ClassificationCorrectionsReport,
  type ClassificationModelResult,
  type ClassificationResult,
  type TranscriptionSegment,
} from '@sargas-recap/contracts';
import { applyCorrections, type GlossarySpellings } from './corrections.ts';
import { segmentRef, type ClassificationWindow } from './windows.ts';

export interface RunIdentity {
  readonly classificationRunId: string;
  readonly transcriptionRunId: string;
}

export interface FinishedWindow {
  readonly records: readonly ClassificationResult[];
  readonly fixed: ClassificationCorrectionsReport['fixed'];
  readonly unmatched: ClassificationCorrectionsReport['unmatched'];
  readonly rejected: ClassificationCorrectionsReport['rejected'];
}

export type FinalizeOutcome =
  | { readonly ok: true; readonly window: FinishedWindow }
  | { readonly ok: false; readonly problems: readonly string[] };

type Flag = ClassificationResult['flags'][number];

function identityProblems(
  window: ClassificationWindow,
  output: readonly ClassificationModelResult[],
): string[] {
  const core = new Set(window.core.map(segmentRef));
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const { segment_ref: ref } of output) {
    if (!core.has(ref)) problems.push(`segment_ref ${ref} is not in this window's core region`);
    else if (seen.has(ref)) problems.push(`segment_ref ${ref} appears more than once`);
    seen.add(ref);
  }
  for (const ref of core) if (!seen.has(ref)) problems.push(`segment_ref ${ref} is missing`);
  return problems;
}

/** A name the model reports must actually be in the segment; anything else is dropped. */
function namesInText(names: readonly string[], text: string): string[] {
  const haystack = text.toLowerCase();
  return [...new Set(names)].filter((name) => haystack.includes(name.toLowerCase()));
}

function flagsFor(segment: TranscriptionSegment, names: boolean, spoiler: boolean): Flag[] {
  const asrDoubt =
    segment.flags.includes('low_confidence') || segment.flags.includes('repetition_loop');
  const set = new Set<Flag>();
  if (names) set.add('names_unmatched');
  if (asrDoubt) set.add('low_asr_confidence');
  if (spoiler) set.add('possible_spoiler');
  return CLASSIFICATION_FLAGS.filter((flag) => set.has(flag));
}

export function finalizeWindow(
  window: ClassificationWindow,
  output: readonly ClassificationModelResult[],
  identity: RunIdentity,
  spellings: GlossarySpellings,
): FinalizeOutcome {
  const problems = identityProblems(window, output);
  if (problems.length > 0) return { ok: false, problems };

  const byRef = new Map(output.map((item) => [item.segment_ref, item]));
  const records: ClassificationResult[] = [];
  const finished: Pick<FinishedWindow, 'fixed' | 'unmatched' | 'rejected'> = {
    fixed: [],
    unmatched: [],
    rejected: [],
  };
  for (const segment of window.core) {
    const item = byRef.get(segmentRef(segment));
    if (item === undefined) throw new Error('window output changed during finalization');
    const segmentId = segment.segment_id;
    const outcome = applyCorrections(segment.text_original, item.corrections, spellings);
    const names = namesInText(item.unmatched_names, segment.text_original);
    finished.fixed.push(...outcome.applied.map((c) => ({ segment_id: segmentId, ...c })));
    finished.rejected.push(
      ...outcome.rejected.map(({ correction, reason }) => ({
        segment_id: segmentId,
        ...correction,
        reason,
      })),
    );
    finished.unmatched.push(...names.map((name) => ({ segment_id: segmentId, name })));
    const record: ClassificationResult = {
      schema_version: 1,
      classification_run_id: identity.classificationRunId,
      transcription_run_id: identity.transcriptionRunId,
      segment_id: segmentId,
      window_index: window.index,
      label: item.label,
      review_required:
        item.label === 'mixed' ||
        item.label === 'uncertain' ||
        segment.flags.includes('repetition_loop'),
      ...(outcome.text === undefined ? {} : { text_corrected: outcome.text }),
      corrections: [...outcome.applied],
      event_ids: [],
      flags: flagsFor(segment, names.length > 0, item.possible_spoiler),
    };
    const checked = validateContract('classification-result', record);
    if (!checked.ok) {
      problems.push(
        ...checked.errors.map(
          (issue) => `segment_ref ${segmentRef(segment)}: ${issue.path} ${issue.keyword}`,
        ),
      );
    }
    records.push(record);
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, window: { records, ...finished } };
}

/** Exactly one record per segment; the last check before a run becomes final. */
export function coverageProblems(
  segments: readonly TranscriptionSegment[],
  records: readonly ClassificationResult[],
): string[] {
  const expected = new Set(segments.map((segment) => segment.segment_id));
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const record of records) {
    if (!expected.has(record.segment_id)) problems.push(`${record.segment_id} is not in the run`);
    else if (seen.has(record.segment_id)) problems.push(`${record.segment_id} appears twice`);
    seen.add(record.segment_id);
  }
  for (const id of expected) if (!seen.has(id)) problems.push(`${id} has no result`);
  return problems;
}
