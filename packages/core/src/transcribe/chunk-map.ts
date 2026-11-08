/**
 * Reversible chunk-to-source timing maps (T08, ADR-003). Inside a piece, chunk time, fragment time
 * and session time differ by a constant, so the map is exact and invertible in integer ms.
 *
 * **Junction rule.** Pieces are half-open. A chunk time exactly at the boundary of two pieces is
 * the first millisecond of the later piece for `edge: 'start'` (the default) and the exclusive end
 * of the earlier piece for `edge: 'end'`. Segment starts use `start`, segment ends use `end`.
 * Either way the audio on the two sides of the junction is not continuous in the session, so
 * the mapped uncertainty adds the session gap between the two pieces to the larger of their
 * uncertainties: it always covers the removed pause.
 *
 * The end of the chunk is the exclusive end of the last piece for both edges.
 */
import type { ChunkPlan, ChunkPlanChunk, ChunkPlanPiece } from '@sargas-recap/contracts';
import { msToSample } from './chunk-plan.ts';
import { ChunkPlanError } from './errors.ts';

export type ChunkEdge = 'start' | 'end';

export interface ChunkTimeMapping {
  readonly chunkIndex: number;
  readonly pieceIndex: number;
  readonly fragmentId: string;
  /** Fragment time. For an `end` edge this can be the exclusive end of the piece. */
  readonly fragmentMs: number;
  /** First sample of that millisecond (the sample end of the piece at its exclusive end). */
  readonly sample: number;
  readonly sessionOffsetMs: number;
  /** At least the source fragment's uncertainty; covers the removed pause at a junction. */
  readonly timingUncertaintyMs: number;
  readonly atJunction: boolean;
}

export interface SourceSpan {
  readonly fragment_id: string;
  readonly start_sample: number;
  /** Exclusive. */
  readonly end_sample: number;
}

export interface ChunkIntervalMapping {
  readonly start: ChunkTimeMapping;
  readonly end: ChunkTimeMapping;
  /** At least one, in chunk order; one per piece the interval touches (ADR-003 `source_spans`). */
  readonly sourceSpans: readonly SourceSpan[];
  readonly timingUncertaintyMs: number;
}

export interface FragmentTimeLocation {
  readonly chunkIndex: number;
  readonly pieceIndex: number;
  readonly chunkMs: number;
}

function piece(chunk: ChunkPlanChunk, index: number): ChunkPlanPiece {
  const found = chunk.pieces[index];
  if (found === undefined) throw new RangeError('chunk piece index out of range');
  return found;
}

const pieceEnd = (p: ChunkPlanPiece): number => p.chunk_start_ms + p.duration_ms;
const pieceSessionEnd = (p: ChunkPlanPiece): number => p.session_start_offset_ms + p.duration_ms;

function checkChunkMs(chunk: ChunkPlanChunk, chunkMs: number): void {
  if (!Number.isSafeInteger(chunkMs) || chunkMs < 0 || chunkMs > chunk.duration_ms) {
    throw new ChunkPlanError(
      'CHUNK_TIME_OUT_OF_RANGE',
      `chunk ${String(chunk.chunk_index)}: time ${String(chunkMs)} is outside 0..${String(chunk.duration_ms)} ms`,
    );
  }
}

function pieceIndexAt(chunk: ChunkPlanChunk, chunkMs: number, edge: ChunkEdge): number {
  if (edge === 'start') {
    for (let i = chunk.pieces.length - 1; i > 0; i -= 1) {
      if (piece(chunk, i).chunk_start_ms <= chunkMs) return i;
    }
    return 0;
  }
  for (let i = 0; i < chunk.pieces.length - 1; i += 1) {
    if (chunkMs <= pieceEnd(piece(chunk, i))) return i;
  }
  return chunk.pieces.length - 1;
}

function junctionUncertainty(earlier: ChunkPlanPiece, later: ChunkPlanPiece): number {
  const gapMs = later.session_start_offset_ms - pieceSessionEnd(earlier);
  return Math.max(earlier.timing_uncertainty_ms, later.timing_uncertainty_ms) + gapMs;
}

