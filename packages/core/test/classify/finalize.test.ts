import { describe, expect, it } from 'vitest';
import type { ClassificationModelResult } from '@sargas-recap/contracts';
import {
  applyCorrections,
  coverageProblems,
  finalizeWindow,
  glossarySpellings,
  type ClassificationWindow,
  type Correction,
} from '../../src/classify/index.ts';
import { glossary } from '../config/helpers.ts';
import { RUN_ID, segment } from './helpers.ts';

const spellings = glossarySpellings(glossary());
const name = (from: string): Correction => ({
  kind: 'name',
  from,
  to: 'Kyra',
  glossary_id: 'kyra',
});

describe('applyCorrections', () => {
  it('replaces every whole-word occurrence and reports what it applied', () => {
    const outcome = applyCorrections('Kira viu Kira agora', [name('Kira')], spellings);
    expect(outcome.text).toBe('Kyra viu Kyra agora');
    expect(outcome.applied).toHaveLength(1);
    expect(outcome.rejected).toEqual([]);
  });

  it('never matches inside a longer word, accents included', () => {
    expect(applyCorrections('Kirana chegou', [name('Kira')], spellings).rejected[0]?.reason).toBe(
      'source-not-in-text',
    );
    expect(applyCorrections('Kiração é outra', [name('Kira')], spellings).text).toBeUndefined();
  });

  it('treats regex characters in the source literally', () => {
    const correction: Correction = { kind: 'spelling', from: 'a.c', to: 'abc' };
    expect(applyCorrections('xyz abc', [correction], spellings).text).toBeUndefined();
    expect(applyCorrections('xyz a.c', [correction], spellings).text).toBe('xyz abc');
  });

  it.each([
    ['akyra', 'a Kyra'],
    ['Dekyra', 'de Kyra'],
    ['Akyra', 'à Kyra'],
  ])('splits a function word joined to a glossary name: %s -> %s', (from, to) => {
    const correction: Correction = { kind: 'name', from, to, glossary_id: 'kyra' };
    const outcome = applyCorrections(`viu ${from} ontem`, [correction], spellings);
    expect(outcome.text).toBe(`viu ${to} ontem`);
    expect(outcome.rejected).toEqual([]);
  });

  it.each([
    ['the name itself is misheard', 'akira', 'a Kyra'],
    ['not a function word', 'vilaokyra', 'vilao Kyra'],
    ['the word differs from the joined one', 'akyra', 'de Kyra'],
    ['extra text after the name', 'akyra', 'a Kyra agora'],
    ['extra text before the word', 'akyra', 'nunca a Kyra'],
  ])('still rejects a joined-name fix when %s', (_why, from, to) => {
    const correction: Correction = { kind: 'name', from, to, glossary_id: 'kyra' };
    const outcome = applyCorrections(`viu ${from} ontem`, [correction], spellings);
    expect(outcome.rejected.map((r) => r.reason)).toEqual(['glossary-mismatch']);
    expect(outcome.text).toBeUndefined();
  });

  it('keeps a replacement containing $ literal', () => {
    const correction: Correction = { kind: 'spelling', from: 'moeda', to: '$& ouro' };
    expect(applyCorrections('uma moeda', [correction], spellings).text).toBe('uma $& ouro');
  });

  it.each([
    ['no-change', { kind: 'spelling', from: 'x', to: 'x' }],
    ['unknown-glossary-entry', { kind: 'name', from: 'Kira', to: 'Kyra', glossary_id: 'nope' }],
    ['glossary-mismatch', { kind: 'name', from: 'Kira', to: 'Kirah', glossary_id: 'kyra' }],
    ['glossary-mismatch', { kind: 'term', from: 'Kira', to: 'Kyra' }],
    ['source-not-in-text', { kind: 'spelling', from: 'ausente', to: 'presente' }],
  ] as [string, Correction][])('rejects as %s', (reason, correction) => {
    const outcome = applyCorrections('Kira x', [correction], spellings);
    expect(outcome.rejected.map((r) => r.reason)).toEqual([reason]);
    expect(outcome.text).toBeUndefined();
  });

  it('applies the longer of two overlapping proposals and rejects the other', () => {
    const outcome = applyCorrections(
      'Dona Kira chegou',
      [name('Kira'), { kind: 'spelling', from: 'Dona Kira', to: 'Dona Kyra' }],
      spellings,
    );
    expect(outcome.text).toBe('Dona Kyra chegou');
    expect(outcome.rejected.map((r) => r.reason)).toEqual(['overlap']);
  });
});

