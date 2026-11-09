import { validateContract, type TranscriptionSegment } from '@sargas-recap/contracts';
import { describe, expect, it } from 'vitest';
import {
  projectEffectiveTranscript,
  toEffectiveTranscript,
  unreconciledExclusions,
  type ProjectionInput,
  type StoredOverride,
} from '../../src/review/index.ts';
import { CAMPAIGN, CLASS_1, result, RUN_A, RUN_B, seg, SESSION } from './helpers.ts';

const A = seg(RUN_A, 0, 0, 1_000, 'Texto original sintetico.');
const OVERRIDE_ID = '01JBX8M0N1P2Q3R4S5T6V7W8X9';

function override(extra: Partial<StoredOverride> = {}): StoredOverride {
  return {
    schema_version: 1,
    override_id: OVERRIDE_ID,
    campaign_id: CAMPAIGN,
    session_id: SESSION,
    transcription_run_id: RUN_A,
    segment_id: A.segment_id,
    base_text_hash: A.text_hash,
    recap_inclusion: null,
    exclusion_reasons: [],
    review_status: 'pending',
    reconciliation: 'attached',
    revision: 1,
    created_at: '2026-11-02T20:00:00.000Z',
    updated_at: '2026-11-02T20:00:00.000Z',
    ...extra,
  };
}

function input(extra: Partial<ProjectionInput> = {}): ProjectionInput {
  return {
    campaignId: CAMPAIGN,
    sessionId: SESSION,
    transcriptionRunId: RUN_A,
    segments: [A],
    classification: null,
    overrides: [],
    generatedAt: '2026-11-02T20:06:00.000Z',
    ...extra,
  };
}

function single(extra: Partial<ProjectionInput>) {
  const view = projectEffectiveTranscript(input(extra));
  const first = view.segments[0];
  if (first === undefined) throw new Error('no segment');
  return first;
}

const classified = (label: Parameters<typeof result>[2], extra = {}) => ({
  runId: CLASS_1,
  results: [result(CLASS_1, A, label, extra)],
});

describe('effective text', () => {
  const correction = {
    text_corrected: 'Texto corrigido sintetico.',
    corrections: [{ kind: 'spelling' as const, from: 'original', to: 'corrigido' }],
  };

  it('is the original without classification', () => {
    const s = single({});
    expect(s).toMatchObject({ text: A.text_original, text_source: 'original', label: null });
    expect(s.recap_inclusion).toBe('unresolved');
  });

  it('prefers the correction over the original and shows what changed', () => {
    const s = single({ classification: classified('ic', correction) });
    expect(s).toMatchObject({ text: correction.text_corrected, text_source: 'corrected' });
    expect(s.text_original).toBe(A.text_original);
    expect(s.corrections).toEqual(correction.corrections);
  });

  it('prefers the GM text over the correction, and keeps both reachable', () => {
    const s = single({
      classification: classified('ic', correction),
      overrides: [override({ text_override: 'Texto do mestre.' })],
    });
    expect(s).toMatchObject({
      text: 'Texto do mestre.',
      text_source: 'override',
      text_override: 'Texto do mestre.',
      text_corrected: correction.text_corrected,
      text_original: A.text_original,
    });
  });
});

describe('labels and recap inclusion', () => {
  it.each([
    ['ic', 'include'],
    ['narration', 'include'],
    ['rules', 'include'],
    ['ooc', 'exclude'],
    ['mixed', 'unresolved'],
    ['uncertain', 'unresolved'],
  ] as const)('%s defaults to %s', (label, expected) => {
    expect(single({ classification: classified(label) })).toMatchObject({
      label,
      label_source: 'classification',
      recap_inclusion: expected,
    });
  });

  it('a label override moves the default, and keeps the classification label visible', () => {
    const s = single({
      classification: classified('ic'),
      overrides: [override({ label_override: 'ooc' })],
    });
    expect(s).toMatchObject({
      label: 'ooc',
      label_source: 'override',
      recap_inclusion: 'exclude',
      classification_label: 'ic',
    });
  });

  it('an explicit decision beats the default, including an explicit unresolved', () => {
    const on = (recap_inclusion: StoredOverride['recap_inclusion'], label: 'ooc' | 'ic') =>
      single({ classification: classified(label), overrides: [override({ recap_inclusion })] })
        .recap_inclusion;
    expect(on('include', 'ooc')).toBe('include');
    expect(on('exclude', 'ic')).toBe('exclude');
    expect(on('unresolved', 'ic')).toBe('unresolved');
  });

  it('an override with no inclusion decision leaves the default alone', () => {
    expect(
      single({
        classification: classified('ic'),
        overrides: [override({ review_status: 'reviewed' })],
      }),
    ).toMatchObject({ recap_inclusion: 'include', review_status: 'reviewed' });
  });

  it.each(['spoiler', 'privacy', 'off-topic'] as const)(
    'a %s exclusion wins over an explicit include',
    (reason) => {
      expect(
        single({
          classification: classified('ic'),
          overrides: [override({ recap_inclusion: 'include', exclusion_reasons: [reason] })],
        }),
      ).toMatchObject({ recap_inclusion: 'exclude', exclusion_reasons: [reason] });
    },
  );
});