/** Maps a time inside `chunk` (`0..duration_ms`, inclusive) to its source. */
export function chunkToSource(
  chunk: ChunkPlanChunk,
  chunkMs: number,
  edge: ChunkEdge = 'start',
): ChunkTimeMapping {
  checkChunkMs(chunk, chunkMs);
  const pieceIndex = pieceIndexAt(chunk, chunkMs, edge);
  const p = piece(chunk, pieceIndex);
  const delta = chunkMs - p.chunk_start_ms;
  const atEnd = delta === p.duration_ms;

  let timingUncertaintyMs = p.timing_uncertainty_ms;
  let atJunction = false;
  if (edge === 'start' && delta === 0 && pieceIndex > 0) {
    timingUncertaintyMs = junctionUncertainty(piece(chunk, pieceIndex - 1), p);
    atJunction = true;
  } else if (edge === 'end' && atEnd && pieceIndex < chunk.pieces.length - 1) {
    timingUncertaintyMs = junctionUncertainty(p, piece(chunk, pieceIndex + 1));
    atJunction = true;
  }

  const fragmentMs = p.fragment_start_ms + delta;
  return {
    chunkIndex: chunk.chunk_index,
    pieceIndex,
    fragmentId: p.fragment_id,
    fragmentMs,
    sample: atEnd
      ? p.fragment_start_sample + p.sample_length
      : msToSample(fragmentMs, p.sample_rate_hz),
    sessionOffsetMs: p.session_start_offset_ms + delta,
    timingUncertaintyMs,
    atJunction,
  };
}

/**
 * Maps `[startMs, endMs]` in chunk time: the start with the `start` edge, the end with the `end`
 * edge. A zero-length interval maps both ends with the `start` edge and has one empty span, so a
 * zero-length ASR segment is not lost.
 */
export function mapChunkInterval(
  chunk: ChunkPlanChunk,
  startMs: number,
  endMs: number,
): ChunkIntervalMapping {
  checkChunkMs(chunk, startMs);
  checkChunkMs(chunk, endMs);
  if (endMs < startMs) {
    throw new ChunkPlanError(
      'CHUNK_TIME_OUT_OF_RANGE',
      `chunk ${String(chunk.chunk_index)}: interval ends before it starts`,
    );
  }
  const start = chunkToSource(chunk, startMs, 'start');
  if (startMs === endMs) {
    return {
      start,
      end: start,
      sourceSpans: [
        { fragment_id: start.fragmentId, start_sample: start.sample, end_sample: start.sample },
      ],
      timingUncertaintyMs: start.timingUncertaintyMs,
    };
  }
  const end = chunkToSource(chunk, endMs, 'end');
  const sourceSpans: SourceSpan[] = [];
  let timingUncertaintyMs = Math.max(start.timingUncertaintyMs, end.timingUncertaintyMs);
  for (let i = start.pieceIndex; i <= end.pieceIndex; i += 1) {
    const p = piece(chunk, i);
    sourceSpans.push({
      fragment_id: p.fragment_id,
      start_sample: i === start.pieceIndex ? start.sample : p.fragment_start_sample,
      end_sample: i === end.pieceIndex ? end.sample : p.fragment_start_sample + p.sample_length,
    });
    timingUncertaintyMs = Math.max(timingUncertaintyMs, p.timing_uncertainty_ms);
  }
  return { start, end, sourceSpans, timingUncertaintyMs };
}

/**
 * The inverse of {@link chunkToSource}: where a fragment time ended up, or `undefined` if it is in
 * no chunk (inside a removed pause, or in an excluded fragment). `edge: 'end'` treats the time as
 * an exclusive end, matching `chunkToSource(chunk, t, 'end')`.
 */
export function fragmentToChunk(
  plan: Pick<ChunkPlan, 'chunks'>,
  fragmentId: string,
  fragmentMs: number,
  edge: ChunkEdge = 'start',
): FragmentTimeLocation | undefined {
  if (!Number.isSafeInteger(fragmentMs) || fragmentMs < 0) {
    throw new ChunkPlanError(
      'CHUNK_TIME_OUT_OF_RANGE',
      `fragment ${fragmentId}: time must be a non-negative integer`,
    );
  }
  for (const chunk of plan.chunks) {
    for (const [pieceIndex, p] of chunk.pieces.entries()) {
      if (p.fragment_id !== fragmentId) continue;
      const delta = fragmentMs - p.fragment_start_ms;
      const inside =
        edge === 'start'
          ? delta >= 0 && delta < p.duration_ms
          : delta > 0 && delta <= p.duration_ms;
      if (inside) {
        return { chunkIndex: chunk.chunk_index, pieceIndex, chunkMs: p.chunk_start_ms + delta };
      }
    }
  }
  return undefined;
}
