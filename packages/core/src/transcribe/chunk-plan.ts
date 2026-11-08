/**
 * Per-speaker chunk planning (T08). Pure and deterministic: fragments, detected pauses and
 * parameters in, a {@link ChunkPlan} out. Every time is integer milliseconds (ADR-003).
 *
 * Policy:
 *
 * - **Pauses.** A pause at least `remove_pause_min_ms` long is removed from the chunk audio, except
 *   for `removal_padding_ms` kept on each side that touches speech. A shorter pause, or one too
 *   short to remove anything after padding, stays in the audio (`pauses[].disposition`).
 * - **Splits happen only at pauses**: at the midpoint of a preserved pause, at a removed pause, or
 *   between fragments. Speech is never cut. A stretch with no pause longer than `max_chunk_ms`
 *   becomes one chunk flagged `over_max`.
 * - **Nothing is dropped.** Every millisecond of a fragment is in exactly one piece or inside the
 *   removed part of a pause. A short utterance joins its neighbors; if it has none it is a chunk
 *   of its own, flagged `under_min`. Only fragments with no audio at millisecond resolution
 *   (`empty`) or that are one single pause (`all_silence`) get no chunk, and they are listed.
 * - **Overlapping fragments** of one speaker never share a chunk, so session time always increases
 *   within a chunk.
 *
 * S04 did not decide a chunking strategy or measure boundaries on real audio, and whisper.cpp
 * segment length varied from about 1 s to 30 s by reader, so nothing here assumes a typical
 * segment length and {@link PROVISIONAL_CHUNK_PLAN_DEFAULTS} are unvalidated.
 */
import {
  canonicalJson,
  sha256Utf8,
  validateContract,
  type ChunkingConfig,
  type ChunkPlan,
  type ChunkPlanChunk,
  type ChunkPlanParams,
  type ChunkPlanPiece,
  type Fragment,
} from '@sargas-recap/contracts';
import type { SilenceInterval } from '../audio/index.ts';
import { ChunkPlanError } from './errors.ts';

/** Bump on any change that can move a boundary, so old and new plans never share a hash. */
export const CHUNK_PLANNER_VERSION = 1;

/**
 * PROVISIONAL. None of these values was measured: S04 left chunk length, pause handling and the
 * silence settings open (`docs/spikes/S04-whisper.md` sections 5.5, 5.7, 6.3, 7). The 20-30 s range
 * comes from the T08 issue and the silence settings are the S04 harness defaults. Override them
 * with `chunking:` in campaign.yaml; revisit on the first recorded session.
 */
export const PROVISIONAL_CHUNK_PLAN_DEFAULTS: Readonly<ChunkPlanParams> = Object.freeze({
  target_chunk_ms: 25_000,
  max_chunk_ms: 30_000,
  min_chunk_ms: 5_000,
  remove_pause_min_ms: 2_000,
  removal_padding_ms: 250,
  silence_threshold_db: -35,
  min_silence_ms: 500,
});

/** `sample_count * 1000` stays a safe integer below this, so conversions stay exact. */
const MAX_SAMPLE_COUNT = Math.floor((Number.MAX_SAFE_INTEGER - 1000) / 1000);

/** `floor(a / b)` for safe non-negative integers, without going through a rounded quotient. */
function floorDiv(a: number, b: number): number {
  return (a - (a % b)) / b;
}

/** `floor(sample * 1000 / rate)` (ADR-003). */
export function sampleToMs(sample: number, sampleRateHz: number): number {
  return floorDiv(sample * 1000, sampleRateHz);
}

/**
 * The first sample of millisecond `ms`: `ceil(ms * rate / 1000)`. For every rate of at least
 * 1 kHz, `sampleToMs(msToSample(ms, rate), rate) === ms`.
 */
export function msToSample(ms: number, sampleRateHz: number): number {
  return floorDiv(ms * sampleRateHz + 999, 1000);
}

