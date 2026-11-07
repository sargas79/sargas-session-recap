/**
 * Score one hypothesis against a hand-checked reference.
 *
 *   node src/cli/score.ts --ref ref.txt --hyp out.json|out.txt [--glossary glossary.json] [--strip-diacritics]
 *
 * Prints JSON with WER/CER (S/D/I breakdown) and count-based term/name accuracy.
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { parseGlossary, termAccuracy } from "../glossary.ts";
import { charErrorRate, wordErrorRate } from "../wer.ts";
import { parseWhisperJson, transcriptText } from "../whisper-json.ts";
import { die } from "./common.ts";

const { values } = parseArgs({
  options: {
    ref: { type: "string" },
    hyp: { type: "string" },
    glossary: { type: "string" },
    "strip-diacritics": { type: "boolean", default: false },
  },
  strict: true,
});
if (!values.ref || !values.hyp) die("--ref and --hyp are required");

const strip = (s: string): string => s.replace(/^﻿/, "");
const reference = strip(await readFile(values.ref, "utf8"));
const hypRaw = strip(await readFile(values.hyp, "utf8"));
const hypothesis = values.hyp.toLowerCase().endsWith(".json") ? transcriptText(parseWhisperJson(hypRaw)) : hypRaw;
const norm = { stripDiacritics: values["strip-diacritics"] };

const out = {
  normalize: { lowercase: true, stripPunctuation: true, stripDiacritics: norm.stripDiacritics },
  wer: wordErrorRate(reference, hypothesis, norm),
  cer: charErrorRate(reference, hypothesis, norm),
  terms: values.glossary
    ? termAccuracy(reference, hypothesis, parseGlossary(JSON.parse(await readFile(values.glossary, "utf8"))), norm)
    : null,
};
process.stdout.write(JSON.stringify(out, null, 2) + "\n");
