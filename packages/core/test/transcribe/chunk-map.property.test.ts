/**
 * Property tests of the chunk maps (ADR-003, plan section 5 risk 3). Seeded so CI is repeatable; the
 * generators lean towards small durations so boundaries, junctions and sub-ms tails come up often.
 */
import fc from 'fast-check';
import { validateContract, type ChunkPlan, type Fragment } from '@sargas-recap/contracts';
import { describe, expect, it } from 'vitest';
import type { SilenceInterval } from '../../src/audio/index.ts';
import {
  assertChunkPlanConsistent,
  chunkToSource,
  fragmentToChunk,
  mapChunkInterval,
  planChunks,
  sampleToMs,
  type ChunkPlanInput,
} from '../../src/transcribe/index.ts';
import { TEST_PARAMS } from './helpers.ts';

const RUNS = { numRuns: 250, seed: 20_261_108 };

const RATES = [8000, 11_025, 16_000, 22_050, 44_100, 48_000] as const;

const rawFragment = fc.record({
  rate: fc.constantFrom(...RATES),
  // Sample counts that do not land on a millisecond are common, on purpose.
  samples: fc.integer({ min: 0, max: 200_000 }),
  gapMs: fc.integer({ min: -400, max: 4000 }),
  uncertaintyMs: fc.integer({ min: 0, max: 80 }),
  pauses: fc.array(fc.tuple(fc.nat({ max: 16_000 }), fc.integer({ min: 1, max: 6000 })), {
    maxLength: 8,
  }),
});

const params = fc
  .record({
    target: fc.integer({ min: 500, max: 6000 }),
    extra: fc.integer({ min: 0, max: 3000 }),
    minChunk: fc.integer({ min: 0, max: 500 }),
    removeMin: fc.integer({ min: 200, max: 3000 }),
    padding: fc.integer({ min: 0, max: 400 }),
  })
  .map(({ target, extra, minChunk, removeMin, padding }) => ({
    ...TEST_PARAMS,
    target_chunk_ms: target,
    max_chunk_ms: target + extra,
    min_chunk_ms: minChunk,
    remove_pause_min_ms: removeMin,
    removal_padding_ms: padding,
  }));

const inputs = fc
  .record({
    speakers: fc.array(fc.array(rawFragment, { minLength: 1, maxLength: 4 }), {
      minLength: 1,
      maxLength: 3,
    }),
    params,
    start: fc.integer({ min: -5000, max: 5000 }),
  })
  .map(({ speakers, params: p, start }): ChunkPlanInput => {
    const fragments: Fragment[] = [];
    const pauses = new Map<string, readonly SilenceInterval[]>();
    speakers.forEach((list, s) => {
      const speaker = `speaker-${String(s)}`;
      let offset = start;
      list.forEach((raw, n) => {
        const id = `${speaker}:${String(n)}`;
        const duration = Math.floor((raw.samples * 1000) / raw.rate);
        fragments.push({
          schema_version: 1,
          fragment_id: id,
          speaker_id: speaker,
          track_label: speaker,
          path: `audio/${speaker}/${String(n)}.flac`,
          codec: 'flac',
          sample_rate_hz: raw.rate,
          channels: 1,
          sample_count: raw.samples,
          duration_ms: duration,
          fragment_start_offset_ms: offset,
          timing_uncertainty_ms: raw.uncertaintyMs,
          status: 'complete',
        });
        pauses.set(
          id,
          raw.pauses.map(([at, length]) => ({ startMs: at, endMs: at + length })),
        );
        offset += duration + raw.gapMs;
      });
    });
    return { fragments, pauses, params: p };
  });

/** Chunk times worth checking: the ends of every piece and their neighbors. */
function interestingTimes(chunk: ChunkPlan['chunks'][number]): number[] {
  const times = new Set([0, chunk.duration_ms]);
  for (const p of chunk.pieces) {
    for (const t of [p.chunk_start_ms, p.chunk_start_ms + p.duration_ms]) {
      for (const near of [t - 1, t, t + 1]) {
        if (near >= 0 && near <= chunk.duration_ms) times.add(near);
      }
    }
    times.add(p.chunk_start_ms + Math.floor(p.duration_ms / 2));
  }
  return [...times].sort((a, b) => a - b);
}

