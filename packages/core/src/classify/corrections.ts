/**
 * Applies the corrections a model proposes (T11). Core is the only writer of `text_corrected`, and
 * only literal, whole-word replacements backed by the segment's own text get through. A proposal
 * that fails is reported, never applied: `text_original` stays untouched in the transcript and a
 * bad proposal cannot change what a segment says beyond the words it names.
 */
import type { ClassificationResult, CorrectionRejection, Glossary } from '@sargas-recap/contracts';

export type Correction = ClassificationResult['corrections'][number];

export interface RejectedCorrection {
  readonly correction: Correction;
  readonly reason: CorrectionRejection;
}

export interface CorrectionOutcome {
  /** Undefined when nothing was applied. */
  readonly text: string | undefined;
  readonly applied: readonly Correction[];
  readonly rejected: readonly RejectedCorrection[];
}

export type GlossarySpellings = ReadonlyMap<string, string>;

export function glossarySpellings(glossary: Glossary): GlossarySpellings {
  return new Map(glossary.entries.map((entry) => [entry.id, entry.spelling]));
}

function wholeWord(literal: string): RegExp {
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'gu');
}

function glossaryProblem(
  correction: Correction,
  spellings: GlossarySpellings,
): CorrectionRejection | undefined {
  const { glossary_id: id, kind, to } = correction;
  if (id !== undefined && !spellings.has(id)) return 'unknown-glossary-entry';
  if (kind !== 'spelling' && (id === undefined || spellings.get(id) !== to)) {
    return 'glossary-mismatch';
  }
  return undefined;
}

interface Range {
  readonly start: number;
  readonly end: number;
  readonly to: string;
}

const overlaps = (a: Range, b: Range): boolean => a.start < b.end && b.start < a.end;

/** Longer sources go first, so "Sir Kira" wins over "Kira" when both are proposed. */
export function applyCorrections(
  original: string,
  proposals: readonly Correction[],
  spellings: GlossarySpellings,
): CorrectionOutcome {
  const applied: Correction[] = [];
  const rejected: RejectedCorrection[] = [];
  const ranges: Range[] = [];
  const ordered = [...proposals].sort((a, b) => b.from.length - a.from.length);
  for (const correction of ordered) {
    const { from, to } = correction;
    const reject = (reason: CorrectionRejection): void => {
      rejected.push({ correction, reason });
    };
    if (from === to) {
      reject('no-change');
      continue;
    }
    const problem = glossaryProblem(correction, spellings);
    if (problem !== undefined) {
      reject(problem);
      continue;
    }
    const found: Range[] = [...original.matchAll(wholeWord(from))].map((match) => ({
      start: match.index,
      end: match.index + from.length,
      to,
    }));
    if (found.length === 0) {
      reject('source-not-in-text');
      continue;
    }
    if (found.some((range) => ranges.some((taken) => overlaps(range, taken)))) {
      reject('overlap');
      continue;
    }
    ranges.push(...found);
    applied.push(correction);
  }
  if (applied.length === 0) return { text: undefined, applied, rejected };
  let text = '';
  let cursor = 0;
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    text += original.slice(cursor, range.start) + range.to;
    cursor = range.end;
  }
  return { text: text + original.slice(cursor), applied, rejected };
}
