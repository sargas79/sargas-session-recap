/**
 * Everything the review screen shows, gathered from the same modules the CLI reads (T14): the
 * effective transcript and overrides (T12), the latest recap draft (T13) and Foundry events. Only
 * reads; `loadSessionReview` records reconciliation state, as `recap overrides list` does.
 */
import { readFile } from 'node:fs/promises';
import {
  validateContract,
  type EffectiveTranscriptReview,
  type FoundryEvent,
  type Recap,
} from '@sargas-recap/contracts';
import {
  FOUNDRY_FILE,
  MANIFEST_FILE,
  realPackageRoot,
  resolveInsidePackage,
} from '../package/index.ts';
import {
  generationJob,
  latestRecapRevision,
  loadEditorialView,
  loadRecapDraft,
  type RecapEditorialView,
} from '../recap/editorial.ts';
import { isRecapEditorialError } from '../recap/errors.ts';
import { overridesHash } from '../recap/recap-run.ts';
import { isReviewError } from '../review/errors.ts';
import { loadSessionReview, type SessionRef } from '../review/session.ts';
import type { StoredOverride } from '../review/store.ts';

export type ReviewSegment = EffectiveTranscriptReview['segments'][number];

/** A cue for the GM's eye. Worst first: the queue and the badges follow this order. */
export const ATTENTION_REASONS = [
  'possible_spoiler',
  'unresolved',
  'repetition_loop',
  'low_confidence',
  'spelling',
  'review_required',
] as const;
export type AttentionReason = (typeof ATTENTION_REASONS)[number];

/** Why a segment deserves a look, whatever its review status. */
export function attentionReasons(segment: ReviewSegment): AttentionReason[] {
  const reasons = new Set<AttentionReason>();
  if (segment.classification_flags.includes('possible_spoiler')) reasons.add('possible_spoiler');
  if (segment.recap_inclusion === 'unresolved') reasons.add('unresolved');
  if (segment.segment_flags.includes('repetition_loop')) reasons.add('repetition_loop');
  if (segment.segment_flags.includes('low_confidence')) reasons.add('low_confidence');
  if (segment.corrections.some((c) => c.kind === 'spelling')) reasons.add('spelling');
  if (segment.review_required) reasons.add('review_required');
  return ATTENTION_REASONS.filter((reason) => reasons.has(reason));
}

export interface QueueEntry {
  readonly segment: ReviewSegment;
  readonly reasons: readonly AttentionReason[];
}

/** Pending segments with a reason: the worst reason first, chronological within it. */
export function reviewQueue(view: EffectiveTranscriptReview): QueueEntry[] {
  const rank = (entry: QueueEntry): number =>
    ATTENTION_REASONS.indexOf(entry.reasons[0] ?? 'review_required');
  return view.segments
    .filter((segment) => segment.review_status === 'pending')
    .map((segment) => ({ segment, reasons: attentionReasons(segment) }))
    .filter((entry) => entry.reasons.length > 0)
    .sort((a, b) => rank(a) - rank(b));
}

/** Why the draft may no longer match what the GM sees. */
export type RecapStaleness = 'other-transcription' | 'corrected-since';

export interface RecapDraftView {
  readonly revision: number;
  /** The generated draft; what the GM reads and edits is `editorial.effective`. */
  readonly recap: Recap;
  readonly staleness: readonly RecapStaleness[];
  readonly editorial: RecapEditorialView;
}

export interface PlacedEvent {
  readonly event: FoundryEvent;
  /** Estimated session offset, or `null` when the package has no wall-clock origin. */
  readonly approxOffsetMs: number | null;
}

export interface FoundryEvents {
  readonly events: readonly PlacedEvent[];
  /** Lines that did not fit the contract or this session. Never shown, only counted. */
  readonly skipped: number;
  readonly originUncertaintyMs: number | null;
}

