/**
 * Shared primitives for every contract.
 *
 * Rules (see docs/adr):
 * - Times on a timeline are integer milliseconds or integer sample offsets. Never floats (ADR-003).
 * - Run IDs are ULIDs; segment, sentence and event IDs are deterministic strings scoped by their run
 *   (ADR-004).
 * - Every hash is `sha256:<64 lowercase hex>`.
 * - Audit timestamps are RFC 3339 UTC strings; wall-clock instants used in arithmetic are integer
 *   Unix milliseconds.
 *
 * This module must stay free of Node built-ins: the Foundry module bundles it for the browser.
 */
import { Type, type SchemaOptions } from '@sinclair/typebox';

/** Version of every v1 record. Bumped per schema on any change (ADR-002). */
export const SCHEMA_VERSION_1 = 1 as const;

export const SchemaVersion1 = Type.Literal(SCHEMA_VERSION_1, {
  description: 'Per-record schema version (ADR-002).',
});

/** JSON Schema `enum` of strings (clearer Ajv errors than a union of literals). */
export function StringEnum<const T extends readonly string[]>(
  values: T,
  options: SchemaOptions = {},
) {
  return Type.Unsafe<T[number]>({ ...options, type: 'string', enum: [...values] });
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/** Non-negative integer milliseconds (durations, uncertainties, offsets within a chunk). */
export const Ms = (options: SchemaOptions = {}) =>
  Type.Integer({ minimum: 0, maximum: MAX_SAFE, ...options });

/** Signed integer milliseconds on the session timeline (zero at the sync marker, ADR-003). */
export const SessionOffsetMs = (options: SchemaOptions = {}) =>
  Type.Integer({ minimum: -MAX_SAFE, maximum: MAX_SAFE, ...options });

/** Non-negative integer count (samples, bytes, indices, sequence numbers). */
export const Count = (options: SchemaOptions = {}) =>
  Type.Integer({ minimum: 0, maximum: MAX_SAFE, ...options });

/** Wall-clock instant as integer Unix milliseconds (used where arithmetic is needed). */
export const UnixMs = (options: SchemaOptions = {}) =>
  Type.Integer({ minimum: 0, maximum: MAX_SAFE, ...options });

/** RFC 3339 timestamp for audit metadata (`created_at`, `sealed_at`, ...). */
export const Timestamp = (options: SchemaOptions = {}) =>
  Type.String({ format: 'date-time', maxLength: 40, ...options });

export const ULID_PATTERN = '^[0-7][0-9A-HJKMNP-TV-Z]{25}$';
const ULID_BODY = '[0-7][0-9A-HJKMNP-TV-Z]{25}';
const INT = '(?:0|[1-9][0-9]{0,15})';
const POS_INT = '[1-9][0-9]{0,15}';
const SLUG_BODY = '[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?';

/** ULID (Crockford base32, 26 chars). Used for every run, job, capture and override ID. */
export const Ulid = (options: SchemaOptions = {}) =>
  Type.String({ pattern: ULID_PATTERN, ...options });

/** Operator-chosen identifier, safe as a path segment: lowercase letters, digits, inner hyphens. */
export const SLUG_PATTERN = `^${SLUG_BODY}$`;
export const Slug = (options: SchemaOptions = {}) =>
  Type.String({ pattern: SLUG_PATTERN, ...options });

export const CampaignId = () => Slug({ description: 'Campaign identifier (config, T04).' });
export const SessionId = () => Slug({ description: 'Session identifier within a campaign.' });
export const SpeakerId = () => Slug({ description: 'Speaker identifier from campaign config.' });

/** `<speaker_id>:<n>`: n-th fragment of one speaker in a package. */
export const FRAGMENT_ID_PATTERN = `^${SLUG_BODY}:${INT}$`;
export const FragmentId = () =>
  Type.String({ pattern: FRAGMENT_ID_PATTERN, description: '<speaker_id>:<n> (ADR-004).' });

/** `<transcription_run_id>:<chunk_index>:<n>` (ADR-004). */
export const SEGMENT_ID_PATTERN = `^${ULID_BODY}:${INT}:${INT}$`;
export const SegmentId = () =>
  Type.String({
    pattern: SEGMENT_ID_PATTERN,
    description: '<transcription_run_id>:<chunk_index>:<n> (ADR-004).',
  });

/** `fvtt:<capture_id>:<seq>` (ADR-004). */
export const EVENT_ID_PATTERN = `^fvtt:${ULID_BODY}:${INT}$`;
export const EventId = () =>
  Type.String({ pattern: EVENT_ID_PATTERN, description: 'fvtt:<capture_id>:<seq> (ADR-004).' });

/** `r<recap_revision>:s<n>`: recap sentence (ADR-004). */
export const SENTENCE_ID_PATTERN = `^r${POS_INT}:s${INT}$`;
export const SentenceId = () =>
  Type.String({ pattern: SENTENCE_ID_PATTERN, description: 'r<recap_revision>:s<n> (ADR-004).' });

/** `r<recap_revision>:g<n>`: GM-only recap note (ADR-004). */
export const GM_NOTE_ID_PATTERN = `^r${POS_INT}:g${INT}$`;
export const GmNoteId = () =>
  Type.String({ pattern: GM_NOTE_ID_PATTERN, description: 'r<recap_revision>:g<n> (ADR-004).' });

/** `r<recap_revision>:f<n>`: footnote in an exported recap package (ADR-004). */
export const FOOTNOTE_ID_PATTERN = `^r${POS_INT}:f${INT}$`;
export const FootnoteId = () =>
  Type.String({ pattern: FOOTNOTE_ID_PATTERN, description: 'r<recap_revision>:f<n> (ADR-004).' });

/** Recap revision: integer, starts at 1, monotonic per session (ADR-004). */
export const RecapRevision = () =>
  Type.Integer({ minimum: 1, maximum: MAX_SAFE, description: 'Monotonic per session (ADR-004).' });

/** `sha256:<64 lowercase hex>`. */
export const HASH_PATTERN = '^sha256:[0-9a-f]{64}$';
export const Hash = (options: SchemaOptions = {}) =>
  Type.String({ pattern: HASH_PATTERN, ...options });

/**
 * Package-relative POSIX path. Segments may not start with a dot, so `.`/`..` and absolute,
 * drive-letter or backslash paths are rejected. Full path safety is enforced on disk in T03.
 */
export const REL_PATH_PATTERN = '^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$';
export const RelPath = (options: SchemaOptions = {}) =>
  Type.String({ pattern: REL_PATH_PATTERN, maxLength: 240, ...options });

/** BCP 47 subset: `pt`, `en`, `pt-BR`. */
export const Language = () => Type.String({ pattern: '^[a-z]{2,3}(?:-[A-Z]{2})?$' });

/** Bounded free text (transcript or recap prose). Never logged, never echoed by validators. */
export const Text = (options: SchemaOptions = {}) =>
  Type.String({ minLength: 1, maxLength: 20_000, ...options });

/**
 * Who performed an editorial action (edit, review, approval, export): an operator identity slug
 * such as `gm`, never a real name or an email (ADR-010).
 */
export const ReviewerId = () =>
  Slug({ description: 'Operator identity slug (ADR-010); not a real name or an email.' });

/** Six classification labels (T11). */
export const LABELS = ['ic', 'narration', 'rules', 'ooc', 'mixed', 'uncertain'] as const;
export const Label = () => StringEnum(LABELS, { description: 'Classification label (T11).' });
export type ClassificationLabel = (typeof LABELS)[number];

/**
 * `if <prop> is one of <values> then <then>`, for use in `allOf`. Static types do not narrow on it;
 * the JSON Schema enforces it.
 */
export function when(
  prop: string,
  values: readonly (string | boolean)[],
  then: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    if: { type: 'object', properties: { [prop]: { enum: [...values] } }, required: [prop] },
    then: { type: 'object', ...then },
  };
}
