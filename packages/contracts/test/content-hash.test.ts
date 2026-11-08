import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONTENT_HASH_VERSION,
  canonicalContentHash,
  canonicalContentObject,
  canonicalContentJson,
  canonicalJson,
  recapContentFromPackage,
  sha256,
  toHex,
  utf8Encode,
  validateRecapPackage,
  type Recap,
  type RecapContentInput,
  type RecapPackage,
} from '../src/index.ts';
import { FIXTURES_DIR, REPO_ROOT, readJson, readText } from './helpers.ts';

// Golden values printed in docs/adr/ADR-010-recap-editorial-state.md (worked example).
const ADR_PATH = join(REPO_ROOT, 'docs', 'adr', 'ADR-010-recap-editorial-state.md');
const EXPECTED_HASH = 'sha256:e560d03af4d61e67452491c4756ab3a4e2171c1c520d706b16147ef69987849b';
const EXPECTED_JSON =
  '{"content_hash_version":1,"language":"pt","sentences":[{"citations":{"event_ids":[],' +
  '"segment_ids":["01JBX7Q8M2N4P6R8S0T2V4W6XY:12:3"]},"sentence_id":"r2:s0","text":"O grupo ' +
  'chegou a uma ponte de pedra coberta de musgo."},{"citations":{"event_ids":["fvtt:' +
  '01JBX7A0B1C2D3E4F5G6H7J8K9:42"],"segment_ids":["01JBX7Q8M2N4P6R8S0T2V4W6XY:13:0"]},' +
  '"sentence_id":"r2:s1","text":"Bruno procurou armadilhas e notou a Vela escondida."}],' +
  '"title":"Sessão 7: A ponte de pedra"}';

const packageFixture = () =>
  readJson(join(FIXTURES_DIR, 'recap-package', 'valid.json')) as RecapPackage;
const example = (): RecapContentInput => recapContentFromPackage(packageFixture().content);

/** The worked example as a recap draft, with GM notes and other non-hashed fields. */
function exampleRecap(): Recap {
  const content = example();
  return {
    schema_version: 1,
    campaign_id: 'abomination-vaults',
    session_id: 's07',
    recap_revision: 2,
    transcription_run_id: '01JBX7Q8M2N4P6R8S0T2V4W6XY',
    classification_run_id: '01JBX7RA3C5E7G9J1K3M5N7P9Q',
    language: content.language,
    generated_at: '2026-11-02T21:00:00.000Z',
    title: content.title,
    sentences: content.sentences.map((s) => ({
      sentence_id: s.sentence_id,
      text: s.text,
      assertion: 'completed' as const,
      citations: {
        segment_ids: [...s.citations.segment_ids],
        event_ids: [...s.citations.event_ids],
      },
    })),
    gm_notes: [
      {
        note_id: 'r2:g0',
        reason: 'unresolved' as const,
        text: 'Não ficou claro se o grupo atravessou a ponte.',
        citations: { segment_ids: [], event_ids: [] },
      },
    ],
  };
}

describe('ADR-010 worked example', () => {
  it('produces the canonical JSON and hash printed in the ADR', () => {
    expect(canonicalContentJson(example())).toBe(EXPECTED_JSON);
    expect(canonicalContentHash(example())).toBe(EXPECTED_HASH);
  });

  it('the ADR prints exactly these values', () => {
    const adr = readText(ADR_PATH);
    expect(adr).toContain(`\n${EXPECTED_JSON}\n`);
    expect(adr).toContain(`\n${EXPECTED_HASH}\n`);
    expect(adr).toContain(`${String(utf8Encode(EXPECTED_JSON).length)} bytes of UTF-8`);
  });

  it('matches an independent SHA-256 of the canonical JSON', () => {
    const hex = createHash('sha256').update(EXPECTED_JSON, 'utf8').digest('hex');
    expect(EXPECTED_HASH).toBe(`sha256:${hex}`);
  });

  it('the recap-package fixture carries the real hash', () => {
    const pkg = packageFixture();
    expect(validateRecapPackage(pkg).ok).toBe(true);
    expect(pkg.content_hash).toBe(EXPECTED_HASH);
    expect(pkg.approval.approved_content_hash).toBe(EXPECTED_HASH);
  });

  it('a recap draft with the same content hashes the same as the package', () => {
    expect(canonicalContentHash(exampleRecap())).toBe(EXPECTED_HASH);
  });

  it('pins content_hash_version 1', () => {
    expect(CONTENT_HASH_VERSION).toBe(1);
  });
});

