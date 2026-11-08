import { Type, type Static } from '@sinclair/typebox';
import { Ms } from '../common.ts';

const Permille = (description: string) => Type.Integer({ minimum: 0, maximum: 1000, description });

/**
 * Whisper runner settings (T09). S04 validated none of the review flags or limits against a
 * hand-check, so every default for these fields is provisional.
 */
export const AsrParamsSchema = Type.Object(
  {
    short_segment_ms: Ms({ minimum: 1, description: 'Segments shorter than this are flagged.' }),
    low_confidence_mean_permille: Permille('Flag when the mean token probability is below this.'),
    low_confidence_min_permille: Permille('Flag when the lowest token probability is below this.'),
    repetition_min_repeats: Type.Integer({
      minimum: 2,
      maximum: 1000,
      description: 'Consecutive copies of a passage that count as a repetition loop.',
    }),
    repetition_min_words: Type.Integer({
      minimum: 1,
      maximum: 100_000,
      description: 'Total repeated words needed, so ordinary speech is not flagged.',
    }),
    repetition_max_unit_words: Type.Integer({
      minimum: 1,
      maximum: 10_000,
      description: 'Longest repeated passage searched for, in words.',
    }),
    prompt_max_chars: Type.Integer({
      minimum: 0,
      maximum: 20_000,
      description: 'Glossary terms past this length stay out of the initial prompt.',
    }),
    timeout_base_ms: Ms({
      minimum: 1,
      description: 'Allowance per chunk for process start, model load and shader compilation.',
    }),
    timeout_audio_multiplier: Type.Integer({
      minimum: 1,
      maximum: 1000,
      description: 'Added to the allowance per millisecond of chunk audio.',
    }),
  },
  { additionalProperties: false },
);
export type AsrParams = Static<typeof AsrParamsSchema>;

/** `asr:` in campaign.yaml: any subset of the parameters, the rest keep their defaults. */
export const AsrConfigSchema = Type.Partial(AsrParamsSchema, {
  additionalProperties: false,
  description:
    'Whisper runner overrides (T09). The built-in defaults are provisional: S04 did not validate them on real audio.',
});
export type AsrConfig = Static<typeof AsrConfigSchema>;
