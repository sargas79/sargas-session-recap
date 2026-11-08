/**
 * Versioned config: content hashes recorded per run (T07 records them in job inputs).
 *
 * - {@link LoadedConfig.hash} / {@link contentHash}: the whole validated document. Changes on any
 *   edit that changes the data (not on comments, formatting or key order).
 * - Stage dependency hashes: a hash of only the fields a stage actually consumes, so editing a field
 *   used by one stage invalidates only that stage:
 *
 *   | Stage            | Campaign fields                                         | Glossary entry fields                                |
 *   | ---------------- | ------------------------------------------------------- | ---------------------------------------------------- |
 *   | `asr`            | language, provider.asr                                  | spelling, is_english_term                            |
 *   | `classification` | language, system, provider.classification, speakers¹   | id, spelling, type, mishearings, is_english_term     |
 *   | `recap`          | language, system, provider.recap, background, speakers¹ | id, spelling, type, description                      |
 *
 *   ¹ speaker_id, role, characters. Never display_name or consent: those are not sent to providers,
 *   and consent is enforced by `assertConsent()`, not by invalidation.
 *
 * Projections are order-independent (entries sorted by id, speakers by speaker_id, ASR terms by
 * spelling) and normalize defaults (`is_english_term` false, `mishearings` []), so writing a default
 * explicitly does not invalidate anything.
 */
import {
  consentModeOf,
  type CampaignConfig,
  type Glossary,
  type GlossaryEntry,
} from '@sargas-recap/contracts';
import { contentHash, type Sha256 } from './canonical.ts';

export const DEPENDENCY_STAGES = ['asr', 'classification', 'recap'] as const;
export type DependencyStage = (typeof DEPENDENCY_STAGES)[number];

/** Bump when a projection changes shape, so old and new hashes never collide. */
const PROJECTION_VERSION = 1;

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function sortedEntries(glossary: Glossary): GlossaryEntry[] {
  return [...glossary.entries].sort((a, b) => byCodeUnit(a.id, b.id));
}

function speakerContext(campaign: CampaignConfig) {
  return [...campaign.speakers]
    .sort((a, b) => byCodeUnit(a.speaker_id, b.speaker_id))
    .map((s) => ({ speaker_id: s.speaker_id, role: s.role, characters: s.characters ?? [] }));
}

export interface AsrPromptTerm {
  readonly spelling: string;
  readonly is_english_term: boolean;
}

/**
 * Glossary terms that feed the whisper initial prompt, in their canonical order (by spelling).
 * T09 must build the prompt from this list so the ASR hash covers exactly what the prompt contains.
 */
export function asrPromptTerms(glossary: Glossary): AsrPromptTerm[] {
  return glossary.entries
    .map((e) => ({ spelling: e.spelling, is_english_term: e.is_english_term ?? false }))
    .sort(
      (a, b) =>
        byCodeUnit(a.spelling, b.spelling) || Number(a.is_english_term) - Number(b.is_english_term),
    );
}

/** The exact data a stage depends on (what its dependency hash covers). */
export function stageDependencies(
  stage: DependencyStage,
  campaign: CampaignConfig,
  glossary: Glossary,
): Record<string, unknown> {
  switch (stage) {
    case 'asr':
      return {
        projection: 'asr-prompt',
        version: PROJECTION_VERSION,
        language: campaign.language,
        provider: campaign.provider.asr,
        terms: asrPromptTerms(glossary),
      };
    case 'classification':
      return {
        projection: 'classification-glossary',
        version: PROJECTION_VERSION,
        language: campaign.language,
        system: campaign.system,
        provider: campaign.provider.classification,
        speakers: speakerContext(campaign),
        entries: sortedEntries(glossary).map((e) => ({
          id: e.id,
          spelling: e.spelling,
          type: e.type,
          mishearings: e.mishearings ?? [],
          is_english_term: e.is_english_term ?? false,
        })),
      };
    case 'recap':
      return {
        projection: 'recap-background',
        version: PROJECTION_VERSION,
        language: campaign.language,
        system: campaign.system,
        provider: campaign.provider.recap,
        background: campaign.background ?? null,
        speakers: speakerContext(campaign),
        entries: sortedEntries(glossary).map((e) => ({
          id: e.id,
          spelling: e.spelling,
          type: e.type,
          description: e.description ?? null,
        })),
      };
  }
}

export function stageDependencyHash(
  stage: DependencyStage,
  campaign: CampaignConfig,
  glossary: Glossary,
): Sha256 {
  return contentHash(stageDependencies(stage, campaign, glossary));
}

/**
 * Hash of the consent policy (consent mode and every speaker's consent records), for the manifest consent snapshot
 * `policy_hash` (ADR-001). Order-independent across speakers.
 */
export function consentPolicyHash(campaign: CampaignConfig): Sha256 {
  return contentHash({
    projection: 'consent-policy',
    version: PROJECTION_VERSION,
    campaign_id: campaign.campaign_id,
    consent_mode: consentModeOf(campaign),
    provider: campaign.provider,
    speakers: [...campaign.speakers]
      .sort((a, b) => byCodeUnit(a.speaker_id, b.speaker_id))
      .map((s) => ({ speaker_id: s.speaker_id, consent: s.consent ?? [] })),
  });
}

export interface ConfigVersion {
  readonly campaign_hash: Sha256;
  readonly glossary_hash: Sha256;
  readonly consent_policy_hash: Sha256;
  readonly stage_hashes: Readonly<Record<DependencyStage, Sha256>>;
}

/** Every config hash a run records (T07 maps these to job `inputs`). */
export function configVersion(campaign: CampaignConfig, glossary: Glossary): ConfigVersion {
  return {
    campaign_hash: contentHash(campaign),
    glossary_hash: contentHash(glossary),
    consent_policy_hash: consentPolicyHash(campaign),
    stage_hashes: {
      asr: stageDependencyHash('asr', campaign, glossary),
      classification: stageDependencyHash('classification', campaign, glossary),
      recap: stageDependencyHash('recap', campaign, glossary),
    },
  };
}
