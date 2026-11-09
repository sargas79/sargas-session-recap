/**
 * From whisper output to `transcription-segment` records (T09). Pure. Times come back from whisper
 * relative to the chunk audio and are mapped to the session through the T08 map (ADR-003).
 *
 * Nothing the model said is dropped for being doubtful: bad times are clamped and flagged, short
 * or uncertain segments and repetition loops are flagged. Only segments with no text at all are
 * left out, since the contract has nothing to hold; the raw file still shows them.
 */
import {
  sha256Utf8,
  type AsrParams,
  type ChunkPlanChunk,
  type TranscriptionSegment,
} from '@sargas-recap/contracts';
import { mapChunkInterval } from './chunk-map.ts';
import { findRepetitionLoops, wordsOf } from './repetition.ts';
import type { WhisperSegment, WhisperToken } from './whisper-json.ts';

/** whisper.cpp reports times in 10 ms units; mapped uncertainty cannot be finer than that. */
export const WHISPER_TIME_RESOLUTION_MS = 10;

/** `text_original` limit in the contract. */
const MAX_TEXT_LENGTH = 20_000;

export type SegmentFlag = TranscriptionSegment['flags'][number];

export interface NormalizedTiming {
  readonly startMs: number;
  readonly endMs: number;
  /** True when a reported time was unusable or out of range and had to change. */
  readonly clamped: boolean;
}

/**
 * Makes the reported times usable: each start at or after the previous start, each end at or after
 * its start, everything inside the chunk. Overlap between neighbors is whisper's own and stays.
 */
export function normalizeTimings(
  segments: readonly Pick<WhisperSegment, 'fromMs' | 'toMs'>[],
  durationMs: number,
): NormalizedTiming[] {
  let previousStart = 0;
  let previousEnd = 0;
  return segments.map((segment) => {
    const reportedStart = segment.fromMs ?? Math.max(previousStart, previousEnd);
    const startMs = Math.min(Math.max(reportedStart, previousStart), durationMs);
    const reportedEnd = segment.toMs ?? startMs;
    const endMs = Math.min(Math.max(reportedEnd, startMs), durationMs);
    const clamped = segment.fromMs !== startMs || segment.toMs !== endMs;
    previousStart = startMs;
    previousEnd = endMs;
    return { startMs, endMs, clamped };
  });
}

interface Confidence {
  readonly meanPermille: number;
  readonly minPermille: number;
}

function confidenceOf(tokens: readonly WhisperToken[]): Confidence | undefined {
  const probabilities = tokens.flatMap((token) =>
    token.special || token.text.trim() === '' || token.probability === undefined
      ? []
      : [token.probability],
  );
  if (probabilities.length === 0) return undefined;
  const toPermille = (p: number): number => Math.min(1000, Math.max(0, Math.round(p * 1000)));
  const sum = probabilities.reduce((total, p) => total + p, 0);
  return {
    meanPermille: toPermille(sum / probabilities.length),
    minPermille: toPermille(Math.min(...probabilities)),
  };
}

export interface BuildSegmentsInput {
  readonly transcriptionRunId: string;
  readonly chunk: ChunkPlanChunk;
  readonly segments: readonly WhisperSegment[];
  readonly language: string;
  readonly params: AsrParams;
}

/** A segment too long for the contract; whisper never produces one in normal operation. */
export class SegmentTooLongError extends Error {
  constructor(chunkIndex: number, seq: number) {
    super(`chunk ${String(chunkIndex)} segment ${String(seq)} exceeds the text length limit`);
    this.name = 'SegmentTooLongError';
  }
}

/** One chunk's segments. Flags are in contract order. Repetition loops are flagged later. */
export function buildChunkSegments(input: BuildSegmentsInput): TranscriptionSegment[] {
  const { chunk, params, language, transcriptionRunId } = input;
  const spoken = input.segments
    .map((segment) => ({ segment, text: segment.text.trim() }))
    .filter(({ text }) => text !== '');
  const timings = normalizeTimings(
    spoken.map(({ segment }) => segment),
    chunk.duration_ms,
  );
  return spoken.map(({ segment, text }, seq): TranscriptionSegment => {
    if (text.length > MAX_TEXT_LENGTH) throw new SegmentTooLongError(chunk.chunk_index, seq);
    const timing = timings[seq];
    if (timing === undefined) throw new RangeError('timing index out of range');
    const mapped = mapChunkInterval(chunk, timing.startMs, timing.endMs);
    const confidence = confidenceOf(segment.tokens);
    const flags: SegmentFlag[] = [];
    if (timing.endMs - timing.startMs < params.short_segment_ms) flags.push('short');
    if (
      confidence !== undefined &&
      (confidence.meanPermille < params.low_confidence_mean_permille ||
        confidence.minPermille < params.low_confidence_min_permille)
    ) {
      flags.push('low_confidence');
    }
    if (timing.clamped) flags.push('timestamp_clamped');
    return {
      schema_version: 1,
      transcription_run_id: transcriptionRunId,
      segment_id: `${transcriptionRunId}:${String(chunk.chunk_index)}:${String(seq)}`,
      chunk_index: chunk.chunk_index,
      seq,
      speaker_id: chunk.speaker_id,
      language,
      text_original: text,
      text_hash: sha256Utf8(text.normalize('NFC')),
      start_offset_ms: mapped.start.sessionOffsetMs,
      end_offset_ms: mapped.end.sessionOffsetMs,
      timing_uncertainty_ms: mapped.timingUncertaintyMs + WHISPER_TIME_RESOLUTION_MS,
      chunk_start_ms: timing.startMs,
      chunk_end_ms: timing.endMs,
      source_spans: mapped.sourceSpans.map((span) => ({ ...span })),
      ...(confidence === undefined ? {} : { confidence_permille: confidence.meanPermille }),
      flags,
    };
  });
}

/**
 * Adds `repetition_loop` to every segment holding a word of a loop. Runs per speaker across chunk
 * boundaries, so a loop that a chunk split in two is still one loop. Returns segments in input order.
 */
export function flagRepetitionLoops(
  segments: readonly TranscriptionSegment[],
  params: AsrParams,
): { readonly segments: TranscriptionSegment[]; readonly loops: number } {
  const bySpeaker = new Map<string, number[]>();
  segments.forEach((segment, index) => {
    const indices = bySpeaker.get(segment.speaker_id) ?? [];
    indices.push(index);
    bySpeaker.set(segment.speaker_id, indices);
  });
  const flagged = new Set<number>();
  let loops = 0;
  for (const indices of bySpeaker.values()) {
    const words: string[] = [];
    const owners: number[] = [];
    for (const index of indices) {
      for (const word of wordsOf(segments[index]?.text_original ?? '')) {
        words.push(word);
        owners.push(index);
      }
    }
    const ranges = findRepetitionLoops(words, {
      minRepeats: params.repetition_min_repeats,
      minWords: params.repetition_min_words,
      maxUnitWords: params.repetition_max_unit_words,
    });
    loops += ranges.length;
    for (const range of ranges) {
      for (let i = range.start; i < range.end; i += 1) {
        const owner = owners[i];
        if (owner !== undefined) flagged.add(owner);
      }
    }
  }
  return {
    loops,
    segments: segments.map((segment, index) =>
      flagged.has(index)
        ? { ...segment, flags: [...segment.flags, 'repetition_loop' as const] }
        : segment,
    ),
  };
}
