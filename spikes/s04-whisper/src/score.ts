import { termAccuracy, type Glossary } from "./glossary.ts";
import type { RunScores } from "./report.ts";
import { charErrorRate, wordErrorRate } from "./wer.ts";

/** Default normalisation (lowercase, no punctuation, diacritics kept) + a diacritics-insensitive WER. */
export function scoreTranscript(reference: string, hypothesis: string, glossary: Glossary | null): RunScores {
  const terms = glossary ? termAccuracy(reference, hypothesis, glossary) : null;
  return {
    wer: wordErrorRate(reference, hypothesis).rate,
    werNoDiacritics: wordErrorRate(reference, hypothesis, { stripDiacritics: true }).rate,
    cer: charErrorRate(reference, hypothesis).rate,
    termAccuracy: terms?.termAccuracy ?? null,
    nameAccuracy: terms?.nameAccuracy ?? null,
  };
}
