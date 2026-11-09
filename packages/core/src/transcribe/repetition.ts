/**
 * Repetition-loop detection (T09). S04 saw `large-v3` repeat a passage of about 35 words 8 times on
 * Portuguese narration (`docs/spikes/S04-whisper.md` section 5.8); nothing here is model-specific.
 * The result only flags text for review: looped output is never removed.
 *
 * A loop is a tandem repeat: the same words, compared case- and punctuation-insensitively, at least
 * `minRepeats` times in a row with at least `minWords` words in all. Copies must match exactly, so
 * a loop whose copies drift word by word is only caught where consecutive copies do match.
 */
export interface RepetitionParams {
  readonly minRepeats: number;
  readonly minWords: number;
  readonly maxUnitWords: number;
}

/** Half-open range of word indices. */
export interface WordRange {
  readonly start: number;
  readonly end: number;
}

export function wordsOf(text: string): string[] {
  return (
    text
      .normalize('NFKC')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

function mergeRanges(ranges: readonly WordRange[]): WordRange[] {
  const merged: { start: number; end: number }[] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last !== undefined && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/** Every loop in `words`, merged. Linear in `words` for each candidate passage length. */
export function findRepetitionLoops(
  words: readonly string[],
  params: RepetitionParams,
): WordRange[] {
  const { minRepeats, minWords, maxUnitWords } = params;
  const found: WordRange[] = [];
  const longestUnit = Math.min(maxUnitWords, Math.floor(words.length / minRepeats));
  for (let unit = 1; unit <= longestUnit; unit += 1) {
    let runStart = 0;
    for (let i = 0; i <= words.length - unit; i += 1) {
      if (i < words.length - unit && words[i] === words[i + unit]) continue;
      // words[runStart, i + unit) has period `unit`.
      const total = i + unit - runStart;
      const repeats = Math.floor(total / unit);
      if (repeats >= minRepeats && repeats * unit >= minWords) {
        found.push({ start: runStart, end: i + unit });
      }
      runStart = i + 1;
    }
  }
  return mergeRanges(found);
}
