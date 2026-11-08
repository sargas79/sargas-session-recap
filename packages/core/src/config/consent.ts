/**
 * Consent policy: the ONE choke point (plan section 5, risk 6). Every call that sends speaker data
 * to a provider (capture, ASR, classification, recap) must call {@link assertConsent} first, with
 * every speaker whose data is included. Do not reimplement this check elsewhere.
 *
 * Rules (fail closed):
 * - `provider` must be the one configured for `stage` in campaign.yaml.
 * - Each speaker must exist in campaign.yaml and have an active consent record whose `purpose` is
 *   the stage and whose `provider` is exactly that provider. Consent is per provider: changing a
 *   stage's provider requires new records.
 * - AI stages additionally require active `recording` consent (any recording provider).
 * - A record is active on day D when granted_on <= D and it is not withdrawn on or before D. When a
 *   speaker has several matching records, the most recent grant decides; a withdrawal on any of the
 *   most recent ones refuses.
 * - An empty speaker list is refused.
 */
import type {
  CampaignConfig,
  CampaignConsentRecord,
  ConsentPurpose,
} from '@sargas-recap/contracts';
import { consentPolicyHash } from './hashes.ts';
import { ConsentError, type ConsentRefusal, type ConsentRefusalReason } from './errors.ts';
import type { Sha256 } from './canonical.ts';

export interface AssertConsentInput {
  readonly campaign: CampaignConfig;
  /** Every speaker whose audio or text is included in the provider call. */
  readonly speakerIds: readonly string[];
  readonly provider: string;
  readonly stage: ConsentPurpose;
  /** Clock override for tests. Consent is evaluated on this UTC day. */
  readonly now?: Date;
}

export interface ConsentReceipt {
  readonly stage: ConsentPurpose;
  readonly provider: string;
  readonly speaker_ids: readonly string[];
  readonly policy_hash: Sha256;
  readonly checked_on: string;
}

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Why `records` do not grant `purpose` with `provider` (any provider when undefined), or null. */
function refusalFor(
  records: readonly CampaignConsentRecord[],
  purpose: ConsentPurpose,
  provider: string | undefined,
  day: string,
): ConsentRefusalReason | null {
  const matching = records.filter(
    (r) => r.purpose === purpose && (provider === undefined || r.provider === provider),
  );
  if (matching.length === 0) return 'no-record';
  if (provider === undefined) {
    // Recording prerequisite: one active record per recording provider is enough.
    const providers = new Set(matching.map((r) => r.provider));
    let last: ConsentRefusalReason = 'no-record';
    for (const p of providers) {
      const reason = refusalFor(records, purpose, p, day);
      if (reason === null) return null;
      last = reason;
    }
    return last;
  }
  const granted = matching.filter((r) => r.granted_on <= day);
  if (granted.length === 0) return 'not-yet-granted';
  const latest = granted.reduce((max, r) => (r.granted_on > max ? r.granted_on : max), '');
  const current = granted.filter((r) => r.granted_on === latest);
  const withdrawn = current.some((r) => r.withdrawn_on !== undefined && r.withdrawn_on <= day);
  return withdrawn ? 'withdrawn' : null;
}

/**
 * Throws {@link ConsentError} unless every included speaker has recorded, active consent for
 * `provider` and the purpose `stage`. Returns a receipt that can be logged or stored with the job.
 */
export function assertConsent(input: AssertConsentInput): ConsentReceipt {
  const { campaign, provider, stage } = input;
  const day = utcDay(input.now ?? new Date());
  const speakerIds = [...new Set(input.speakerIds)].sort();

  if (speakerIds.length === 0) {
    throw new ConsentError('CONSENT_NO_SPEAKERS', stage, provider, [], 'no speakers were given');
  }
  if (campaign.provider[stage] !== provider) {
    throw new ConsentError(
      'CONSENT_PROVIDER_NOT_CONFIGURED',
      stage,
      provider,
      [],
      `campaign.yaml configures provider ${campaign.provider[stage]} for this stage; a provider change needs a config change and new consent records`,
    );
  }

  const bySpeaker = new Map(campaign.speakers.map((s) => [s.speaker_id, s]));
  const refusals: ConsentRefusal[] = [];
  for (const id of speakerIds) {
    const speaker = bySpeaker.get(id);
    if (speaker === undefined) {
      refusals.push({ speaker_id: id, reason: 'unknown-speaker' });
      continue;
    }
    if (
      stage !== 'recording' &&
      refusalFor(speaker.consent, 'recording', undefined, day) !== null
    ) {
      refusals.push({ speaker_id: id, reason: 'no-recording-consent' });
      continue;
    }
    const reason = refusalFor(speaker.consent, stage, provider, day);
    if (reason !== null) refusals.push({ speaker_id: id, reason });
  }
  if (refusals.length > 0) {
    throw new ConsentError(
      'CONSENT_MISSING',
      stage,
      provider,
      refusals,
      'missing recorded consent; add a consent record to campaign.yaml after obtaining it',
    );
  }
  return {
    stage,
    provider,
    speaker_ids: speakerIds,
    policy_hash: consentPolicyHash(campaign),
    checked_on: day,
  };
}