/** The sample at a cut in fragment time: the fragment's last ms keeps any sub-ms tail. */
function cutSample(fragment: Fragment, ms: number): number {
  return ms >= fragment.duration_ms
    ? fragment.sample_count
    : msToSample(ms, fragment.sample_rate_hz);
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function fail(message: string): never {
  throw new ChunkPlanError('CHUNK_PLAN_INVALID_INPUT', message);
}

/** Defaults merged with `overrides`, validated. */
export function resolveChunkPlanParams(overrides: ChunkingConfig = {}): ChunkPlanParams {
  const params: ChunkPlanParams = { ...PROVISIONAL_CHUNK_PLAN_DEFAULTS, ...overrides };
  const bad = (message: string): never => {
    throw new ChunkPlanError('CHUNK_PLAN_INVALID_PARAMS', `chunking: ${message}`);
  };
  const positive = [
    'target_chunk_ms',
    'max_chunk_ms',
    'remove_pause_min_ms',
    'min_silence_ms',
  ] as const;
  for (const key of positive) {
    if (!Number.isSafeInteger(params[key]) || params[key] < 1) {
      bad(`${key} must be a positive integer`);
    }
  }
  for (const key of ['min_chunk_ms', 'removal_padding_ms'] as const) {
    if (!Number.isSafeInteger(params[key]) || params[key] < 0) {
      bad(`${key} must be a non-negative integer`);
    }
  }
  const db = params.silence_threshold_db;
  if (!Number.isInteger(db) || db > 0 || db < -200) {
    bad('silence_threshold_db must be an integer between -200 and 0');
  }
  if (params.target_chunk_ms > params.max_chunk_ms) {
    bad('target_chunk_ms must not exceed max_chunk_ms');
  }
  if (params.min_chunk_ms > params.target_chunk_ms) {
    bad('min_chunk_ms must not exceed target_chunk_ms');
  }
  return params;
}

function checkFragment(fragment: Fragment): void {
  const id = fragment.fragment_id;
  if (fragment.sample_count > MAX_SAMPLE_COUNT) fail(`fragment ${id}: sample_count is too large`);
  if (fragment.duration_ms !== sampleToMs(fragment.sample_count, fragment.sample_rate_hz)) {
    fail(`fragment ${id}: duration_ms does not match sample_count and sample_rate_hz`);
  }
}

/** Sorted, disjoint, non-touching pauses clamped to the fragment. */
function normalizePauses(fragment: Fragment, raw: readonly SilenceInterval[]): SilenceInterval[] {
  const clamped: SilenceInterval[] = [];
  for (const { startMs, endMs } of raw) {
    if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || startMs < 0) {
      fail(`fragment ${fragment.fragment_id}: pauses must be non-negative integer milliseconds`);
    }
    // ffmpeg's duration can differ slightly from the sample count's.
    const end = Math.min(endMs, fragment.duration_ms);
    if (end > startMs) clamped.push({ startMs, endMs: end });
  }
  clamped.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const merged: SilenceInterval[] = [];
  for (const pause of clamped) {
    const last = merged[merged.length - 1];
    if (last !== undefined && pause.startMs <= last.endMs) {
      merged[merged.length - 1] = {
        startMs: last.startMs,
        endMs: Math.max(last.endMs, pause.endMs),
      };
    } else {
      merged.push(pause);
    }
  }
  return merged;
}

/** The part of a pause to remove, or `undefined` if the pause stays in the audio. */
function removedRange(
  pause: SilenceInterval,
  durationMs: number,
  params: ChunkPlanParams,
): SilenceInterval | undefined {
  if (pause.endMs - pause.startMs < params.remove_pause_min_ms) return undefined;
  // Padding protects word edges, so a pause at the file edge needs it on one side only.
  const startMs = pause.startMs === 0 ? 0 : pause.startMs + params.removal_padding_ms;
  const endMs = pause.endMs === durationMs ? durationMs : pause.endMs - params.removal_padding_ms;
  return endMs > startMs ? { startMs, endMs } : undefined;
}

/** A stretch of one fragment between two points where a chunk may be cut. */
interface Atom {
  readonly fragment: Fragment;
  readonly startMs: number;
  readonly endMs: number;
}

const atomMs = (atom: Atom): number => atom.endMs - atom.startMs;
const sessionStart = (atom: Atom): number => atom.fragment.fragment_start_offset_ms + atom.startMs;
const sessionEnd = (atom: Atom): number => atom.fragment.fragment_start_offset_ms + atom.endMs;

interface FragmentCut {
  readonly atoms: Atom[];
  readonly pauses: ChunkPlan['pauses'];
  readonly excluded: ChunkPlan['excluded_fragments'][number]['reason'] | undefined;
}

