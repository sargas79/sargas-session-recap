import { Type, type Static } from '@sinclair/typebox';
import { Ms, SchemaVersion1, SessionOffsetMs, Slug, SpeakerId } from '../common.ts';

/**
 * A track file name inside the import directory: one path segment, no separators, no Windows
 * reserved characters, no control characters, not `.` or `..`.
 */
export const TRACK_FILE_PATTERN = '^(?!\\.\\.?$)[^\\\\/:*?"<>|\\u0000-\\u001F\\u007F]{1,255}$';

/** No control characters: labels end up in fragments.jsonl and file listings. */
const SINGLE_LINE = '^[^\\u0000-\\u001F\\u007F]+$';

const MappedTrack = Type.Object(
  {
    file: Type.String({
      pattern: TRACK_FILE_PATTERN,
      description: 'File name of the track in the import directory (no sub-directories).',
    }),
    speaker_id: SpeakerId(),
    start_offset_ms: Type.Optional(
      SessionOffsetMs({
        description:
          'Session offset of the first sample of this track (ADR-003). Default 0: the track starts at session zero.',
      }),
    ),
    timing_uncertainty_ms: Type.Optional(
      Ms({ description: 'Bound on the error of start_offset_ms. Default: the mapping default.' }),
    ),
    label: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 128,
        pattern: SINGLE_LINE,
        description: 'Track label recorded in fragments.jsonl. Default: the file name.',
      }),
    ),
  },
  { additionalProperties: false },
);

/**
 * Track -> speaker mapping for `recap import` (T05). YAML or JSON, next to the tracks
 * (`recap-tracks.yaml`, `.yml` or `.json`) or passed with `--mapping`. Files in the directory that
 * the mapping does not list are excluded from the package and reported.
 */
export const ImportMappingSchema = Type.Object(
  {
    schema_version: SchemaVersion1,
    recorder: Type.Optional(
      Slug({
        description:
          'Provider that recorded the tracks. Must be campaign.yaml provider.recording (consent is per provider). Default: that provider.',
      }),
    ),
    origin_uncertainty_ms: Type.Optional(
      Ms({ description: 'Uncertainty of the provisional session origin (ADR-003). Default 0.' }),
    ),
    default_timing_uncertainty_ms: Type.Optional(
      Ms({ description: 'timing_uncertainty_ms for tracks that do not set one. Default 0.' }),
    ),
    tracks: Type.Array(MappedTrack, { minItems: 1, maxItems: 256 }),
  },
  { additionalProperties: false },
);
export type ImportMapping = Static<typeof ImportMappingSchema>;
export type ImportMappingTrack = ImportMapping['tracks'][number];