describe('canonicalization', () => {
  it('ignores key order and insignificant whitespace of the input JSON', () => {
    const pretty = JSON.stringify(packageFixture().content, null, 4);
    const reordered = JSON.parse(pretty, (_key, value: unknown) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
      return Object.fromEntries(Object.entries(value).reverse());
    }) as RecapPackage['content'];
    expect(Object.keys(reordered)[0]).toBe('footnotes');
    expect(canonicalContentHash(recapContentFromPackage(reordered))).toBe(EXPECTED_HASH);
  });

  it('sorts keys by UTF-16 code units and emits no whitespace', () => {
    expect(canonicalJson({ b: 1, a: [1, 2], A: 'x', é: 'y', _: 'z' })).toBe(
      '{"A":"x","_":"z","a":[1,2],"b":1,"é":"y"}',
    );
    expect(canonicalJson({ z: { y: 1, x: 2 } })).toBe('{"z":{"x":2,"y":1}}');
  });

  it('keeps whitespace inside text significant', () => {
    const base = example();
    const spaced: RecapContentInput = {
      ...base,
      sentences: base.sentences.map((s, i) => (i === 0 ? { ...s, text: `${s.text} ` } : s)),
    };
    const crlf: RecapContentInput = { ...base, title: `${base.title}\r\n` };
    expect(canonicalContentHash(spaced)).not.toBe(EXPECTED_HASH);
    expect(canonicalContentHash(crlf)).not.toBe(EXPECTED_HASH);
  });

  it('normalizes NFD input to NFC', () => {
    const nfdTitle = 'Sessão 7: A ponte de pedra';
    expect(nfdTitle).not.toBe(example().title);
    expect(nfdTitle.normalize('NFC')).toBe(example().title);
    const base = example();
    const nfd: RecapContentInput = {
      ...base,
      title: nfdTitle,
      sentences: base.sentences.map((s) => ({ ...s, text: s.text.normalize('NFD') })),
    };
    expect(canonicalContentHash(nfd)).toBe(EXPECTED_HASH);
    expect(canonicalContentJson(nfd)).toBe(EXPECTED_JSON);
  });

  it('escapes exactly as RFC 8785 requires', () => {
    expect(canonicalJson('"\\\b\t\n\f\r\u0000\u001f\u007f é😀')).toBe(
      '"\\"\\\\\\b\\t\\n\\f\\r\\u0000\\u001f\u007f é😀"',
    );
  });

  it('rejects values outside the JSON subset', () => {
    expect(() => canonicalJson(1.5)).toThrow(RangeError);
    expect(() => canonicalJson(2 ** 53)).toThrow(RangeError);
    expect(() => canonicalJson(null)).toThrow(TypeError);
    expect(() => canonicalJson(true)).toThrow(TypeError);
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
    expect(() => canonicalJson(new Date(0))).toThrow(TypeError);
    expect(() => canonicalJson('\ud800')).toThrow(RangeError);
    expect(() => canonicalJson({ é: 1, é: 2 })).toThrow(RangeError);
  });

  it('treats citations as sets', () => {
    const base = example();
    const second = base.sentences[1];
    if (second === undefined) throw new Error('fixture has two sentences');
    const shuffled: RecapContentInput = {
      ...base,
      sentences: [
        base.sentences[0] ?? second,
        {
          ...second,
          citations: {
            segment_ids: [...second.citations.segment_ids, ...second.citations.segment_ids],
            event_ids: [...second.citations.event_ids],
          },
        },
      ],
    };
    expect(canonicalContentHash(shuffled)).toBe(EXPECTED_HASH);
    const sorted = canonicalJson(
      canonicalContentObject(
        recapContentFromPackage({
          ...packageFixture().content,
          sentences: [{ sentence_id: 'r2:s0', text: 'x', footnote_ids: ['r2:f1', 'r2:f0'] }],
        }),
      ).sentences[0]?.citations,
    );
    // Footnotes f1 (13:0) then f0 (12:3): the canonical form is sorted regardless.
    expect(sorted).toBe(
      '{"event_ids":["fvtt:01JBX7A0B1C2D3E4F5G6H7J8K9:42"],' +
        '"segment_ids":["01JBX7Q8M2N4P6R8S0T2V4W6XY:12:3","01JBX7Q8M2N4P6R8S0T2V4W6XY:13:0"]}',
    );
  });
});

