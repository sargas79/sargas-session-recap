/**
 * Markdown views of a recap (T13). `recap.md` is the player-facing draft with footnotes and never
 * holds GM notes; those go to `gm-notes.md`. Both are derived from `recap.json`, which stays the
 * only source.
 *
 * Model text is escaped and flattened to one line, so a sentence cannot fake a footnote definition
 * or inject markup.
 */
import type { Recap, RecapCitations } from '@sargas-recap/contracts';
import { refOf } from './evidence.ts';

export interface SegmentSource {
  readonly speakerId: string;
  readonly startOffsetMs: number;
}

export type SegmentSources = ReadonlyMap<string, SegmentSource>;

const NOTE_REASONS: Readonly<Record<Recap['gm_notes'][number]['reason'], string>> = {
  unresolved: 'Não resolvido',
  unsupported: 'Sem evidência',
  conflict: 'Conflito',
  spoiler: 'Spoiler',
};

function markdownText(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\\`*_[\]<>#|~]/g, '\\$&');
}

export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

function sources(citations: RecapCitations, known: SegmentSources): string {
  const segments = citations.segment_ids.map((id) => {
    const source = known.get(id);
    return source === undefined
      ? `trecho ${refOf(id)}`
      : `trecho ${refOf(id)} (${source.speakerId}, ${clock(source.startOffsetMs)})`;
  });
  const events = citations.event_ids.map((id) => `evento ${id}`);
  return [...segments, ...events].join('; ');
}

/** The player-facing draft: one sentence per line, one footnote per sentence. */
export function renderRecapMarkdown(recap: Recap, known: SegmentSources): string {
  const lines = recap.sentences.map(
    (sentence, n) => `${markdownText(sentence.text)}[^${String(n + 1)}]`,
  );
  const footnotes = recap.sentences.map(
    (sentence, n) => `[^${String(n + 1)}]: ${sources(sentence.citations, known)}`,
  );
  return `# ${markdownText(recap.title)}\n\n${lines.join('\n')}\n\n${footnotes.join('\n')}\n`;
}

/** GM-only notes, in a file of their own so `recap.md` can be read without them. */
export function renderGmNotesMarkdown(recap: Recap, known: SegmentSources): string {
  const notes = recap.gm_notes.map((note) => {
    const cited = sources(note.citations, known);
    const suffix = cited === '' ? '' : ` Fontes: ${cited}.`;
    return `- **${NOTE_REASONS[note.reason]}** (${note.note_id}): ${markdownText(note.text)}${suffix}`;
  });
  const body = notes.length === 0 ? 'Sem notas.' : notes.join('\n');
  return `# Notas do GM: ${markdownText(recap.title)}\n\nSomente para o GM. Não enviar aos jogadores.\n\n${body}\n`;
}