function cutFragment(
  fragment: Fragment,
  rawPauses: readonly SilenceInterval[],
  params: ChunkPlanParams,
): FragmentCut {
  const durationMs = fragment.duration_ms;
  const fragmentId = fragment.fragment_id;
  const pauses = normalizePauses(fragment, rawPauses);
  const first = pauses[0];
  if (pauses.length === 1 && first?.startMs === 0 && first.endMs === durationMs) {
    return {
      atoms: [],
      pauses: [
        { fragment_id: fragmentId, start_ms: 0, end_ms: durationMs, disposition: 'removed' },
      ],
      excluded: 'all_silence',
    };
  }

  // Pieces of the fragment between removed ranges, each with its preserved-pause split points.
  const records: ChunkPlan['pauses'] = [];
  const atoms: Atom[] = [];
  let keptStart = 0;
  let pendingCuts: number[] = [];
  const closeKept = (keptEnd: number): void => {
    let start = keptStart;
    for (const cut of pendingCuts) {
      if (cut > start && cut < keptEnd) {
        atoms.push({ fragment, startMs: start, endMs: cut });
        start = cut;
      }
    }
    if (keptEnd > start) atoms.push({ fragment, startMs: start, endMs: keptEnd });
    pendingCuts = [];
  };

  for (const pause of pauses) {
    const removed = removedRange(pause, durationMs, params);
    records.push({
      fragment_id: fragmentId,
      start_ms: pause.startMs,
      end_ms: pause.endMs,
      disposition: removed === undefined ? 'preserved' : 'removed',
    });
    if (removed === undefined) {
      // A pause at the very edge has speech on one side only, so it is no place to split.
      if (pause.startMs > 0 && pause.endMs < durationMs) {
        pendingCuts.push(pause.startMs + Math.floor((pause.endMs - pause.startMs) / 2));
      }
    } else {
      closeKept(removed.startMs);
      keptStart = removed.endMs;
    }
  }
  closeKept(durationMs);
  return { atoms, pauses: records, excluded: undefined };
}

/** Consecutive atoms that may share a chunk: split wherever session time goes backwards. */
function splitAtOverlaps(atoms: readonly Atom[]): Atom[][] {
  const groups: Atom[][] = [];
  let groupEnd = Number.NEGATIVE_INFINITY;
  for (const atom of atoms) {
    const current = groups[groups.length - 1];
    if (current === undefined || sessionStart(atom) < groupEnd) {
      groups.push([atom]);
      groupEnd = sessionEnd(atom);
    } else {
      current.push(atom);
      groupEnd = Math.max(groupEnd, sessionEnd(atom));
    }
  }
  return groups;
}

interface Candidate {
  /** Index one past the last atom of the chunk. */
  readonly end: number;
  readonly durationMs: number;
  readonly remainderMs: number;
}

function bestCandidate(candidates: readonly Candidate[], targetMs: number): Candidate {
  let best: Candidate | undefined;
  for (const c of candidates) {
    const distance = Math.abs(c.durationMs - targetMs);
    const bestDistance = best === undefined ? Infinity : Math.abs(best.durationMs - targetMs);
    if (
      best === undefined ||
      distance < bestDistance ||
      (distance === bestDistance && c.durationMs > best.durationMs)
    ) {
      best = c;
    }
  }
  if (best === undefined) throw new RangeError('no chunk candidate');
  return best;
}

/**
 * Groups atoms into chunks, one chunk at a time: of the possible ends within `max_chunk_ms`, the
 * one closest to the target, preferring a chunk of at least `min_chunk_ms` that does not leave a
 * remainder shorter than that. An atom longer than the maximum is a chunk by itself.
 */
