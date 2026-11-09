import type { EffectiveTranscriptReview, Recap } from '@sargas-recap/contracts';
import { describe, expect, it } from 'vitest';
import {
  buildRecap,
  evidenceOf,
  finalizeRecapOutput,
  recapCitationProblems,
  selectRecapInput,
  type RecapDraft,
  type RecapIdentity,
  type ReviewSegment,
} from '../../src/recap/index.ts';
import { note, output, sentence } from './helpers.ts';

const RUN = '01JBX7Q8M2N4P6R8S0T2V4W6XY';
const CLASSIFICATION = '01JBX7RA3C5E7G9J1K3M5N7P9Q';
const id = (ref: string): string => `${RUN}:${ref}`;
const OTHER_SESSION_RUN = '01JBX7Q8M2N4P6R8S0T2V4W6XZ';

function seg(ref: string, inclusion: ReviewSegment['recap_inclusion']): ReviewSegment {
  return {
    segment_id: id(ref),
    speaker_id: 'gm',
    start_offset_ms: 0,
    end_offset_ms: 1_000,
    timing_uncertainty_ms: 0,
    text: `texto ${ref}`,
    text_source: 'original',
    label: 'ic',
    label_source: 'classification',
    recap_inclusion: inclusion,
    exclusion_reasons: [],
    review_required: false,
    review_status: 'pending',
    text_original: `texto ${ref}`,
    text_hash: `sha256:${'0'.repeat(64)}`,
    corrections: [],
    classification_label: 'ic',
    segment_flags: [],
    classification_flags: [],
  };
}

function viewOf(segments: readonly ReviewSegment[]): EffectiveTranscriptReview {
  return {
    schema_version: 1,
    campaign_id: 'synthetic-vaults',
    session_id: 's01',
    transcription_run_id: RUN,
    classification_run_id: CLASSIFICATION,
    generated_at: '2026-11-02T20:00:00.000Z',
    segments: [...segments],
    needs_reconciliation: [],
  };
}

const included = [seg('0:0', 'include'), seg('0:1', 'include')];
const evidence = evidenceOf(included);
const identity: RecapIdentity = {
  campaignId: 'synthetic-vaults',
  sessionId: 's01',
  transcriptionRunId: RUN,
  classificationRunId: CLASSIFICATION,
  language: 'pt-BR',
  generatedAt: '2026-11-02T20:00:00.000Z',
};

function problemsOf(result: ReturnType<typeof finalizeRecapOutput>): readonly string[] {
  if (result.ok) throw new Error('expected the output to be refused');
  return result.problems;
}

function draftOf(result: ReturnType<typeof finalizeRecapOutput>): RecapDraft {
  if (!result.ok) throw new Error(result.problems.join('; '));
  return result.draft;
}

describe('finalizeRecapOutput (citation validator)', () => {
  it('resolves refs to full segment IDs and removes duplicate citations', () => {
    const draft = draftOf(finalizeRecapOutput(output([sentence(['0:0', '0:0', '0:1'])]), evidence));
    expect(draft.sentences[0]?.citations.segment_ids).toEqual([id('0:0'), id('0:1')]);
    expect(draft.gmNotes).toEqual([]);
  });

  it('fails the attempt on a citation of a segment that was not sent', () => {
    const problems = problemsOf(finalizeRecapOutput(output([sentence(['0:99'])]), evidence));
    expect(problems).toEqual(['sentences[0]: segment_ref 0:99 was not sent to the model']);
  });

  it('fails the attempt on an invented ref in a GM note too', () => {
    const problems = problemsOf(
      finalizeRecapOutput(output([sentence(['0:0'])], [note(['9:9'])]), evidence),
    );
    expect(problems.join()).toContain('gm_notes[0]: segment_ref 9:9');
  });

  it('fails on an event ID that was not sent: no events are sent before T17 and T18', () => {
    const cited = sentence(['0:0'], 'Kyra abriu a porta.');
    const problems = problemsOf(
      finalizeRecapOutput(
        output([
          {
            ...cited,
            citations: {
              segment_refs: ['0:0'],
              event_ids: ['fvtt:01JBX7A0B1C2D3E4F5G6H7J8K9:42'],
            },
          },
        ]),
        evidence,
      ),
    );
    expect(problems.join()).toContain('event fvtt:01JBX7A0B1C2D3E4F5G6H7J8K9:42');
  });

  it('turns an uncited sentence into an unsupported GM note', () => {
    const draft = draftOf(
      finalizeRecapOutput(
        output([sentence(['0:0']), sentence([], 'Uma frase sem fonte.')]),
        evidence,
      ),
    );
    expect(draft.sentences).toHaveLength(1);
    expect(draft.gmNotes).toEqual([
      {
        reason: 'unsupported',
        text: 'Uma frase sem fonte.',
        citations: { segment_ids: [], event_ids: [] },
      },
    ]);
  });

  it('turns a background sentence into a GM note, whatever it cites', () => {
    const draft = draftOf(
      finalizeRecapOutput(
        output([
          sentence(['0:0']),
          sentence(['0:1'], 'Na sessão passada Kyra achou uma chave.', { assertion: 'background' }),
        ]),
        evidence,
      ),
    );
    expect(draft.sentences).toHaveLength(1);
    expect(draft.gmNotes).toEqual([
      {
        reason: 'unsupported',
        text: 'Na sessão passada Kyra achou uma chave.',
        citations: { segment_ids: [id('0:1')], event_ids: [] },
      },
    ]);
  });

  it('fails the attempt when no sentence has evidence from this session', () => {
    expect(problemsOf(finalizeRecapOutput(output([sentence([], 'Nada.')]), evidence))).toEqual([
      'no sentence has evidence from this session',
    ]);
  });

  it('accepts outcome_basis only on a completed sentence', () => {
    const planned = sentence(['0:0'], 'O grupo planejou atacar.', {
      assertion: 'proposed',
      outcome_basis: 'roll',
    });
    expect(problemsOf(finalizeRecapOutput(output([planned]), evidence)).join()).toContain(
      'outcome_basis',
    );
    const rolled = sentence(['0:0'], 'Kyra venceu o teste.', { outcome_basis: 'roll' });
    expect(draftOf(finalizeRecapOutput(output([rolled]), evidence)).sentences[0]).toMatchObject({
      assertion: 'completed',
      outcome_basis: 'roll',
    });
  });
});

