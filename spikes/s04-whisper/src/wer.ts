/**
 * WER / CER helpers for hand-checked Portuguese/English excerpts.
 *
 * Normalisation is explicit and recorded alongside every score so numbers from
 * different settings are never compared by accident.
 */

export interface NormalizeOptions {
  /** Lower-case (locale-independent). Default true. */
  lowercase: boolean;
  /** Replace punctuation/symbols with spaces. Default true. */
  stripPunctuation: boolean;
  /**
   * Remove diacritics (á→a, ç→c, ã→a ...). Default false: in Portuguese a
   * missing accent can change the word (e.g. "e"/"é"), so the default counts it.
   * Report both settings when the difference matters.
   */
  stripDiacritics: boolean;
}

export const DEFAULT_NORMALIZE: Readonly<NormalizeOptions> = Object.freeze({
  lowercase: true,
  stripPunctuation: true,
  stripDiacritics: false,
});

export function normalizeText(
  text: string,
  opts: Partial<NormalizeOptions> = {},
): string {
  const o: NormalizeOptions = { ...DEFAULT_NORMALIZE, ...opts };
  let s = text.normalize("NFC");
  if (o.lowercase) s = s.toLowerCase();
  if (o.stripDiacritics) s = s.normalize("NFD").replace(/\p{M}+/gu, "").normalize("NFC");
  if (o.stripPunctuation) {
    // Keep intra-word apostrophes and hyphens ("d'água", "guarda-chuva", "Ranger's").
    s = s
      .replace(/(\p{L})['’](?=\p{L})/gu, "$1\u0001")
      .replace(/(\p{L})-(?=\p{L})/gu, "$1\u0002")
      .replace(/[\p{P}\p{S}]+/gu, " ")
      .replace(/\u0001/g, "'")
      .replace(/\u0002/g, "-");
  }
  return s.replace(/\s+/gu, " ").trim();
}

export function tokenizeWords(normalized: string): string[] {
  return normalized.length === 0 ? [] : normalized.split(" ");
}

export interface EditCounts {
  substitutions: number;
  deletions: number;
  insertions: number;
  hits: number;
  /** Number of reference units (words or characters). */
  referenceLength: number;
}

/** Levenshtein alignment with S/D/I/H breakdown (unit cost). */
export function editCounts<T>(ref: readonly T[], hyp: readonly T[]): EditCounts {
  const n = ref.length;
  const m = hyp.length;
  // dp[i][j] = cost aligning ref[0..i) with hyp[0..j)
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 0; i <= n; i++) dp[i]![0] = i;
  for (let j = 0; j <= m; j++) dp[0]![j] = j;
  for (let i = 1; i <= n; i++) {
    const row = dp[i]!;
    const prev = dp[i - 1]!;
    for (let j = 1; j <= m; j++) {
      const sub = prev[j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1);
      row[j] = Math.min(sub, prev[j]! + 1, row[j - 1]! + 1);
    }
  }
  let i = n;
  let j = m;
  const c: EditCounts = { substitutions: 0, deletions: 0, insertions: 0, hits: 0, referenceLength: n };
  while (i > 0 || j > 0) {
    const cur = dp[i]![j]!;
    if (i > 0 && j > 0) {
      const same = ref[i - 1] === hyp[j - 1];
      if (cur === dp[i - 1]![j - 1]! + (same ? 0 : 1)) {
        if (same) c.hits++;
        else c.substitutions++;
        i--;
        j--;
        continue;
      }
    }
    if (i > 0 && cur === dp[i - 1]![j]! + 1) {
      c.deletions++;
      i--;
    } else {
      c.insertions++;
      j--;
    }
  }
  return c;
}

export interface ErrorRate extends EditCounts {
  /** (S + D + I) / N. Null when the reference is empty. Can exceed 1. */
  rate: number | null;
}

function toRate(c: EditCounts): ErrorRate {
  return {
    ...c,
    rate:
      c.referenceLength === 0
        ? null
        : (c.substitutions + c.deletions + c.insertions) / c.referenceLength,
  };
}

export function wordErrorRate(
  reference: string,
  hypothesis: string,
  opts: Partial<NormalizeOptions> = {},
): ErrorRate {
  return toRate(
    editCounts(
      tokenizeWords(normalizeText(reference, opts)),
      tokenizeWords(normalizeText(hypothesis, opts)),
    ),
  );
}

/** CER over normalised text, spaces included (single space between words). */
export function charErrorRate(
  reference: string,
  hypothesis: string,
  opts: Partial<NormalizeOptions> = {},
): ErrorRate {
  return toRate(
    editCounts(
      Array.from(normalizeText(reference, opts)),
      Array.from(normalizeText(hypothesis, opts)),
    ),
  );
}
