import { readFileSync } from 'node:fs';
import { validateContract, type ChunkPlan, type Fragment } from '@sargas-recap/contracts';
import { describe, expect, it } from 'vitest';
import type { SilenceInterval } from '../../src/audio/index.ts';
import {
  ChunkPlanError,
  chunkToSource,
  fragmentToChunk,
  mapChunkInterval,
  msToSample,
  parseChunkPlan,
  planChunks,
  PROVISIONAL_CHUNK_PLAN_DEFAULTS,
  resolveChunkPlanParams,
  sampleToMs,
  serializeChunkPlan,
} from '../../src/transcribe/index.ts';
import { fragmentOf, TEST_PARAMS } from './helpers.ts';

function plan(
  fragments: readonly Fragment[],
  pauses: Record<string, readonly SilenceInterval[]> = {},
  params = TEST_PARAMS,
): ChunkPlan {
  const map = new Map<string, readonly SilenceInterval[]>(
    fragments.map((f) => [f.fragment_id, pauses[f.fragment_id] ?? []]),
  );
  return planChunks({ fragments, pauses: map, params });
}

const pause = (startMs: number, endMs: number): SilenceInterval => ({ startMs, endMs });
const sum = (p: ChunkPlan): number => p.chunks.reduce((total, c) => total + c.duration_ms, 0);

describe('provisional defaults', () => {
  it('are the documented unvalidated values', () => {
    expect(PROVISIONAL_CHUNK_PLAN_DEFAULTS).toEqual({
      target_chunk_ms: 25_000,
      max_chunk_ms: 30_000,
      min_chunk_ms: 5_000,
      remove_pause_min_ms: 2_000,
      removal_padding_ms: 250,
      silence_threshold_db: -35,
      min_silence_ms: 500,
    });
  });

  it('merge with overrides', () => {
    expect(resolveChunkPlanParams({ target_chunk_ms: 20_000 })).toEqual({
      ...PROVISIONAL_CHUNK_PLAN_DEFAULTS,
      target_chunk_ms: 20_000,
    });
  });

  it.each([
    [{ target_chunk_ms: 31_000 }, /target_chunk_ms must not exceed/],
    [{ min_chunk_ms: 26_000 }, /min_chunk_ms must not exceed/],
    [{ max_chunk_ms: 0 }, /max_chunk_ms must be a positive/],
    [{ removal_padding_ms: 1.5 }, /removal_padding_ms must be/],
    [{ silence_threshold_db: -35.5 }, /silence_threshold_db/],
    [{ min_silence_ms: -1 }, /min_silence_ms must be/],
  ])('reject %j', (overrides, message) => {
    expect(() => resolveChunkPlanParams(overrides)).toThrow(message);
  });
});

describe('sample conversions', () => {
  it.each([8000, 11_025, 16_000, 22_050, 44_100, 48_000, 96_000, 192_000])(
    'msToSample inverts sampleToMs at %i Hz',
    (rate) => {
      for (const ms of [0, 1, 2, 3, 999, 1000, 1001, 3_600_000, 1_000_000_007]) {
        expect(sampleToMs(msToSample(ms, rate), rate)).toBe(ms);
      }
    },
  );
});

