import { Type, type Static } from '@sinclair/typebox';
import { CampaignId, Language, SchemaVersion1, Slug, SpeakerId, StringEnum } from '../common.ts';
import { CONSENT_SCOPES } from './manifest.ts';

/**
 * Consent purposes. The same vocabulary as the manifest consent snapshot (ADR-001): `recording`
 * covers capture, the others are the AI processing stages that send speaker data to a provider.
 */
export const CONSENT_PURPOSES = CONSENT_SCOPES;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

export const SPEAKER_ROLES = ['gm', 'player', 'guest'] as const;
export type SpeakerRole = (typeof SPEAKER_ROLES)[number];

/** Calendar date `YYYY-MM-DD` (consent is recorded per day). */
export const ConsentDate = () => Type.String({ format: 'date', maxLength: 10 });

/** Provider identifier, e.g. `whisper-local`, `claude-cli`, `craig`. */
export const ProviderId = () =>
  Slug({ description: 'Provider identifier. A different provider needs its own consent (T04).' });

/** No control characters: names end up in prompts and file listings. */
const SINGLE_LINE = '^[^\\u0000-\\u001F\\u007F]+$';

const ConsentRecord = Type.Object(
  {
    purpose: StringEnum(CONSENT_PURPOSES),
    provider: ProviderId(),
    granted_on: ConsentDate(),
    withdrawn_on: Type.Optional(ConsentDate()),
    evidence_ref: Type.Optional(
      Type.String({
        pattern: SINGLE_LINE,
        maxLength: 260,
        description:
          'Path to the consent evidence kept outside git (signed form, call note). Never opened by the loader; never committed.',
      }),
    ),
  },
  { additionalProperties: false },
);

const Speaker = Type.Object(
  {
    speaker_id: SpeakerId(),
    display_name: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 80,
        pattern: SINGLE_LINE,
        description: 'Operator-facing label. Never sent to a provider.',
      }),
    ),
    role: StringEnum(SPEAKER_ROLES),
    characters: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 120, pattern: SINGLE_LINE }), {
        uniqueItems: true,
        maxItems: 20,
        description: 'Character names this speaker plays (classification and recap context).',
      }),
    ),
    consent: Type.Array(ConsentRecord, {
      maxItems: 64,
      description: 'Consent records (synthetic in git; real ones live in the data root).',
    }),
  },
  { additionalProperties: false },
);

/**
 * `campaign.yaml` (T04). Lives in the data root, outside git; only synthetic fixtures are committed.
 * Consent policy is enforced by `assertConsent()` in packages/core/src/config/consent.ts.
 */
export const CampaignConfigSchema = Type.Object(
  {
    schema_version: SchemaVersion1,
    campaign_id: CampaignId(),
    system: Slug({ description: 'Game system, e.g. `pf2e`.' }),
    language: Language(),
    background: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 8000,
        description: 'Campaign background given to the recap stage only.',
      }),
    ),
    provider: Type.Object(
      {
        recording: ProviderId(),
        asr: ProviderId(),
        classification: ProviderId(),
        recap: ProviderId(),
      },
      { additionalProperties: false, description: 'Provider used by each stage.' },
    ),
    speakers: Type.Array(Speaker, { minItems: 1, maxItems: 32 }),
  },
  { additionalProperties: false },
);
export type CampaignConfig = Static<typeof CampaignConfigSchema>;
export type CampaignSpeaker = CampaignConfig['speakers'][number];
export type CampaignConsentRecord = CampaignSpeaker['consent'][number];
