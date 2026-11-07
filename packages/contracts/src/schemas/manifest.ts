import { Type, type Static } from '@sinclair/typebox';
import {
  CampaignId,
  Count,
  Hash,
  Ms,
  RelPath,
  SchemaVersion1,
  SessionId,
  SessionOffsetMs,
  SpeakerId,
  StringEnum,
  Timestamp,
  UnixMs,
  Ulid,
  when,
} from '../common.ts';

/** Package lifecycle (ADR-006). */
export const LIFECYCLE_STATES = [
  'capturing',
  'sealed',
  'processing',
  'retained',
  'audio-purged',
] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export const CONSENT_SCOPES = ['recording', 'asr', 'classification', 'recap'] as const;

export const ARTIFACT_KINDS = ['audio-fragment', 'fragments-index', 'foundry-events'] as const;

const SealedArtifact = Type.Object(
  {
    path: RelPath({ description: 'Package-relative path of a source artifact.' }),
    kind: StringEnum(ARTIFACT_KINDS),
    hash: Hash(),
    bytes: Count(),
  },
  { additionalProperties: false },
);

const ConsentProvenance = Type.Object(
  {
    speaker_id: SpeakerId(),
    scopes: Type.Array(StringEnum(CONSENT_SCOPES), { uniqueItems: true }),
    policy_hash: Hash({
      description: 'Hash of the consent policy/config applied at capture (T04).',
    }),
    recorded_at: Timestamp(),
  },
  { additionalProperties: false },
);

const Discontinuity = Type.Object(
  {
    kind: StringEnum(['reconnect', 'gap', 'clock-reset'] as const),
    speaker_id: Type.Optional(SpeakerId()),
    at_offset_ms: SessionOffsetMs(),
    missing_ms: Type.Optional(Ms()),
    timing_uncertainty_ms: Ms(),
  },
  { additionalProperties: false },
);

export const ManifestSchema = Type.Object(
  {
    schema_version: SchemaVersion1,
    campaign_id: CampaignId(),
    session_id: SessionId(),
    package_id: Ulid({ description: 'Identity of this package (ADR-004).' }),
    created_at: Timestamp(),
    lifecycle: StringEnum(LIFECYCLE_STATES, {
      description: 'Authoritative package lifecycle (ADR-006). Job state lives in SQLite.',
    }),
    source: Type.Object(
      {
        kind: StringEnum(['multitrack-import', 'discord-bot'] as const),
        tool_version: Type.String({ minLength: 1, maxLength: 64 }),
      },
      { additionalProperties: false },
    ),
    timeline: Type.Object(
      {
        origin: StringEnum(['sync-marker', 'provisional'] as const, {
          description:
            'How session offset zero was established (ADR-003). `provisional`: no marker at capture.',
        }),
        origin_wall_clock_unix_ms: Type.Optional(UnixMs()),
        origin_uncertainty_ms: Ms(),
        discontinuities: Type.Array(Discontinuity),
      },
      { additionalProperties: false },
    ),
    consent: Type.Array(ConsentProvenance, {
      minItems: 1,
      description: 'Consent provenance snapshot at capture (ADR-001).',
    }),
    seal: Type.Optional(
      Type.Object(
        {
          sealed_at: Timestamp(),
          artifacts: Type.Array(SealedArtifact, { minItems: 1 }),
        },
        { additionalProperties: false },
      ),
    ),
    purge: Type.Optional(
      Type.Object(
        {
          purged_at: Timestamp(),
          purged_by: Type.String({ minLength: 1, maxLength: 64, description: 'Operator label.' }),
          reason: StringEnum([
            'retention-policy',
            'operator-request',
            'consent-withdrawn',
          ] as const),
          purged_artifacts: Type.Array(
            Type.Object({ path: RelPath(), hash: Hash() }, { additionalProperties: false }),
            { minItems: 1 },
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  {
    additionalProperties: false,
    allOf: [
      when('lifecycle', ['sealed', 'processing', 'retained', 'audio-purged'], {
        required: ['seal'],
      }),
      when('lifecycle', ['audio-purged'], { required: ['purge'] }),
      when('lifecycle', ['capturing'], { properties: { seal: false } }),
      when('lifecycle', ['capturing', 'sealed', 'processing', 'retained'], {
        properties: { purge: false },
      }),
    ],
  },
);
export type Manifest = Static<typeof ManifestSchema>;