function chooseChunks(atoms: readonly Atom[], params: ChunkPlanParams): Atom[][] {
  const totalMs = atoms.reduce((sum, atom) => sum + atomMs(atom), 0);
  const chunks: Atom[][] = [];
  let start = 0;
  let consumedMs = 0;
  while (start < atoms.length) {
    const candidates: Candidate[] = [];
    let durationMs = 0;
    for (let i = start; i < atoms.length; i += 1) {
      const atom = atoms[i];
      if (atom === undefined) break;
      durationMs += atomMs(atom);
      if (i > start && durationMs > params.max_chunk_ms) break;
      candidates.push({ end: i + 1, durationMs, remainderMs: totalMs - consumedMs - durationMs });
    }
    const fits = (c: Candidate): boolean =>
      c.durationMs >= params.min_chunk_ms && c.durationMs <= params.max_chunk_ms;
    const clean = candidates.filter(
      (c) => fits(c) && (c.remainderMs === 0 || c.remainderMs >= params.min_chunk_ms),
    );
    const roomy = candidates.filter(fits);
    const pool = clean.length > 0 ? clean : roomy.length > 0 ? roomy : candidates;
    const chosen = bestCandidate(pool, params.target_chunk_ms);
    chunks.push(atoms.slice(start, chosen.end));
    start = chosen.end;
    consumedMs += chosen.durationMs;
  }
  return chunks;
}

function toPieces(atoms: readonly Atom[]): ChunkPlanPiece[] {
  const pieces: ChunkPlanPiece[] = [];
  let open: Atom | undefined;
  let chunkStartMs = 0;
  const flush = (): void => {
    if (open === undefined) return;
    const { fragment, startMs, endMs } = open;
    const startSample = cutSample(fragment, startMs);
    pieces.push({
      chunk_start_ms: chunkStartMs,
      duration_ms: endMs - startMs,
      fragment_id: fragment.fragment_id,
      sample_rate_hz: fragment.sample_rate_hz,
      fragment_start_sample: startSample,
      sample_length: cutSample(fragment, endMs) - startSample,
      fragment_start_ms: startMs,
      session_start_offset_ms: fragment.fragment_start_offset_ms + startMs,
      timing_uncertainty_ms: fragment.timing_uncertainty_ms,
    });
    chunkStartMs += endMs - startMs;
  };
  for (const atom of atoms) {
    if (open?.fragment === atom.fragment && open.endMs === atom.startMs) {
      open = { fragment: atom.fragment, startMs: open.startMs, endMs: atom.endMs };
    } else {
      flush();
      open = atom;
    }
  }
  flush();
  return pieces;
}

function chunkFlags(durationMs: number, params: ChunkPlanParams): ChunkPlanChunk['flags'] {
  const flags: ChunkPlanChunk['flags'] = [];
  if (durationMs > params.max_chunk_ms) flags.push('over_max');
  if (durationMs < params.min_chunk_ms) flags.push('under_min');
  return flags;
}

function fragmentOrder(a: Fragment, b: Fragment): number {
  const numberOf = (f: Fragment): number => Number(f.fragment_id.slice(f.speaker_id.length + 1));
  return (
    a.fragment_start_offset_ms - b.fragment_start_offset_ms ||
    numberOf(a) - numberOf(b) ||
    byCodeUnit(a.fragment_id, b.fragment_id)
  );
}

export function hashChunkPlan(body: Omit<ChunkPlan, 'plan_hash'>): string {
  return sha256Utf8(canonicalJson(body));
}

export interface ChunkPlanInput {
  readonly fragments: readonly Fragment[];
  /** Detected pauses per fragment ID, in milliseconds from the start of the fragment. */
  readonly pauses: ReadonlyMap<string, readonly SilenceInterval[]>;
  readonly params: ChunkPlanParams;
}

/**
 * Builds the plan. The result depends only on the values given: the order of `fragments` and of
 * each pause list does not matter.
 */
