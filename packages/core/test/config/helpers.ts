import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CampaignConfig, Glossary } from '@sargas-recap/contracts';
import { parseCampaignConfig, parseGlossary } from '../../src/config/index.ts';

export const CAMPAIGN_FILE = fileURLToPath(
  new URL('../../../../fixtures/config/campaign.yaml', import.meta.url),
);
export const GLOSSARY_FILE = fileURLToPath(
  new URL('../../../../fixtures/config/glossary.yaml', import.meta.url),
);

export const campaignText = (): string => readFileSync(CAMPAIGN_FILE, 'utf8');
export const glossaryText = (): string => readFileSync(GLOSSARY_FILE, 'utf8');

/** Fresh, mutable copies of the synthetic fixtures. */
export function campaign(): CampaignConfig {
  return structuredClone(parseCampaignConfig(campaignText()).value);
}
/** `arr[i]`, failing the test instead of returning undefined. */
export function at<T>(arr: readonly T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`no element at index ${String(i)}`);
  return v;
}

export function glossary(): Glossary {
  return structuredClone(parseGlossary(glossaryText()).value);
}