describe('buildRecap', () => {
  it('fills in the pipeline fields and IDs of the revision', () => {
    const draft = draftOf(
      finalizeRecapOutput(output([sentence(['0:0'])], [note(['0:1'])]), evidence),
    );
    const recap = buildRecap(draft, identity, 3, [id('0:7')]);
    expect(recap.recap_revision).toBe(3);
    expect(recap.sentences[0]?.sentence_id).toBe('r3:s0');
    expect(recap.gm_notes.map((n) => n.note_id)).toEqual(['r3:g0', 'r3:g1']);
    expect(recap.gm_notes[1]).toEqual({
      note_id: 'r3:g1',
      reason: 'unresolved',
      text: '1 trecho aguarda decisão do GM e ficou fora deste recap.',
      citations: { segment_ids: [id('0:7')], event_ids: [] },
    });
  });

  it('adds no note when nothing is unresolved', () => {
    const draft = draftOf(finalizeRecapOutput(output([sentence(['0:0'])]), evidence));
    expect(buildRecap(draft, identity, 1, []).gm_notes).toEqual([]);
  });
});

describe('recapCitationProblems (finished record)', () => {
  const view = viewOf([
    seg('0:0', 'include'),
    seg('0:1', 'exclude'),
    seg('0:2', 'unresolved'),
    seg('0:3', 'include'),
  ]);

  function recapWith(sentenceIds: readonly string[], noteIds: readonly string[] = []): Recap {
    return {
      schema_version: 1,
      campaign_id: 'synthetic-vaults',
      session_id: 's01',
      recap_revision: 1,
      transcription_run_id: RUN,
      classification_run_id: CLASSIFICATION,
      language: 'pt-BR',
      generated_at: '2026-11-02T20:00:00.000Z',
      title: 'Sessão',
      sentences: [
        {
          sentence_id: 'r1:s0',
          text: 'Frase.',
          assertion: 'completed',
          citations: { segment_ids: [...sentenceIds], event_ids: [] },
        },
      ],
      gm_notes: [
        {
          note_id: 'r1:g0',
          reason: 'unresolved',
          text: 'Nota.',
          citations: { segment_ids: [...noteIds], event_ids: [] },
        },
      ],
    };
  }

  const check = (recap: Recap): string[] => recapCitationProblems(recap, view, new Set());

  it('accepts included segments for sentences and unresolved ones for GM notes', () => {
    expect(check(recapWith([id('0:0'), id('0:3')], [id('0:2')]))).toEqual([]);
  });

  it('refuses an excluded segment, in a sentence or a note', () => {
    expect(check(recapWith([id('0:1')])).join()).toContain('is excluded');
    expect(check(recapWith([id('0:0')], [id('0:1')])).join()).toContain('is excluded');
  });

  it('refuses a segment waiting for a decision as evidence of a sentence', () => {
    expect(check(recapWith([id('0:2')])).join()).toContain('waiting for a GM decision');
  });

  it('refuses a citation from another session', () => {
    expect(check(recapWith([`${OTHER_SESSION_RUN}:0:0`])).join()).toContain('not in this session');
  });

  it('refuses an uncited or background sentence in a finished record', () => {
    expect(check(recapWith([])).join()).toContain('has no citation');
    const background = recapWith([id('0:0')]);
    const first = background.sentences[0];
    if (first === undefined) throw new Error('no sentence');
    first.assertion = 'background';
    expect(check(background).join()).toContain('background is not evidence');
  });
});

describe('selectRecapInput', () => {
  it('keeps exactly the included segments', () => {
    const { included: chosen, unresolved } = selectRecapInput(
      viewOf([seg('0:0', 'include'), seg('0:1', 'exclude'), seg('0:2', 'unresolved')]),
    );
    expect(chosen.map((s) => s.segment_id)).toEqual([id('0:0')]);
    expect(unresolved.map((s) => s.segment_id)).toEqual([id('0:2')]);
  });
});