export interface ReviewScreen {
  readonly view: EffectiveTranscriptReview;
  readonly overrides: readonly StoredOverride[];
  readonly recap: RecapDraftView | null;
  /** IDs and paths only. A broken draft must not take the transcript down with it. */
  readonly recapProblem: string | null;
  readonly foundry: FoundryEvents;
}

async function loadRecap(
  ref: SessionRef,
  view: EffectiveTranscriptReview,
): Promise<RecapDraftView | null> {
  const revision = latestRecapRevision(ref);
  if (revision === undefined) return null;
  const recap = await loadRecapDraft(ref, revision);
  const recorded = generationJob(ref, revision)?.inputs.find(
    (input) => input.kind === 'overrides' && input.ref === 'effective-transcript',
  );
  const staleness: RecapStaleness[] = [];
  if (recap.transcription_run_id !== view.transcription_run_id) {
    staleness.push('other-transcription');
  }
  if (recorded !== undefined && recorded.hash !== overridesHash(view)) {
    staleness.push('corrected-since');
  }
  return {
    revision,
    recap,
    staleness,
    editorial: await loadEditorialView(ref, revision, view),
  };
}

async function readIfPresent(root: string, rel: string): Promise<string | undefined> {
  try {
    const { absolute } = await resolveInsidePackage(root, rel);
    return await readFile(absolute, 'utf8');
  } catch {
    return undefined;
  }
}

interface TimelineOrigin {
  readonly wallClockMs: number | null;
  readonly uncertaintyMs: number | null;
}

function timelineOrigin(manifestText: string | undefined): TimelineOrigin {
  const unknown = { wallClockMs: null, uncertaintyMs: null };
  if (manifestText === undefined) return unknown;
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    return unknown;
  }
  const manifest = validateContract('manifest', parsed);
  if (!manifest.ok) return unknown;
  const { origin_wall_clock_unix_ms: wallClockMs, origin_uncertainty_ms: uncertaintyMs } =
    manifest.value.timeline;
  return { wallClockMs: wallClockMs ?? null, uncertaintyMs };
}

/**
 * The Foundry events of the session, if any. Their place in the list is an estimate from the
 * capture clocks: verified alignment is T18's, and the screen says so. Nothing here feeds a recap.
 */
async function loadFoundryEvents(ref: SessionRef): Promise<FoundryEvents> {
  const none = { events: [], skipped: 0, originUncertaintyMs: null };
  let root: string;
  try {
    root = await realPackageRoot(ref.paths.sessionDir(ref.campaignId, ref.sessionId));
  } catch {
    return none;
  }
  const text = await readIfPresent(root, FOUNDRY_FILE);
  if (text === undefined) return none;
  const origin = timelineOrigin(await readIfPresent(root, MANIFEST_FILE));
  const events: PlacedEvent[] = [];
  let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    const checked = validateContract('foundry-event', parsed);
    if (
      !checked.ok ||
      checked.value.campaign_id !== ref.campaignId ||
      checked.value.session_id !== ref.sessionId
    ) {
      skipped += 1;
      continue;
    }
    events.push({
      event: checked.value,
      approxOffsetMs:
        origin.wallClockMs === null ? null : checked.value.observed_at_unix_ms - origin.wallClockMs,
    });
  }
  events.sort((a, b) => a.event.observed_at_unix_ms - b.event.observed_at_unix_ms);
  return { events, skipped, originUncertaintyMs: origin.uncertaintyMs };
}

export async function loadReviewScreen(ref: SessionRef): Promise<ReviewScreen> {
  const { view, overrides } = await loadSessionReview(ref);
  let recap: RecapDraftView | null = null;
  let recapProblem: string | null = null;
  try {
    recap = await loadRecap(ref, view);
  } catch (error) {
    if (!isReviewError(error) && !isRecapEditorialError(error)) throw error;
    recapProblem = error.message;
  }
  return { view, overrides, recap, recapProblem, foundry: await loadFoundryEvents(ref) };
}
