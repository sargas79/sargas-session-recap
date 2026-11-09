import type { Recap } from '@sargas-recap/contracts';
import { describe, expect, it } from 'vitest';
import {
  renderGmNotesMarkdown,
  renderRecapMarkdown,
  type SegmentSources,
} from '../../src/recap/index.ts';

const RUN = '01JBX7Q8M2N4P6R8S0T2V4W6XY';

const recap: Recap = {
  schema_version: 1,
  campaign_id: 'synthetic-vaults',
  session_id: 's01',
  recap_revision: 2,
  transcription_run_id: RUN,
  classification_run_id: '01JBX7RA3C5E7G9J1K3M5N7P9Q',
  language: 'pt-BR',
  generated_at: '2026-11-02T20:00:00.000Z',
  title: 'Sessão 1: A ponte',
  sentences: [
    {
      sentence_id: 'r2:s0',
      text: 'Kyra abriu a porta do farol.',
      assertion: 'completed',
      citations: { segment_ids: [`${RUN}:0:0`], event_ids: [] },
    },
    {
      sentence_id: 'r2:s1',
      text: 'O grupo planejou descer ao porão.',
      assertion: 'proposed',
      citations: { segment_ids: [`${RUN}:0:1`, `${RUN}:1:0`], event_ids: [] },
    },
  ],
  gm_notes: [
    {
      note_id: 'r2:g0',
      reason: 'unresolved',
      text: 'Não ficou claro quem carrega a chave.',
      citations: { segment_ids: [`${RUN}:1:0`], event_ids: [] },
    },
    {
      note_id: 'r2:g1',
      reason: 'unsupported',
      text: 'Sem fonte.',
      citations: { segment_ids: [], event_ids: [] },
    },
  ],
};

const sources: SegmentSources = new Map([
  [`${RUN}:0:0`, { speakerId: 'player-ana', startOffsetMs: 65_000 }],
  [`${RUN}:0:1`, { speakerId: 'gm', startOffsetMs: 3_725_000 }],
  [`${RUN}:1:0`, { speakerId: 'gm', startOffsetMs: 3_730_000 }],
]);

describe('renderRecapMarkdown', () => {
  it('renders one sentence per line with a footnote each (snapshot)', () => {
    expect(renderRecapMarkdown(recap, sources)).toBe(
      [
        '# Sessão 1: A ponte',
        '',
        'Kyra abriu a porta do farol.[^1]',
        'O grupo planejou descer ao porão.[^2]',
        '',
        '[^1]: trecho 0:0 (player-ana, 00:01:05)',
        '[^2]: trecho 0:1 (gm, 01:02:05); trecho 1:0 (gm, 01:02:10)',
        '',
      ].join('\n'),
    );
  });

  it('never contains GM notes', () => {
    const markdown = renderRecapMarkdown(recap, sources);
    expect(markdown).not.toContain('chave');
    expect(markdown).not.toContain('Sem fonte');
  });

  it('flattens and escapes model text so it cannot fake a footnote or markup', () => {
    const hostile: Recap = {
      ...recap,
      title: 'Sessão\n[^9]: falsa',
      sentences: [
        {
          sentence_id: 'r2:s0',
          text: 'Uma frase\n\n[^1]: nota falsa <img src=x>',
          assertion: 'completed',
          citations: { segment_ids: [`${RUN}:0:0`], event_ids: [] },
        },
      ],
    };
    const markdown = renderRecapMarkdown(hostile, sources);
    expect(markdown).toContain(
      'Uma frase \\[^1\\]: nota falsa \\<img src=x\\>[^1]\n\n[^1]: trecho 0:0',
    );
    expect(markdown).toContain('# Sessão \\[^9\\]: falsa\n');
    expect(markdown.match(/^\[\^\d+\]: /gm)).toHaveLength(1);
  });
});

describe('renderGmNotesMarkdown', () => {
  it('renders the GM notes apart, with their sources (snapshot)', () => {
    expect(renderGmNotesMarkdown(recap, sources)).toBe(
      [
        '# Notas do GM: Sessão 1: A ponte',
        '',
        'Somente para o GM. Não enviar aos jogadores.',
        '',
        '- **Não resolvido** (r2:g0): Não ficou claro quem carrega a chave. Fontes: trecho 1:0 (gm, 01:02:10).',
        '- **Sem evidência** (r2:g1): Sem fonte.',
        '',
      ].join('\n'),
    );
  });

  it('says so when there are no notes', () => {
    expect(renderGmNotesMarkdown({ ...recap, gm_notes: [] }, sources)).toContain('Sem notas.');
  });
});