describe('gap removal', () => {
  it('removes a long pause except for padding on both sides', () => {
    const p = plan([fragmentOf('gm:0', 10_000)], { 'gm:0': [pause(3000, 7000)] });
    expect(p.pauses).toEqual([
      { fragment_id: 'gm:0', start_ms: 3000, end_ms: 7000, disposition: 'removed' },
    ]);
    const pieces = p.chunks[0]?.pieces ?? [];
    expect(pieces.map((x) => [x.fragment_start_ms, x.duration_ms, x.chunk_start_ms])).toEqual([
      [0, 3250, 0],
      [6750, 3250, 3250],
    ]);
    expect(p.chunks[0]?.duration_ms).toBe(6500);
  });

  it('keeps a pause shorter than remove_pause_min_ms', () => {
    const p = plan([fragmentOf('gm:0', 10_000)], { 'gm:0': [pause(3000, 4000)] });
    expect(p.pauses[0]?.disposition).toBe('preserved');
    expect(p.chunks[0]?.pieces).toHaveLength(1);
    expect(p.chunks[0]?.duration_ms).toBe(10_000);
  });

  it('keeps a pause that padding would remove entirely', () => {
    const params = { ...TEST_PARAMS, removal_padding_ms: 1000, remove_pause_min_ms: 2000 };
    const p = plan([fragmentOf('gm:0', 10_000)], { 'gm:0': [pause(3000, 5000)] }, params);
    expect(p.pauses[0]?.disposition).toBe('preserved');
    expect(p.chunks[0]?.duration_ms).toBe(10_000);
  });

  it('pads only the speech side of a pause at the file edges', () => {
    const p = plan([fragmentOf('gm:0', 10_000)], {
      'gm:0': [pause(0, 3000), pause(8000, 10_000)],
    });
    const pieces = p.chunks[0]?.pieces ?? [];
    expect(pieces.map((x) => [x.fragment_start_ms, x.duration_ms])).toEqual([[2750, 5500]]);
  });

  it('merges overlapping and touching pauses and clamps them to the fragment', () => {
    const p = plan([fragmentOf('gm:0', 10_000)], {
      'gm:0': [pause(5000, 6000), pause(3000, 5000), pause(9500, 12_000)],
    });
    expect(p.pauses.map((x) => [x.start_ms, x.end_ms])).toEqual([
      [3000, 6000],
      [9500, 10_000],
    ]);
  });

  it('accounts for a session gap between fragments in the junction uncertainty', () => {
    const fragments = [
      fragmentOf('gm:0', 3000, 1000, { timing_uncertainty_ms: 20 }),
      fragmentOf('gm:1', 3000, 9000, { timing_uncertainty_ms: 50 }),
    ];
    const p = plan(fragments);
    const chunk = p.chunks[0];
    if (chunk === undefined) throw new Error('no chunk');
    expect(chunk.pieces).toHaveLength(2);
    // 4000..9000 is the gap between the fragments; 50 is the larger uncertainty.
    expect(chunkToSource(chunk, 3000).timingUncertaintyMs).toBe(50 + 5000);
    expect(chunkToSource(chunk, 3000).sessionOffsetMs).toBe(9000);
    expect(chunkToSource(chunk, 3000, 'end').sessionOffsetMs).toBe(4000);
    expect(chunkToSource(chunk, 3000, 'end').timingUncertaintyMs).toBe(50 + 5000);
    expect(chunkToSource(chunk, 2999).timingUncertaintyMs).toBe(20);
    expect(chunkToSource(chunk, 3001).timingUncertaintyMs).toBe(50);
  });

  it('gives a segment across a removed pause one span per piece', () => {
    const p = plan([fragmentOf('gm:0', 10_000)], { 'gm:0': [pause(3000, 7000)] });
    const chunk = p.chunks[0];
    if (chunk === undefined) throw new Error('no chunk');
    const mapped = mapChunkInterval(chunk, 3000, 4000);
    expect(mapped.sourceSpans).toEqual([
      { fragment_id: 'gm:0', start_sample: 48_000, end_sample: 52_000 },
      { fragment_id: 'gm:0', start_sample: 108_000, end_sample: 120_000 },
    ]);
    expect(mapped.start.sessionOffsetMs).toBe(3000);
    expect(mapped.end.sessionOffsetMs).toBe(7500);
  });
});