const core = [
  segment(1, 0, 'gm', 0, 'Kira entra'),
  segment(1, 1, 'gm', 5_000, 'segundo'),
  segment(2, 0, 'player-ana', 10_000, 'terceiro', { flags: ['repetition_loop'] }),
];
const window: ClassificationWindow = {
  index: 3,
  core,
  contextBefore: [segment(0, 0, 'gm', -5_000, 'antes')],
  contextAfter: [segment(3, 0, 'gm', 20_000, 'depois')],
};
const identity = { classificationRunId: '01JBX7RA3C5E7G9J1K3M5N7P9Q', transcriptionRunId: RUN_ID };
const item = (ref: string, label: ClassificationModelResult['label'] = 'ic') => ({
  segment_ref: ref,
  label,
  corrections: [],
  unmatched_names: [],
  possible_spoiler: false,
});
const refs = ['1:0', '1:1', '2:0'];

describe('finalizeWindow', () => {
  it('fills in everything the model cannot know', () => {
    const outcome = finalizeWindow(
      window,
      refs.map((r) => item(r)),
      identity,
      spellings,
    );
    if (!outcome.ok) throw new Error(outcome.problems.join(';'));
    const first = outcome.window.records[0];
    expect(first).toMatchObject({
      schema_version: 1,
      classification_run_id: identity.classificationRunId,
      transcription_run_id: RUN_ID,
      segment_id: `${RUN_ID}:1:0`,
      window_index: 3,
      event_ids: [],
    });
  });

  it.each([
    ['missing', ['1:0', '1:1'], 'is missing'],
    ['duplicate', [...refs, '1:0'], 'more than once'],
    ['unknown', [...refs, '9:9'], 'not in this window'],
    ['a context ID', [...refs, '0:0'], 'not in this window'],
  ])('rejects %s', (_name, output, expected) => {
    const outcome = finalizeWindow(
      window,
      output.map((r) => item(r)),
      identity,
      spellings,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.problems.join('\n')).toContain(expected);
  });

  it('requires review for mixed, uncertain and repetition loops', () => {
    const outcome = finalizeWindow(
      window,
      [item('1:0', 'mixed'), item('1:1', 'uncertain'), item('2:0')],
      identity,
      spellings,
    );
    if (!outcome.ok) throw new Error(outcome.problems.join(';'));
    expect(outcome.window.records.map((r) => r.review_required)).toEqual([true, true, true]);
    expect(outcome.window.records[2]?.flags).toContain('low_asr_confidence');
  });

  it('applies corrections without touching the original text', () => {
    const before = JSON.stringify(window);
    const output = refs.map((r) =>
      r === '1:0'
        ? {
            ...item(r),
            corrections: [name('Kira')],
            unmatched_names: ['Kira', 'Nowhere'],
            possible_spoiler: true,
          }
        : item(r),
    );
    const outcome = finalizeWindow(window, output, identity, spellings);
    if (!outcome.ok) throw new Error(outcome.problems.join(';'));
    const first = outcome.window.records[0];
    expect(first?.text_corrected).toBe('Kyra entra');
    expect(first?.flags).toEqual(['names_unmatched', 'possible_spoiler']);
    expect(outcome.window.unmatched).toEqual([{ segment_id: `${RUN_ID}:1:0`, name: 'Kira' }]);
    expect(outcome.window.fixed).toEqual([{ segment_id: `${RUN_ID}:1:0`, ...name('Kira') }]);
    expect(JSON.stringify(window)).toBe(before);
    expect(first).not.toHaveProperty('text_original');
  });

  it('never carries transcript words in a problem', () => {
    const outcome = finalizeWindow(window, [item('1:0')], identity, spellings);
    if (outcome.ok) throw new Error('expected problems');
    expect(outcome.problems.join('\n')).not.toMatch(/segundo|terceiro|Kira/);
  });
});

describe('coverageProblems', () => {
  it('finds segments with no record and records of no segment', () => {
    const record = (id: string) =>
      ({ segment_id: id }) as Parameters<typeof coverageProblems>[1][number];
    expect(
      coverageProblems(
        core,
        core.map((s) => record(s.segment_id)),
      ),
    ).toEqual([]);
    expect(coverageProblems(core, [record(`${RUN_ID}:1:0`)])).toHaveLength(2);
    expect(
      coverageProblems(core, [...core.map((s) => record(s.segment_id)), record(`${RUN_ID}:9:9`)]),
    ).toHaveLength(1);
  });
});
