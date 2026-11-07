import { Type, type Static } from '@sinclair/typebox';
import {
  Count,
  FragmentId,
  Ms,
  RelPath,
  SchemaVersion1,
  SessionOffsetMs,
  SpeakerId,
  StringEnum,
} from '../common.ts';

/**
 * One line of `fragments.jsonl`: a contiguous audio file of one speaker track (ADR-003).
 *
 * Session time of sample `s` in this fragment:
 * `fragment_start_offset_ms + floor(s * 1000 / sample_rate_hz)`.
 * Content hashes live in the manifest seal, not here (ADR-001).
 */
export const FragmentSchema = Type.Object(
  {
    schema_version: SchemaVersion1,
    fragment_id: FragmentId(),
    speaker_id: SpeakerId(),
    track_label: Type.String({
      minLength: 1,
      maxLength: 128,
      description: 'Source track name as imported or recorded (operator-visible, not content).',
    }),
    path: RelPath({
      description: 'Package-relative audio path, e.g. audio/<speaker_id>/<n>.flac.',
    }),
    codec: StringEnum(['pcm_s16le', 'flac', 'opus'] as const),
    sample_rate_hz: Type.Integer({ minimum: 8000, maximum: 192_000 }),
    channels: Type.Integer({ minimum: 1, maximum: 8 }),
    sample_count: Count(),
    duration_ms: Ms({ description: 'floor(sample_count * 1000 / sample_rate_hz).' }),
    fragment_start_offset_ms: SessionOffsetMs({
      description: 'Session offset of sample 0. Zero is the sync marker (ADR-003).',
    }),
    timing_uncertainty_ms: Ms({ description: 'Bound on the error of fragment_start_offset_ms.' }),
    status: StringEnum(['complete', 'incomplete', 'recovered'] as const, {
      description: '`incomplete`/`recovered`: capture was interrupted (T06 startup recovery).',
    }),
  },
  { additionalProperties: false },
);
export type Fragment = Static<typeof FragmentSchema>;
