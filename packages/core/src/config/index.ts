/**
 * Campaign, speaker and glossary config (T04).
 *
 * `assertConsent` is exported from here only. Every provider call must go through it.
 */
export { assertConsent, type AssertConsentInput, type ConsentReceipt } from './consent.ts';
export { canonicalJson, contentHash, type Sha256 } from './canonical.ts';
export { readConsentMode, setConsentMode, type ConsentModeChange } from './consent-mode.ts';
export {
  ConfigError,
  ConsentError,
  isConfigError,
  isConsentError,
  type ConfigErrorCode,
  type ConfigIssue,
  type ConfigKind,
  type ConsentErrorCode,
  type ConsentRefusal,
  type ConsentRefusalReason,
} from './errors.ts';
export {
  asrPromptTerms,
  configVersion,
  consentPolicyHash,
  DEPENDENCY_STAGES,
  stageDependencies,
  stageDependencyHash,
  type AsrPromptTerm,
  type ConfigVersion,
  type DependencyStage,
} from './hashes.ts';
export {
  DEFAULT_MAX_CONFIG_BYTES,
  loadCampaignConfig,
  loadGlossary,
  loadImportMapping,
  parseCampaignConfig,
  parseGlossary,
  parseImportMapping,
  type LoadedConfig,
  type LoadOptions,
} from './load.ts';