describe('splitting', () => {
  it('produces chunks near the target, cut at the midpoint of preserved pauses', () => {
    const fragment = fragmentOf('gm:0', 120_000);
    const pauses = [20_000, 44_000, 70_000, 95_000].map((at) => pause(at, at + 1000));
    const p = plan([fragment], { 'gm:0': pauses });
    // Cuts at the midpoints 20 500, 44 500, 70 500 and 95 500; the chosen ends are the nearest 25 s.
    expect(p.chunks.map((c) => c.duration_ms)).toEqual([20_500, 24_000, 26_000, 25_000, 24_500]);
    expect(p.chunks.every((c) => c.flags.length === 0)).toBe(true);
    // A chunk boundary inside a preserved pause leaves no audio out: chunks are contiguous.
    expect(p.chunks.map((c) => c.pieces[0]?.fragment_start_ms)).toEqual([
      0, 20_500, 44_500, 70_500, 95_500,
    ]);
    expect(sum(p)).toBe(120_000);
  });

  it('never cuts speech: a stretch with no pause longer than max is one flagged chunk', () => {
    const p = plan([fragmentOf('gm:0', 95_000)]);
    expect(p.chunks).toHaveLength(1);
    expect(p.chunks[0]?.duration_ms).toBe(95_000);
    expect(p.chunks[0]?.flags).toEqual(['over_max']);
  });

  it('joins fragments of one speaker across a gap, but never across speakers', () => {
    const p = plan([
      fragmentOf('gm:0', 5000, 0),
      fragmentOf('gm:1', 5000, 60_000),
      fragmentOf('player-a:0', 5000, 0),
    ]);
    expect(p.chunks.map((c) => c.speaker_id)).toEqual(['gm', 'player-a']);
    expect(p.chunks[0]?.pieces.map((x) => x.fragment_id)).toEqual(['gm:0', 'gm:1']);
  });

  it('starts a new chunk when fragments of a speaker overlap, keeping session time monotonic', () => {
    const p = plan([fragmentOf('gm:0', 5000, 0), fragmentOf('gm:1', 5000, 3000)]);
    expect(p.chunks).toHaveLength(2);
    expect(p.chunks.map((c) => c.pieces.map((x) => x.fragment_id))).toEqual([['gm:0'], ['gm:1']]);
  });

  it('uses session order even when fragment numbers run the other way', () => {
    const p = plan([fragmentOf('gm:1', 2000, 0), fragmentOf('gm:0', 2000, 3000)]);
    expect(p.chunks[0]?.pieces.map((x) => x.fragment_id)).toEqual(['gm:1', 'gm:0']);
  });
});

describe('short speech is retained', () => {
  it('keeps a very short utterance between long pauses, inside a chunk', () => {
    const p = plan([fragmentOf('gm:0', 20_000)], {
      'gm:0': [pause(4000, 9000), pause(9200, 15_000)],
    });
    const covered = fragmentToChunk(p, 'gm:0', 9100);
    expect(covered).toBeDefined();
    if (covered === undefined) throw new Error('lost');
    const chunk = p.chunks[covered.chunkIndex];
    if (chunk === undefined) throw new Error('no chunk');
    expect(chunkToSource(chunk, covered.chunkMs).fragmentMs).toBe(9100);
  });

  it('keeps a short fragment on its own, flagged', () => {
    const p = plan([fragmentOf('gm:0', 30)]);
    expect(p.chunks).toHaveLength(1);
    expect(p.chunks[0]?.duration_ms).toBe(30);
    expect(p.chunks[0]?.flags).toEqual(['under_min']);
    expect(p.excluded_fragments).toEqual([]);
  });

  it('merges a short tail instead of isolating it when the maximum allows', () => {
    const p = plan([fragmentOf('gm:0', 28_000)], { 'gm:0': [pause(24_000, 24_600)] });
    expect(p.chunks.map((c) => c.duration_ms)).toEqual([28_000]);
  });

  it('excludes only empty and fully silent fragments, and says so', () => {
    const p = plan(
      [
        fragmentOf('gm:0', 0, 0, { sample_count: 3, duration_ms: 0 }),
        fragmentOf('gm:1', 4000),
        fragmentOf('gm:2', 400),
      ],
      { 'gm:1': [pause(0, 4000)], 'gm:2': [pause(0, 400)] },
    );
    expect(p.chunks).toEqual([]);
    expect(p.excluded_fragments).toEqual([
      { fragment_id: 'gm:0', reason: 'empty' },
      { fragment_id: 'gm:1', reason: 'all_silence' },
      { fragment_id: 'gm:2', reason: 'all_silence' },
    ]);
  });
});

