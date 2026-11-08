import type { ChunkPlanParams, Fragment } from '@sargas-recap/contracts';

/** Synthetic fragment: `durationMs` of audio starting at session offset `offsetMs`. */
export function fragmentOf(
  id: string,
  durationMs: number,
  offsetMs = 0,
  overrides: Partial<Fragment> = {},
): Fragment {
  const speaker = id.slice(0, id.lastIndexOf(':'));
  const rate = overrides.sample_rate_hz ?? 16_000;
  const samples = overrides.sample_count ?? Math.ceil((durationMs * rate) / 1000);
  return {
    schema_version: 1,
    fragment_id: id,
    speaker_id: speaker,
    track_label: `Track ${speaker}`,
    path: `audio/${speaker}/${id.slice(id.lastIndexOf(':') + 1)}.flac`,
    codec: 'flac',
    sample_rate_hz: rate,
    channels: 1,
    sample_count: samples,
    duration_ms: Math.floor((samples * 1000) / rate),
    fragment_start_offset_ms: offsetMs,
    timing_uncertainty_ms: 0,
    status: 'complete',
    ...overrides,
  };
}

export const TEST_PARAMS: ChunkPlanParams = {
  target_chunk_ms: 25_000,
  max_chunk_ms: 30_000,
  min_chunk_ms: 5_000,
  remove_pause_min_ms: 2_000,
  removal_padding_ms: 250,
  silence_threshold_db: -35,
  min_silence_ms: 500,
};
