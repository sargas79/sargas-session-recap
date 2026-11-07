/**
 * Glossary handling for the S04 benchmark:
 *  - building the `--prompt` text passed to whisper.cpp
 *  - term/name accuracy of a hypothesis against a hand-checked reference
 *
 * Accuracy is COUNT-BASED (per term: min(refCount, hypCount) / refCount),
 * not alignment-based. It can over-credit a term that appears in the wrong
 * place. Good enough to compare with/without prompt on the same excerpt;
 * not a substitute for reading the transcript.
 */
import { normalizeText, tokenizeWords, type NormalizeOptions } from "./wer.ts";

export interface GlossaryEntry {
  /** Canonical spelling, e.g. "Flat-Footed", "Valeros", "Absalom". */
  term: string;
  /** Other spellings accepted as correct (e.g. "flatfooted"). */
  aliases?: string[];
  kind: "term" | "name";
}

export interface Glossary {
  entries: GlossaryEntry[];
}

export function parseGlossary(json: unknown): Glossary {
  if (typeof json !== "object" || json === null || !Array.isArray((json as { entries?: unknown }).entries)) {
    throw new Error("glossary: expected { entries: [...] }");
  }
  const entries = (json as { entries: unknown[] }).entries.map((e, i) => {
    if (typeof e !== "object" || e === null) throw new Error(`glossary entry ${i}: not an object`);
    const o = e as Record<string, unknown>;
    if (typeof o["term"] !== "string" || o["term"].trim() === "") {
      throw new Error(`glossary entry ${i}: missing term`);
    }
    const kind = o["kind"] ?? "term";
    if (kind !== "term" && kind !== "name") throw new Error(`glossary entry ${i}: bad kind`);
    const aliases = o["aliases"];
    if (aliases !== undefined && (!Array.isArray(aliases) || !aliases.every((a) => typeof a === "string"))) {
      throw new Error(`glossary entry ${i}: aliases must be strings`);
    }
    const entry: GlossaryEntry = { term: o["term"], kind };
    if (aliases !== undefined) entry.aliases = aliases as string[];
    return entry;
  });
  return { entries };
}

/**
 * Build a whisper `--prompt` from glossary terms. whisper.cpp keeps at most
 * ~half the 448-token text context for the prompt (n_text_ctx/2 = 224
 * tokens); characters are only a rough proxy, so `maxChars` defaults low.
 * Records which terms were dropped so the doc can mention it.
 */
export function buildGlossaryPrompt(
  g: Glossary,
  opts: { prefix?: string; maxChars?: number } = {},
): { prompt: string; included: string[]; dropped: string[] } {
  const prefix = opts.prefix ?? "Sessão de RPG Pathfinder em português com termos em inglês: ";
  const maxChars = opts.maxChars ?? 600;
  const included: string[] = [];
  const dropped: string[] = [];
  let prompt = prefix;
  for (const e of g.entries) {
    const piece = (included.length === 0 ? "" : ", ") + e.term;
    if (prompt.length + piece.length + 1 > maxChars) {
      dropped.push(e.term);
      continue;
    }
    prompt += piece;
    included.push(e.term);
  }
  return { prompt: included.length > 0 ? prompt + "." : prompt.trim(), included, dropped };
}

/** Count non-overlapping occurrences of `needle` word sequence in `hay`. */
export function countPhrase(hay: readonly string[], needle: readonly string[]): number {
  if (needle.length === 0) return 0;
  let count = 0;
  for (let i = 0; i + needle.length <= hay.length; ) {
    let ok = true;
    for (let k = 0; k < needle.length; k++) {
      if (hay[i + k] !== needle[k]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      count++;
      i += needle.length;
    } else {
      i++;
    }
  }
  return count;
}

export interface TermResult {
  term: string;
  kind: GlossaryEntry["kind"];
  refCount: number;
  hypCount: number;
  hits: number;
}

export interface TermAccuracy {
  perTerm: TermResult[];
  /** Over terms present in the reference. Null when none present. */
  termAccuracy: number | null;
  nameAccuracy: number | null;
  overallAccuracy: number | null;
  method: "count-based";
  normalize: Partial<NormalizeOptions>;
}

export function termAccuracy(
  reference: string,
  hypothesis: string,
  g: Glossary,
  normalize: Partial<NormalizeOptions> = {},
): TermAccuracy {
  const ref = tokenizeWords(normalizeText(reference, normalize));
  const hyp = tokenizeWords(normalizeText(hypothesis, normalize));
  const perTerm: TermResult[] = g.entries.map((e) => {
    const forms = [e.term, ...(e.aliases ?? [])].map((f) => tokenizeWords(normalizeText(f, normalize)));
    // The reference is hand-written with canonical spellings; aliases are only
    // accepted on the hypothesis side, but count canonical+aliases in ref too
    // so a reference using an alias is not ignored.
    const refCount = forms.reduce((a, f) => a + countPhrase(ref, f), 0);
    const hypCount = forms.reduce((a, f) => a + countPhrase(hyp, f), 0);
    return { term: e.term, kind: e.kind, refCount, hypCount, hits: Math.min(refCount, hypCount) };
  });
  const acc = (rs: TermResult[]): number | null => {
    const total = rs.reduce((a, r) => a + r.refCount, 0);
    return total === 0 ? null : rs.reduce((a, r) => a + r.hits, 0) / total;
  };
  return {
    perTerm,
    termAccuracy: acc(perTerm.filter((r) => r.kind === "term")),
    nameAccuracy: acc(perTerm.filter((r) => r.kind === "name")),
    overallAccuracy: acc(perTerm),
    method: "count-based",
    normalize,
  };
}
