import type { AsrConfig, AsrParams } from '@sargas-recap/contracts';

/** Bump on any change that can alter what a run produces from the same whisper output. */
export const ASR_RUNNER_VERSION = 1;

/**
 * PROVISIONAL. None of these values was validated. S04 left confidence and short-segment rules
 * open (`docs/spikes/S04-whisper.md` sections 5.6, 6.2): the token probability limits are the S04
 * harness placeholders, the repetition limits are sized from the one loop S04 saw (about 35 words,
 * repeated 8 times). The timeout covers a CPU fallback (S04 measured a real-time factor of 0.79)
 * and the first run per model, which compiles shaders. Override with `asr:` in campaign.yaml;
 * revisit on the first recorded session.
 */
export const PROVISIONAL_ASR_DEFAULTS: Readonly<AsrParams> = Object.freeze({
  short_segment_ms: 1_000,
  low_confidence_mean_permille: 700,
  low_confidence_min_permille: 350,
  repetition_min_repeats: 3,
  repetition_min_words: 12,
  repetition_max_unit_words: 120,
  prompt_max_chars: 800,
  timeout_base_ms: 600_000,
  timeout_audio_multiplier: 5,
});

/** Defaults merged with the `asr:` settings of campaign.yaml (already validated on load). */
export function resolveAsrParams(overrides: AsrConfig = {}): AsrParams {
  return { ...PROVISIONAL_ASR_DEFAULTS, ...overrides };
}

/** The parameters that can change a run's output. Timeouts cannot, so a retune reruns nothing. */
export function asrOutputParams(
  params: AsrParams,
): Omit<AsrParams, 'timeout_base_ms' | 'timeout_audio_multiplier'> {
  return {
    short_segment_ms: params.short_segment_ms,
    low_confidence_mean_permille: params.low_confidence_mean_permille,
    low_confidence_min_permille: params.low_confidence_min_permille,
    repetition_min_repeats: params.repetition_min_repeats,
    repetition_min_words: params.repetition_min_words,
    repetition_max_unit_words: params.repetition_max_unit_words,
    prompt_max_chars: params.prompt_max_chars,
  };
}

/** whisper.cpp takes a bare language code: `pt` for campaign language `pt-BR`. */
export function whisperLanguage(language: string): string {
  return language.split('-')[0] ?? language;
}