export function planChunks(input: ChunkPlanInput): ChunkPlan {
  const params = resolveChunkPlanParams(input.params);
  const bySpeaker = new Map<string, Fragment[]>();
  const seen = new Set<string>();
  for (const fragment of input.fragments) {
    if (seen.has(fragment.fragment_id)) fail(`fragment ${fragment.fragment_id} is listed twice`);
    seen.add(fragment.fragment_id);
    checkFragment(fragment);
    const list = bySpeaker.get(fragment.speaker_id);
    if (list === undefined) bySpeaker.set(fragment.speaker_id, [fragment]);
    else list.push(fragment);
  }

  const chunks: ChunkPlanChunk[] = [];
  const pauses: ChunkPlan['pauses'] = [];
  const excluded: ChunkPlan['excluded_fragments'] = [];
  for (const speakerId of [...bySpeaker.keys()].sort(byCodeUnit)) {
    const atoms: Atom[] = [];
    for (const fragment of [...(bySpeaker.get(speakerId) ?? [])].sort(fragmentOrder)) {
      if (fragment.duration_ms === 0) {
        excluded.push({ fragment_id: fragment.fragment_id, reason: 'empty' });
        continue;
      }
      const raw = input.pauses.get(fragment.fragment_id);
      if (raw === undefined) fail(`fragment ${fragment.fragment_id} has no pause list`);
      const cut = cutFragment(fragment, raw, params);
      atoms.push(...cut.atoms);
      pauses.push(...cut.pauses);
      if (cut.excluded !== undefined) {
        excluded.push({ fragment_id: fragment.fragment_id, reason: cut.excluded });
      }
    }
    for (const group of splitAtOverlaps(atoms)) {
      for (const chunkAtoms of chooseChunks(group, params)) {
        const pieces = toPieces(chunkAtoms);
        const durationMs = pieces.reduce((sum, piece) => sum + piece.duration_ms, 0);
        chunks.push({
          chunk_index: chunks.length,
          speaker_id: speakerId,
          duration_ms: durationMs,
          flags: chunkFlags(durationMs, params),
          pieces,
        });
      }
    }
  }

  const body = {
    schema_version: 1 as const,
    planner_version: CHUNK_PLANNER_VERSION,
    params,
    chunks,
    pauses,
    excluded_fragments: excluded,
  };
  const { schema_version: schemaVersion, ...rest } = body;
  return { schema_version: schemaVersion, plan_hash: hashChunkPlan(body), ...rest };
}

/** Exact file content of a plan: deterministic for a given plan. */
export function serializeChunkPlan(plan: ChunkPlan): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

/** Checks the invariants the schema cannot express. Throws `CHUNK_PLAN_INVALID`. */
export function assertChunkPlanConsistent(plan: ChunkPlan): void {
  const bad = (message: string): never => {
    throw new ChunkPlanError('CHUNK_PLAN_INVALID', `chunk plan: ${message}`);
  };
  const { plan_hash: stored, ...body } = plan;
  if (hashChunkPlan(body) !== stored) bad('plan_hash does not match its content');
  plan.chunks.forEach((chunk, index) => {
    const name = `chunk ${String(index)}`;
    if (chunk.chunk_index !== index) bad(`${name}: chunk_index is out of sequence`);
    let cursor = 0;
    let sessionCursor = Number.NEGATIVE_INFINITY;
    for (const piece of chunk.pieces) {
      if (piece.chunk_start_ms !== cursor) bad(`${name}: pieces are not contiguous`);
      if (!piece.fragment_id.startsWith(`${chunk.speaker_id}:`)) {
        bad(`${name}: a piece belongs to another speaker`);
      }
      const { sample_rate_hz: rate, fragment_start_sample: first } = piece;
      if (sampleToMs(first, rate) !== piece.fragment_start_ms) {
        bad(`${name}: fragment_start_ms does not match fragment_start_sample`);
      }
      const endMs = sampleToMs(first + piece.sample_length, rate);
      if (endMs - piece.fragment_start_ms !== piece.duration_ms) {
        bad(`${name}: duration_ms does not match sample_length`);
      }
      if (piece.session_start_offset_ms < sessionCursor)
        bad(`${name}: session time goes backwards`);
      cursor += piece.duration_ms;
      sessionCursor = piece.session_start_offset_ms + piece.duration_ms;
    }
    if (cursor !== chunk.duration_ms) bad(`${name}: duration_ms is not the sum of its pieces`);
  });
}

/** Parses and fully checks a stored plan (for T09 and any later reader). */
export function parseChunkPlan(text: string): ChunkPlan {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ChunkPlanError('CHUNK_PLAN_INVALID', 'chunk plan: not valid JSON');
  }
  const result = validateContract('chunk-plan', value);
  if (!result.ok) {
    const paths = result.errors.map((issue) => issue.path).join(', ');
    throw new ChunkPlanError('CHUNK_PLAN_INVALID', `chunk plan: schema errors at ${paths}`);
  }
  const plan = value as ChunkPlan;
  assertChunkPlanConsistent(plan);
  return plan;
}