describe('sub-millisecond tails', () => {
  it('keeps the tail sample attached to the last piece', () => {
    // 44100 Hz: 1000 samples are 22.67 ms, so duration_ms is 22 and the tail is sub-millisecond.
    const fragment = fragmentOf('gm:0', 22, 0, { sample_rate_hz: 44_100, sample_count: 1000 });
    const p = plan([fragment]);
    expect(p.chunks[0]?.pieces[0]).toMatchObject({
      fragment_start_sample: 0,
      sample_length: 1000,
      duration_ms: 22,
    });
  });
});

describe('determinism and hashing', () => {
  const fragments = [
    fragmentOf('gm:0', 40_000, 100),
    fragmentOf('gm:1', 40_000, 50_000),
    fragmentOf('player-a:0', 60_000, -2000),
  ];
  const pauses = {
    'gm:0': [pause(12_000, 13_000), pause(25_000, 30_000)],
    'gm:1': [pause(10_000, 11_000)],
    'player-a:0': [pause(30_000, 31_000)],
  };

  it('is deterministic, byte for byte, whatever the input order', () => {
    const a = plan(fragments, pauses);
    const b = plan([...fragments].reverse(), {
      'gm:0': [...pauses['gm:0']].reverse(),
      'gm:1': pauses['gm:1'],
      'player-a:0': pauses['player-a:0'],
    });
    expect(serializeChunkPlan(a)).toBe(serializeChunkPlan(b));
    expect(a.plan_hash).toBe(b.plan_hash);
  });

  it('changes the hash when a parameter, a pause or the timing changes', () => {
    const base = plan(fragments, pauses).plan_hash;
    expect(plan(fragments, pauses, { ...TEST_PARAMS, min_silence_ms: 501 }).plan_hash).not.toBe(
      base,
    );
    expect(plan(fragments, { ...pauses, 'gm:1': [pause(10_000, 11_001)] }).plan_hash).not.toBe(
      base,
    );
    expect(
      plan([fragmentOf('gm:0', 40_000, 101), ...fragments.slice(1)], pauses).plan_hash,
    ).not.toBe(base);
  });

  it('writes a plan that validates against the contract and parses back', () => {
    const p = plan(fragments, pauses);
    expect(validateContract('chunk-plan', p).ok).toBe(true);
    expect(parseChunkPlan(serializeChunkPlan(p))).toEqual(p);
  });

  it('accepts the committed synthetic fixture, hash included', () => {
    const text = readFileSync(
      new URL('../../../../fixtures/contracts/chunk-plan/valid.json', import.meta.url),
      'utf8',
    );
    expect(parseChunkPlan(text).chunks.length).toBeGreaterThan(0);
  });

  it('rejects a tampered plan', () => {
    const p = plan(fragments, pauses);
    const tampered: ChunkPlan = { ...p, params: { ...p.params, min_chunk_ms: 1 } };
    expect(() => parseChunkPlan(JSON.stringify(tampered))).toThrow(/plan_hash/);
  });
});

describe('bad input', () => {
  it('refuses a fragment with inconsistent duration', () => {
    const bad = fragmentOf('gm:0', 1000, 0, { duration_ms: 999 });
    expect(() => plan([bad])).toThrow(ChunkPlanError);
  });

  it('refuses a duplicate fragment and a missing pause list', () => {
    const f = fragmentOf('gm:0', 1000);
    expect(() => planChunks({ fragments: [f, f], pauses: new Map(), params: TEST_PARAMS })).toThrow(
      /twice/,
    );
    expect(() => planChunks({ fragments: [f], pauses: new Map(), params: TEST_PARAMS })).toThrow(
      /no pause list/,
    );
  });

  it('refuses non-integer pauses and out-of-range mapped times', () => {
    expect(() => plan([fragmentOf('gm:0', 1000)], { 'gm:0': [pause(0.5, 700)] })).toThrow(
      /integer/,
    );
    const p = plan([fragmentOf('gm:0', 1000)]);
    const chunk = p.chunks[0];
    if (chunk === undefined) throw new Error('no chunk');
    expect(() => chunkToSource(chunk, 1001)).toThrow(/outside/);
    expect(() => chunkToSource(chunk, -1)).toThrow(/outside/);
    expect(() => mapChunkInterval(chunk, 500, 400)).toThrow(/ends before/);
  });
});
