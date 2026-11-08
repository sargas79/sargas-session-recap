import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ConsentError,
  assertConsent,
  consentPolicyHash,
  type AssertConsentInput,
} from '../../src/config/index.ts';
import { at, campaign, recordsOf } from './helpers.ts';

const NOW = new Date('2026-03-15T12:00:00Z');

function refusal(input: Omit<AssertConsentInput, 'now'> & { now?: Date }): ConsentError {
  try {
    assertConsent({ now: NOW, ...input });
  } catch (err) {
    if (err instanceof ConsentError) return err;
    throw err;
  }
  throw new Error('expected a ConsentError');
}

describe('assertConsent', () => {
  it('allows a call when every included speaker consented to this provider and purpose', () => {
    const c = campaign();
    const receipt = assertConsent({
      campaign: c,
      speakerIds: ['player-ana', 'gm', 'gm'],
      provider: 'claude-cli',
      stage: 'recap',
      now: NOW,
    });
    expect(receipt).toEqual({
      stage: 'recap',
      mode: 'records',
      provider: 'claude-cli',
      speaker_ids: ['gm', 'player-ana'],
      policy_hash: consentPolicyHash(c),
      checked_on: '2026-03-15',
    });
    expect(() =>
      assertConsent({
        campaign: c,
        speakerIds: ['player-bruno'],
        provider: 'whisper-local',
        stage: 'asr',
        now: NOW,
      }),
    ).not.toThrow();
  });

  it('refuses when any included speaker never consented to the purpose', () => {
    const err = refusal({
      campaign: campaign(),
      speakerIds: ['gm', 'player-bruno'],
      provider: 'claude-cli',
      stage: 'recap',
    });
    expect(err.code).toBe('CONSENT_MISSING');
    expect(err.refusals).toEqual([{ speaker_id: 'player-bruno', reason: 'no-record' }]);
    expect(err.message).toContain('player-bruno');
    expect(err.message).not.toContain('gm (');
  });

  it('refuses withdrawn consent from the withdrawal day on, and allows it before', () => {
    const c = campaign();
    const input = {
      campaign: c,
      speakerIds: ['player-bruno'],
      provider: 'claude-cli',
      stage: 'classification',
    } as const;
    expect(refusal(input).refusals).toEqual([{ speaker_id: 'player-bruno', reason: 'withdrawn' }]);
    expect(refusal({ ...input, now: new Date('2026-02-01T00:00:00Z') }).code).toBe(
      'CONSENT_MISSING',
    );
    expect(() => assertConsent({ ...input, now: new Date('2026-01-31T23:59:59Z') })).not.toThrow();
  });

  it('refuses consent granted after the processing day', () => {
    const err = refusal({
      campaign: campaign(),
      speakerIds: ['gm'],
      provider: 'claude-cli',
      stage: 'recap',
      now: new Date('2026-01-09T12:00:00Z'),
    });
    expect(err.refusals[0]?.reason).toBe('no-recording-consent');
  });

  it('a newer grant after a withdrawal restores consent; a newer withdrawal wins', () => {
    const c = campaign();
    const bruno = at(c.speakers, 2);
    recordsOf(bruno).push({
      purpose: 'classification',
      provider: 'claude-cli',
      granted_on: '2026-03-01',
    });
    const input = {
      campaign: c,
      speakerIds: ['player-bruno'],
      provider: 'claude-cli',
      stage: 'classification',
    } as const;
    expect(() => assertConsent({ ...input, now: NOW })).not.toThrow();
    recordsOf(bruno).push({
      purpose: 'classification',
      provider: 'claude-cli',
      granted_on: '2026-03-01',
      withdrawn_on: '2026-03-10',
    });
    expect(refusal(input).refusals[0]?.reason).toBe('withdrawn');
  });

  it('a withdrawal on an older record after a newer re-grant still refuses', () => {
    const c = campaign();
    const bruno = at(c.speakers, 2);
    // Granted 2026-01-01 (fixture), re-granted 2026-03-01, then the old record is withdrawn later.
    recordsOf(bruno).push({
      purpose: 'classification',
      provider: 'claude-cli',
      granted_on: '2026-03-01',
    });
    const old = recordsOf(bruno).findIndex(
      (r) => r.purpose === 'classification' && r.granted_on < '2026-03-01',
    );
    expect(old).toBeGreaterThanOrEqual(0);
    recordsOf(bruno)[old] = { ...at(recordsOf(bruno), old), withdrawn_on: '2026-03-05' };
    const input = {
      campaign: c,
      speakerIds: ['player-bruno'],
      provider: 'claude-cli',
      stage: 'classification',
    } as const;
    expect(refusal(input).refusals[0]?.reason).toBe('withdrawn');
  });

  describe('consent_mode: implied', () => {
    const implied = () => {
      const c = campaign();
      c.consent_mode = 'implied';
      for (const sp of c.speakers) delete sp.consent;
      return c;
    };

    it('allows every listed speaker without any consent records', () => {
      const c = implied();
      const receipt = assertConsent({
        campaign: c,
        speakerIds: c.speakers.map((sp) => sp.speaker_id),
        provider: 'claude-cli',
        stage: 'recap',
        now: NOW,
      });
      expect(receipt.mode).toBe('implied');
      expect(receipt.policy_hash).toBe(consentPolicyHash(c));
    });

    it('ignores withdrawn or missing records', () => {
      const c = campaign();
      c.consent_mode = 'implied';
      // player-bruno's classification consent is withdrawn in the fixture.
      expect(() =>
        assertConsent({
          campaign: c,
          speakerIds: ['player-bruno'],
          provider: 'claude-cli',
          stage: 'classification',
          now: NOW,
        }),
      ).not.toThrow();
    });

    it('still refuses speakers that are not listed in campaign.yaml', () => {
      const r = refusal({
        campaign: implied(),
        speakerIds: ['gm', 'stray-track'],
        provider: 'claude-cli',
        stage: 'recap',
      });
      expect(r.refusals).toEqual([{ speaker_id: 'stray-track', reason: 'unknown-speaker' }]);
    });

    it('still refuses a provider that is not configured for the stage', () => {
      expect(
        refusal({ campaign: implied(), speakerIds: ['gm'], provider: 'other-llm', stage: 'recap' })
          .code,
      ).toBe('CONSENT_PROVIDER_NOT_CONFIGURED');
    });

    it('changes the consent policy hash, so runs record which mode applied', () => {
      const c = campaign();
      const before = consentPolicyHash(c);
      c.consent_mode = 'implied';
      expect(consentPolicyHash(c)).not.toBe(before);
      c.consent_mode = 'records';
      expect(consentPolicyHash(c)).toBe(before);
    });
  });

  it('requires active recording consent for AI stages', () => {
    const c = campaign();
    const ana = at(c.speakers, 1);
    recordsOf(ana)[0] = { ...at(recordsOf(ana), 0), withdrawn_on: '2026-03-01' };
    const err = refusal({
      campaign: c,
      speakerIds: ['player-ana'],
      provider: 'whisper-local',
      stage: 'asr',
    });
    expect(err.refusals).toEqual([{ speaker_id: 'player-ana', reason: 'no-recording-consent' }]);
    expect(
      refusal({ campaign: c, speakerIds: ['player-ana'], provider: 'craig', stage: 'recording' })
        .refusals[0]?.reason,
    ).toBe('withdrawn');
  });

  it('refuses unknown speakers and an empty speaker list (fail closed)', () => {
    const c = campaign();
    expect(
      refusal({
        campaign: c,
        speakerIds: ['gm', 'stranger'],
        provider: 'claude-cli',
        stage: 'recap',
      }).refusals,
    ).toEqual([{ speaker_id: 'stranger', reason: 'unknown-speaker' }]);
    expect(
      refusal({ campaign: c, speakerIds: [], provider: 'claude-cli', stage: 'recap' }).code,
    ).toBe('CONSENT_NO_SPEAKERS');
  });

  describe('provider change requires new consent', () => {
    it('refuses a provider other than the configured one', () => {
      const err = refusal({
        campaign: campaign(),
        speakerIds: ['gm'],
        provider: 'other-llm',
        stage: 'recap',
      });
      expect(err.code).toBe('CONSENT_PROVIDER_NOT_CONFIGURED');
      expect(err.message).toContain('claude-cli');
    });

    it('refuses the newly configured provider until consent for it is recorded', () => {
      const c = campaign();
      c.provider.recap = 'other-llm';
      const err = refusal({
        campaign: c,
        speakerIds: ['gm', 'player-ana'],
        provider: 'other-llm',
        stage: 'recap',
      });
      expect(err.code).toBe('CONSENT_MISSING');
      expect(err.refusals).toEqual([
        { speaker_id: 'gm', reason: 'no-record' },
        { speaker_id: 'player-ana', reason: 'no-record' },
      ]);
      // The old provider is no longer configured either.
      expect(
        refusal({ campaign: c, speakerIds: ['gm'], provider: 'claude-cli', stage: 'recap' }).code,
      ).toBe('CONSENT_PROVIDER_NOT_CONFIGURED');
      for (const s of c.speakers.slice(0, 2)) {
        recordsOf(s).push({ purpose: 'recap', provider: 'other-llm', granted_on: '2026-03-02' });
      }
      expect(() =>
        assertConsent({
          campaign: c,
          speakerIds: ['gm', 'player-ana'],
          provider: 'other-llm',
          stage: 'recap',
          now: NOW,
        }),
      ).not.toThrow();
    });
  });
});

describe('single consent choke point', () => {
  const packagesDir = fileURLToPath(new URL('../../../', import.meta.url));
  const sources = ['contracts', 'core', 'foundry-module'].flatMap((pkg) =>
    readdirSync(join(packagesDir, pkg, 'src'), { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.ts'))
      .map((d) => join(d.parentPath, d.name)),
  );

  it('defines assertConsent exactly once, in packages/core/src/config/consent.ts', () => {
    const defining = sources
      .filter((f) =>
        /\bfunction\s+assertConsent\b|\bassertConsent\s*=/.test(readFileSync(f, 'utf8')),
      )
      .map((f) => relative(packagesDir, f).replace(/\\/g, '/'));
    expect(defining).toEqual(['core/src/config/consent.ts']);
  });
});
