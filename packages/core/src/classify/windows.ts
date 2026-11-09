/**
 * Classification windows (T11). Core decides them, the model never does: segments of all speakers
 * are put on the session timeline and cut into windows of about 20-30 minutes, preferring the
 * largest pause. Every segment is in exactly one window's core region. Neighbouring segments go
 * along as read-only context, so a window boundary does not lose the thread of a scene.
 */
import type { TranscriptionSegment } from '@sargas-recap/contracts';

const MINUTE = 60_000;

export interface WindowParams {
  readonly minMs: number;
  readonly targetMs: number;
  readonly maxMs: number;
  /** Bounds a dense window, whose output could otherwise outgrow one model response. */
  readonly maxSegments: number;
  readonly contextMs: number;
  readonly maxContextSegments: number;
}

export const DEFAULT_WINDOW_PARAMS: WindowParams = Object.freeze({
  minMs: 20 * MINUTE,
  targetMs: 25 * MINUTE,
  maxMs: 30 * MINUTE,
  maxSegments: 600,
  contextMs: 2 * MINUTE,
  maxContextSegments: 20,
});

export interface ClassificationWindow {
  readonly index: number;
  /** Classified here, and nowhere else. */
  readonly core: readonly TranscriptionSegment[];
  readonly contextBefore: readonly TranscriptionSegment[];
  readonly contextAfter: readonly TranscriptionSegment[];
}

/** Session-timeline order. `chunk_index` and `seq` make it total, so windows are reproducible. */
export function orderSegments(segments: readonly TranscriptionSegment[]): TranscriptionSegment[] {
  return [...segments].sort(
    (a, b) =>
      a.start_offset_ms - b.start_offset_ms ||
      a.end_offset_ms - b.end_offset_ms ||
      a.chunk_index - b.chunk_index ||
      a.seq - b.seq,
  );
}

function at(ordered: readonly TranscriptionSegment[], index: number): TranscriptionSegment {
  const segment = ordered[index];
  if (segment === undefined) throw new RangeError(`no segment at index ${String(index)}`);
  return segment;
}

/** Where the window starting at `first` ends (exclusive). */
function cutAfter(
  ordered: readonly TranscriptionSegment[],
  first: number,
  params: WindowParams,
): number {
  const startMs = at(ordered, first).start_offset_ms;
  let limit = first + 1;
  while (
    limit < ordered.length &&
    limit - first < params.maxSegments &&
    at(ordered, limit).start_offset_ms - startMs <= params.maxMs
  ) {
    limit += 1;
  }
  if (limit === ordered.length) return limit;

  let best = limit;
  let bestGap = -Infinity;
  let bestDistance = Infinity;
  let lastEnd = -Infinity;
  for (let cut = first + 1; cut <= limit; cut += 1) {
    lastEnd = Math.max(lastEnd, at(ordered, cut - 1).end_offset_ms);
    const next = at(ordered, cut).start_offset_ms;
    const elapsed = next - startMs;
    if (elapsed < params.minMs) continue;
    const gap = next - lastEnd;
    const distance = Math.abs(elapsed - params.targetMs);
    if (gap > bestGap || (gap === bestGap && distance < bestDistance)) {
      best = cut;
      bestGap = gap;
      bestDistance = distance;
    }
  }
  return best;
}

export function planWindows(
  segments: readonly TranscriptionSegment[],
  params: WindowParams = DEFAULT_WINDOW_PARAMS,
): ClassificationWindow[] {
  const ordered = orderSegments(segments);
  const windows: ClassificationWindow[] = [];
  let first = 0;
  while (first < ordered.length) {
    const end = cutAfter(ordered, first, params);
    const core = ordered.slice(first, end);
    const startMs = at(ordered, first).start_offset_ms;
    const endMs = Math.max(...core.map((segment) => segment.end_offset_ms));
    const before = ordered
      .slice(0, first)
      .filter((segment) => segment.end_offset_ms >= startMs - params.contextMs);
    const after = ordered
      .slice(end)
      .filter((segment) => segment.start_offset_ms <= endMs + params.contextMs);
    windows.push({
      index: windows.length,
      core,
      contextBefore: before.slice(-params.maxContextSegments),
      contextAfter: after.slice(0, params.maxContextSegments),
    });
    first = end;
  }
  return windows;
}

/** Everyone whose words are in the window's prompt: the consent check covers exactly these. */
export function windowSpeakers(window: ClassificationWindow): string[] {
  const all = [...window.contextBefore, ...window.core, ...window.contextAfter];
  return [...new Set(all.map((segment) => segment.speaker_id))].sort();
}

/** The short form of a segment ID shown to the model; the run prefix is the same for all. */
export function segmentRef(segment: Pick<TranscriptionSegment, 'chunk_index' | 'seq'>): string {
  return `${String(segment.chunk_index)}:${String(segment.seq)}`;
}

function promptLine(segment: TranscriptionSegment): string {
  const uncertain =
    segment.flags.includes('low_confidence') || segment.flags.includes('repetition_loop');
  return JSON.stringify({
    ref: segmentRef(segment),
    speaker: segment.speaker_id,
    start_s: Math.max(0, Math.floor(segment.start_offset_ms / 1000)),
    text: segment.text_original,
    ...(uncertain ? { asr_uncertain: true } : {}),
  });
}

function promptLines(segments: readonly TranscriptionSegment[]): string {
  return segments.map(promptLine).join('\n');
}

/** Values for the prompt's data slots, one JSON object per line so text cannot fake a line. */
export function windowData(
  window: ClassificationWindow,
): Record<'context_before' | 'segments' | 'context_after', string> {
  return {
    context_before: promptLines(window.contextBefore),
    segments: promptLines(window.core),
    context_after: promptLines(window.contextAfter),
  };
}