function expectIncreasing(values: readonly number[]): void {
  for (const [i, value] of values.entries()) {
    const previous = values[i - 1];
    if (previous !== undefined) expect(value).toBeGreaterThan(previous);
  }
}

function fragmentsById(input: ChunkPlanInput): Map<string, Fragment> {
  return new Map(input.fragments.map((f) => [f.fragment_id, f]));
}

describe('chunk plan properties', () => {
  it('builds valid, self-consistent plans', () => {
    fc.assert(
      fc.property(inputs, (input) => {
        const plan = planChunks(input);
        expect(validateContract('chunk-plan', plan).ok).toBe(true);
        assertChunkPlanConsistent(plan);
      }),
      RUNS,
    );
  });

  it('round-trips every chunk time to the right fragment and session offset', () => {
    fc.assert(
      fc.property(inputs, (input) => {
        const plan = planChunks(input);
        const fragments = fragmentsById(input);
        for (const chunk of plan.chunks) {
          for (const t of interestingTimes(chunk)) {
            if (t < chunk.duration_ms) {
              const m = chunkToSource(chunk, t, 'start');
              const f = fragments.get(m.fragmentId);
              if (f === undefined) throw new Error('unknown fragment');
              expect(f.speaker_id).toBe(chunk.speaker_id);
              expect(m.sessionOffsetMs).toBe(f.fragment_start_offset_ms + m.fragmentMs);
              expect(m.timingUncertaintyMs).toBeGreaterThanOrEqual(f.timing_uncertainty_ms);
              expect(sampleToMs(m.sample, f.sample_rate_hz)).toBe(m.fragmentMs);
              expect(m.sample).toBeLessThan(f.sample_count);
              expect(fragmentToChunk(plan, m.fragmentId, m.fragmentMs, 'start')).toEqual({
                chunkIndex: chunk.chunk_index,
                pieceIndex: m.pieceIndex,
                chunkMs: t,
              });
            }
            if (t > 0) {
              const m = chunkToSource(chunk, t, 'end');
              const f = fragments.get(m.fragmentId);
              if (f === undefined) throw new Error('unknown fragment');
              expect(m.sessionOffsetMs).toBe(f.fragment_start_offset_ms + m.fragmentMs);
              expect(fragmentToChunk(plan, m.fragmentId, m.fragmentMs, 'end')).toEqual({
                chunkIndex: chunk.chunk_index,
                pieceIndex: m.pieceIndex,
                chunkMs: t,
              });
            }
          }
        }
      }),
      RUNS,
    );
  });

  it('is strictly monotonic within a chunk, for both edges', () => {
    fc.assert(
      fc.property(inputs, (input) => {
        for (const chunk of planChunks(input).chunks) {
          const times = interestingTimes(chunk).filter((t) => t < chunk.duration_ms);
          expectIncreasing(times.map((t) => chunkToSource(chunk, t, 'start').sessionOffsetMs));
          const ends = interestingTimes(chunk).filter((t) => t > 0);
          expectIncreasing(ends.map((t) => chunkToSource(chunk, t, 'end').sessionOffsetMs));
        }
      }),
      RUNS,
    );
  });

  it('covers the removed pause in the uncertainty at every junction', () => {
    fc.assert(
      fc.property(inputs, (input) => {
        for (const chunk of planChunks(input).chunks) {
          for (let i = 1; i < chunk.pieces.length; i += 1) {
            const earlier = chunk.pieces[i - 1];
            const later = chunk.pieces[i];
            if (earlier === undefined || later === undefined) throw new Error('piece');
            const t = later.chunk_start_ms;
            const gap =
              later.session_start_offset_ms -
              (earlier.session_start_offset_ms + earlier.duration_ms);
            expect(gap).toBeGreaterThanOrEqual(0);
            const atStart = chunkToSource(chunk, t, 'start');
            const atEnd = chunkToSource(chunk, t, 'end');
            expect(atStart.atJunction).toBe(true);
            expect(atEnd.atJunction).toBe(true);
            const floor =
              gap + Math.max(earlier.timing_uncertainty_ms, later.timing_uncertainty_ms);
            expect(atStart.timingUncertaintyMs).toBe(floor);
            expect(atEnd.timingUncertaintyMs).toBe(floor);
            expect(atStart.fragmentId).toBe(later.fragment_id);
            expect(atEnd.fragmentId).toBe(earlier.fragment_id);
          }
        }
      }),
      RUNS,
    );
  });

  it('loses nothing: every ms is in exactly one piece or inside a removed pause', () => {
    fc.assert(
      fc.property(inputs, (input) => {
        const plan = planChunks(input);
        const excluded = new Set(plan.excluded_fragments.map((e) => e.fragment_id));
        for (const fragment of input.fragments) {
          if (excluded.has(fragment.fragment_id)) continue;
          const removedPauses = plan.pauses.filter(
            (p) => p.fragment_id === fragment.fragment_id && p.disposition === 'removed',
          );
          for (let ms = 0; ms < fragment.duration_ms; ms += 1) {
            const inRemoved = removedPauses.some((p) => ms >= p.start_ms && ms < p.end_ms);
            const located = fragmentToChunk(plan, fragment.fragment_id, ms, 'start');
            if (located === undefined) {
              expect(inRemoved).toBe(true);
            }
          }
        }
        // No millisecond of a fragment is in two pieces.
        const seen = new Set<string>();
        for (const chunk of plan.chunks) {
          for (const piece of chunk.pieces) {
            for (let d = 0; d < piece.duration_ms; d += 1) {
              const key = `${piece.fragment_id}@${String(piece.fragment_start_ms + d)}`;
              expect(seen.has(key)).toBe(false);
              seen.add(key);
            }
          }
        }
      }),
      RUNS,
    );
  });

  it('splits only at pauses or between fragments', () => {
    fc.assert(
      fc.property(inputs, (input) => {
        const plan = planChunks(input);
        const preserved = plan.pauses.filter((p) => p.disposition === 'preserved');
        for (const chunk of plan.chunks) {
          for (const piece of chunk.pieces) {
            const end = piece.fragment_start_ms + piece.duration_ms;
            const continued = plan.chunks.some(
              (other) =>
                other.chunk_index !== chunk.chunk_index &&
                other.pieces[0]?.fragment_id === piece.fragment_id &&
                other.pieces[0].fragment_start_ms === end,
            );
            if (continued) {
              const inside = preserved.some(
                (p) => p.fragment_id === piece.fragment_id && end > p.start_ms && end < p.end_ms,
              );
              expect(inside).toBe(true);
            }
          }
        }
      }),
      RUNS,
    );
  });

  it('maps every chunk interval to ordered, in-range source spans', () => {
    fc.assert(
      fc.property(inputs, fc.nat(), fc.nat(), (input, a, b) => {
        const fragments = fragmentsById(input);
        for (const chunk of planChunks(input).chunks) {
          const s = a % (chunk.duration_ms + 1);
          const e = s + (b % (chunk.duration_ms - s + 1));
          const mapped = mapChunkInterval(chunk, s, e);
          expect(mapped.sourceSpans.length).toBeGreaterThan(0);
          expect(mapped.end.sessionOffsetMs).toBeGreaterThanOrEqual(mapped.start.sessionOffsetMs);
          for (const span of mapped.sourceSpans) {
            const f = fragments.get(span.fragment_id);
            if (f === undefined) throw new Error('unknown fragment');
            expect(span.start_sample).toBeGreaterThanOrEqual(0);
            expect(span.end_sample).toBeGreaterThanOrEqual(span.start_sample);
            expect(span.end_sample).toBeLessThanOrEqual(f.sample_count);
            expect(f.timing_uncertainty_ms).toBeLessThanOrEqual(mapped.timingUncertaintyMs);
          }
          if (e > s) {
            const total = mapped.sourceSpans.reduce(
              (sum, span) => sum + span.end_sample - span.start_sample,
              0,
            );
            expect(total).toBeGreaterThan(0);
          }
        }
      }),
      RUNS,
    );
  });

  it('is deterministic under reordering of its inputs', () => {
    fc.assert(
      fc.property(inputs, (input) => {
        const reordered: ChunkPlanInput = {
          fragments: [...input.fragments].reverse(),
          pauses: new Map(
            [...input.pauses].map(([id, list]) => [id, [...list].reverse()] as const),
          ),
          params: input.params,
        };
        expect(planChunks(reordered)).toEqual(planChunks(input));
      }),
      RUNS,
    );
  });
});