describe('mixed content', () => {
  const mixed = (extra: Partial<StoredOverride>) =>
    single({ classification: classified('mixed'), overrides: [override(extra)] }).recap_inclusion;

  it('stays out with no cleaned text and no decision', () => {
    expect(mixed({ review_status: 'reviewed' })).toBe('unresolved');
  });

  it('enters with cleaned text', () => {
    expect(mixed({ text_override: 'Parte em jogo.' })).toBe('include');
  });

  it('enters with an explicit inclusion', () => {
    expect(mixed({ recap_inclusion: 'include' })).toBe('include');
  });

  it('an explicit exclude beats cleaned text', () => {
    expect(mixed({ text_override: 'Parte em jogo.', recap_inclusion: 'exclude' })).toBe('exclude');
  });

  it('cleaned text does not pull an OOC segment in', () => {
    expect(
      single({
        classification: classified('ooc'),
        overrides: [override({ text_override: 'Limpo.' })],
      }).recap_inclusion,
    ).toBe('exclude');
  });
});

describe('ASR doubts stay visible', () => {
  it.each(['repetition_loop', 'low_confidence'] as const)(
    'keeps a %s segment and asks for review, even when excluded',
    (flag) => {
      const flagged = seg(RUN_A, 0, 1, 9_000, 'la la la la', { flags: [flag] });
      const view = projectEffectiveTranscript(
        input({
          segments: [A, flagged],
          classification: { runId: CLASS_1, results: [result(CLASS_1, flagged, 'ooc')] },
        }),
      );
      expect(view.segments).toHaveLength(2);
      expect(view.segments[1]).toMatchObject({
        segment_id: flagged.segment_id,
        review_required: true,
        segment_flags: [flag],
        recap_inclusion: 'exclude',
      });
    },
  );

  it('keeps a segment missing from the results, unclassified', () => {
    const other = seg(RUN_A, 0, 1, 9_000, 'Sem resultado.');
    const view = projectEffectiveTranscript(
      input({
        segments: [A, other],
        classification: { runId: CLASS_1, results: [result(CLASS_1, A, 'ic')] },
      }),
    );
    expect(view.segments[1]).toMatchObject({ label: null, recap_inclusion: 'unresolved' });
  });
});

describe('reconciliation (ADR-005)', () => {
  const spoiler = (extra: Partial<StoredOverride>) =>
    override({ exclusion_reasons: ['spoiler'], recap_inclusion: 'exclude', ...extra });

  it('applies an override whose identity matches', () => {
    const view = projectEffectiveTranscript(input({ overrides: [spoiler({})] }));
    expect(view.needs_reconciliation).toEqual([]);
    expect(view.segments[0]?.override_id).toBe(OVERRIDE_ID);
  });

  it('never moves an override across runs, even with the same text and timing', () => {
    const twin: TranscriptionSegment = seg(RUN_B, 0, 0, 1_000, A.text_original);
    const view = projectEffectiveTranscript(
      input({ transcriptionRunId: RUN_B, segments: [twin], overrides: [spoiler({})] }),
    );
    expect(view.segments[0]).toMatchObject({
      recap_inclusion: 'unresolved',
      exclusion_reasons: [],
    });
    expect(view.segments[0]?.override_id).toBeUndefined();
    expect(view.needs_reconciliation).toEqual([
      {
        override_id: OVERRIDE_ID,
        transcription_run_id: RUN_A,
        segment_id: A.segment_id,
        reason: 'run_changed',
        exclusion_reasons: ['spoiler'],
      },
    ]);
    expect(unreconciledExclusions(view)).toHaveLength(1);
  });

  it('flags a changed text hash and a missing segment', () => {
    const changed = projectEffectiveTranscript(
      input({ overrides: [override({ base_text_hash: `sha256:${'0'.repeat(64)}` })] }),
    );
    expect(changed.needs_reconciliation[0]?.reason).toBe('text_changed');
    expect(changed.segments[0]?.override_id).toBeUndefined();
    const missing = projectEffectiveTranscript(
      input({ overrides: [override({ segment_id: `${RUN_A}:9:9` })] }),
    );
    expect(missing.needs_reconciliation[0]?.reason).toBe('segment_missing');
  });

  it('only spoiler and privacy block a recap', () => {
    const view = projectEffectiveTranscript(
      input({
        transcriptionRunId: RUN_B,
        segments: [seg(RUN_B, 0, 0, 1_000, 'Outro.')],
        overrides: [override({ exclusion_reasons: ['off-topic'] })],
      }),
    );
    expect(view.needs_reconciliation).toHaveLength(1);
    expect(unreconciledExclusions(view)).toEqual([]);
  });
});

describe('contracts', () => {
  it('both views validate, and the plain view carries no review detail', () => {
    const view = projectEffectiveTranscript(
      input({
        classification: classified('mixed', { flags: ['low_asr_confidence'] }),
        overrides: [override({ text_override: 'Limpo.', label_override: 'ic' })],
      }),
    );
    expect(validateContract('effective-transcript-review', view).ok).toBe(true);
    const plain = toEffectiveTranscript(view);
    expect(validateContract('effective-transcript', plain).ok).toBe(true);
    expect(plain.segments[0]).not.toHaveProperty('text_original');
  });

  it('orders segments by session time', () => {
    const later = seg(RUN_A, 1, 0, 50_000, 'Depois.');
    const view = projectEffectiveTranscript(input({ segments: [later, A] }));
    expect(view.segments.map((s) => s.segment_id)).toEqual([A.segment_id, later.segment_id]);
  });
});
