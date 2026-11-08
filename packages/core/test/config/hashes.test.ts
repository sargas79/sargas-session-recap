import type { CampaignConfig, Glossary } from '@sargas-recap/contracts';
import { describe, expect, it } from 'vitest';
import {
  asrPromptTerms,
  configVersion,
  contentHash,
  canonicalJson,
  DEPENDENCY_STAGES,
  type DependencyStage,
} from '../../src/config/index.ts';
import { at, campaign, glossary } from './helpers.ts';

type Mutation = (c: CampaignConfig, g: Glossary) => void;

function changedStages(mutate: Mutation) {
  const c = campaign();
  const g = glossary();
  const before = configVersion(c, g);
  mutate(c, g);
  const after = configVersion(c, g);
  return {
    stages: DEPENDENCY_STAGES.filter((s) => before.stage_hashes[s] !== after.stage_hashes[s]),
    campaign: before.campaign_hash !== after.campaign_hash,
    glossary: before.glossary_hash !== after.glossary_hash,
    consent: before.consent_policy_hash !== after.consent_policy_hash,
  };
}

const entry = (g: Glossary, id: string) => {
  const e = g.entries.find((x) => x.id === id);
  if (e === undefined) throw new Error(id);
  return e;
};

describe('stage dependency hashes', () => {
  const cases: [string, Mutation, DependencyStage[]][] = [
    [
      'glossary mishearings',
      (_c, g) => entry(g, 'sarenrae').mishearings?.push('Sarah Ray'),
      ['classification'],
    ],
    ['glossary description', (_c, g) => (entry(g, 'otari').description = 'Changed.'), ['recap']],
    ['campaign background', (c) => (c.background = 'Changed.'), ['recap']],
    ['ASR provider', (c) => (c.provider.asr = 'whisper-local-v2'), ['asr']],
    [
      'classification provider',
      (c) => (c.provider.classification = 'other-llm'),
      ['classification'],
    ],
    ['recap provider', (c) => (c.provider.recap = 'other-llm'), ['recap']],
    ['entry type', (_c, g) => (entry(g, 'otari').type = 'faction'), ['classification', 'recap']],
    ['entry id', (_c, g) => (entry(g, 'otari').id = 'otari-town'), ['classification', 'recap']],
    [
      'speaker characters',
      (c) => c.speakers[1]?.characters?.push('Ezren'),
      ['classification', 'recap'],
    ],
    [
      'English flag',
      (_c, g) => (entry(g, 'kyra').is_english_term = true),
      ['asr', 'classification'],
    ],
    [
      'spelling',
      (_c, g) => (entry(g, 'kyra').spelling = 'Kira'),
      ['asr', 'classification', 'recap'],
    ],
    ['language', (c) => (c.language = 'en'), ['asr', 'classification', 'recap']],
    ['speaker display name', (c) => (at(c.speakers, 0).display_name = 'Renamed'), []],
    [
      'consent records',
      (c) =>
        c.speakers[2]?.consent.push({
          purpose: 'recap',
          provider: 'claude-cli',
          granted_on: '2026-03-01',
        }),
      [],
    ],
    ['glossary entry order', (_c, g) => g.entries.reverse(), []],
    [
      'explicit defaults',
      (_c, g) => {
        entry(g, 'kyra').is_english_term = false;
        entry(g, 'otari').mishearings = [];
      },
      [],
    ],
  ];

  it.each(cases)(
    'changing %s changes exactly the expected stage hashes',
    (_label, mutate, want) => {
      expect(changedStages(mutate).stages).toEqual(want);
    },
  );

  it('consent changes leave stage hashes alone but change the campaign and consent hashes', () => {
    const r = changedStages((c) => {
      const rec = c.speakers[2]?.consent[2];
      if (rec) delete rec.withdrawn_on;
    });
    expect(r).toEqual({ stages: [], campaign: true, glossary: false, consent: true });
  });

  it('reordering entries changes the glossary content hash but not stage hashes', () => {
    expect(changedStages((_c, g) => g.entries.reverse())).toMatchObject({
      stages: [],
      glossary: true,
    });
  });

  it('is deterministic and well-formed', () => {
    const a = configVersion(campaign(), glossary());
    const b = configVersion(campaign(), glossary());
    expect(a).toEqual(b);
    for (const h of [a.campaign_hash, a.glossary_hash, ...Object.values(a.stage_hashes)]) {
      expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    expect(new Set(Object.values(a.stage_hashes)).size).toBe(3);
  });

  it('ASR prompt terms are sorted by spelling', () => {
    expect(asrPromptTerms(glossary()).map((t) => t.spelling)).toEqual([
      'Kyra',
      'Otari',
      'Sarenrae',
      'flat-footed',
    ]);
  });
});

describe('canonical JSON', () => {
  it('sorts keys and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'], c: undefined })).toBe(
      '{"a":[true,null,"x"],"b":1}',
    );
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
  });

  it('rejects non-JSON values', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson(new Date(0))).toThrow(TypeError);
  });
});