describe('what the hash covers', () => {
  it('excludes GM notes, assertions, timestamps and identity fields', () => {
    const recap = exampleRecap();
    const changed: Recap = {
      ...recap,
      recap_revision: 9,
      generated_at: '2030-01-01T00:00:00.000Z',
      transcription_run_id: '01JBZZZZZZZZZZZZZZZZZZZZZZ',
      gm_notes: [
        {
          note_id: 'r2:g0',
          reason: 'spoiler',
          text: 'Outro texto só para o mestre.',
          citations: { segment_ids: ['01JBX7Q8M2N4P6R8S0T2V4W6XY:1:1'], event_ids: [] },
        },
        {
          note_id: 'r2:g1',
          reason: 'conflict',
          text: 'Nota nova.',
          citations: { segment_ids: [], event_ids: [] },
        },
      ],
      sentences: recap.sentences.map((s) => ({
        ...s,
        assertion: 'background' as const,
        outcome_basis: 'narrative' as const,
      })),
    };
    expect(canonicalContentHash(changed)).toBe(EXPECTED_HASH);
    expect(canonicalContentHash({ ...recap, gm_notes: [] })).toBe(EXPECTED_HASH);
    expect(canonicalContentJson(changed)).not.toContain('mestre');
  });

  it('excludes footnote layout and evidence context in a package', () => {
    const content = packageFixture().content;
    const regrouped: RecapPackage['content'] = {
      ...content,
      sentences: content.sentences.map((s, i) => ({
        ...s,
        footnote_ids: i === 0 ? ['r2:f7'] : ['r2:f8', 'r2:f9'],
      })),
      footnotes: [
        {
          footnote_id: 'r2:f9',
          evidence: [{ kind: 'event', ref: 'fvtt:01JBX7A0B1C2D3E4F5G6H7J8K9:42' }],
        },
        {
          footnote_id: 'r2:f8',
          evidence: [
            { kind: 'segment', ref: '01JBX7Q8M2N4P6R8S0T2V4W6XY:13:0', excerpt: 'Outro.' },
          ],
        },
        {
          footnote_id: 'r2:f7',
          evidence: [{ kind: 'segment', ref: '01JBX7Q8M2N4P6R8S0T2V4W6XY:12:3' }],
        },
      ],
    };
    expect(canonicalContentHash(recapContentFromPackage(regrouped))).toBe(EXPECTED_HASH);
  });

  it('changes on any player-facing content or citation change', () => {
    const base = example();
    const [first, second] = base.sentences;
    if (first === undefined || second === undefined) throw new Error('fixture has two sentences');
    const variants: RecapContentInput[] = [
      { ...base, title: 'Sessão 7: A ponte de Pedra' },
      { ...base, language: 'pt-BR' },
      { ...base, sentences: [second, first] },
      { ...base, sentences: [first] },
      { ...base, sentences: [{ ...first, text: 'O grupo chegou a uma ponte.' }, second] },
      { ...base, sentences: [{ ...first, sentence_id: 'r3:s0' }, second] },
      {
        ...base,
        sentences: [first, { ...second, citations: { ...second.citations, event_ids: [] } }],
      },
      {
        ...base,
        sentences: [
          {
            ...first,
            citations: {
              ...first.citations,
              segment_ids: [...first.citations.segment_ids, '01JBX7Q8M2N4P6R8S0T2V4W6XY:12:4'],
            },
          },
          second,
        ],
      },
    ];
    const hashes = new Set(variants.map((v) => canonicalContentHash(v)));
    expect(hashes.size).toBe(variants.length);
    expect(hashes.has(EXPECTED_HASH)).toBe(false);
  });

  it('rejects a package sentence that references a missing footnote', () => {
    const content = packageFixture().content;
    expect(() =>
      recapContentFromPackage({
        ...content,
        sentences: [{ sentence_id: 'r2:s0', text: 'x', footnote_ids: ['r2:f99'] }],
      }),
    ).toThrow(RangeError);
  });
});

describe('pure-JS SHA-256', () => {
  it('matches the FIPS 180-4 test vectors', () => {
    expect(toHex(sha256(utf8Encode('')))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(toHex(sha256(utf8Encode('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    const twoBlocks = 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq';
    expect(toHex(sha256(utf8Encode(twoBlocks)))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('matches node:crypto across block boundaries and non-ASCII input', () => {
    const samples: string[] = [];
    for (let n = 0; n <= 200; n++) samples.push('a'.repeat(n));
    samples.push('ção😀\u0000\u007fࠀ￿'.repeat(97), 'Sessão 7: A ponte de pedra');
    for (const s of samples) {
      const expected = createHash('sha256').update(s, 'utf8').digest('hex');
      expect(toHex(sha256(utf8Encode(s)))).toBe(expected);
    }
  });

  it('encodes UTF-8 like the platform and rejects lone surrogates', () => {
    const s = 'aé€😀';
    expect([...utf8Encode(s)]).toEqual([...new TextEncoder().encode(s)]);
    expect(() => utf8Encode('x\udc00')).toThrow(RangeError);
  });
});
