import { Type, type Static } from '@sinclair/typebox';
import { CampaignId, Language, SchemaVersion1, Slug, SpeakerId, StringEnum } from '../common.ts';
import { CONSENT_SCOPES } from './manifest.ts';

/**
 * Consent purposes. The same vocabulary as the manifest consent snapshot (ADR-001): `recording`
 * covers capture, the others are the AI processing stages that send speaker data to a provider.
 */
export const CONSENT_PURPOSES = CONSENT_SCOPES;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

/**
 * How consent is established for the campaign (T04):
 * - `records`: every included speaker needs an active, dated consent record per purpose and provider.
 * - `implied`: taking part in the session is consent. No records are needed; only speakers listed in
 *   campaign.yaml are processed. Switch with `recap config consent on|off <campaign.yaml>`.
 */
export const CONSENT_MODES = ['records', 'implied'] as const;
export type ConsentMode = (typeof CONSENT_MODES)[number];
export const DEFAULT_CONSENT_MODE: ConsentMode = 'records';

export const SPEAKER_ROLES = ['gm', 'player', 'guest'] as const;
export type SpeakerRole = (typeof SPEAKER_ROLES)[number];

/** Calendar date `YYYY-MM-DD` (consent is recorded per day). */
export const ConsentDate = () => Type.String({ format: 'date', maxLength: 10 });

/** Provider identifier, e.g. `whisper-local`, `claude-cli`, `craig`. */
export const ProviderId = () =>
  Slug({ description: 'Provider identifier. A different provider needs its own consent (T04).' });

/** Model ID as the provider names it. Cannot start with `-`: it is passed as a CLI argument. */
export const LlmModelId = () =>
  Type.String({
    pattern: '^[A-Za-z0-9][A-Za-z0-9._:\\[\\]-]{0,127}$',
    description: 'Model ID, e.g. `claude-sonnet-5-5`.',
  });

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
    consent: Type.Optional(
      Type.Array(ConsentRecord, {
        maxItems: 64,
        description:
          'Consent records (synthetic in git; real ones live in the data root). Not needed when consent_mode is `implied`.',
      }),
    ),
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
    consent_mode: Type.Optional(
      StringEnum(CONSENT_MODES, {
        description:
          'How consent is established: `records` (default) or `implied` (attending the session is consent).',
      }),
    ),
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
    llm_model: Type.Optional(
      Type.Object(
        { classification: LlmModelId(), recap: LlmModelId() },
        {
          additionalProperties: false,
          description:
            'Explicit model ID per LLM stage (T10). There is no built-in default: the LLM stages refuse to run without it.',
        },
      ),
    ),
    speakers: Type.Array(Speaker, { minItems: 1, maxItems: 32 }),
  },
  { additionalProperties: false },
);
export type CampaignConfig = Static<typeof CampaignConfigSchema>;
export type CampaignSpeaker = CampaignConfig['speakers'][number];
export type CampaignConsentRecord = NonNullable<CampaignSpeaker['consent']>[number];

/** The effective consent mode (`records` when not set). */
export function consentModeOf(campaign: Pick<CampaignConfig, 'consent_mode'>): ConsentMode {
  return campaign.consent_mode ?? DEFAULT_CONSENT_MODE;
}
