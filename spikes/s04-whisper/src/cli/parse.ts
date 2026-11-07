/**
 * Inspect one whisper.cpp JSON file.
 *
 *   node src/cli/parse.ts <out.json> [--text]
 *
 * Prints metadata, warnings and per-segment PROVISIONAL confidence. Segment
 * text is only printed with --text (keep terminal logs free of transcripts).
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { summarizeConfidence } from "../confidence.ts";
import { parseWhisperJson } from "../whisper-json.ts";
import { die } from "./common.ts";

const { values, positionals } = parseArgs({
  options: { text: { type: "boolean", default: false } },
  allowPositionals: true,
  strict: true,
});
const file = positionals[0];
if (!file) die("usage: parse.ts <whisper-output.json> [--text]");

const t = parseWhisperJson((await readFile(file, "utf8")).replace(/^﻿/, ""));
const { perSegment, summary } = summarizeConfidence(t);
const out = {
  language: t.language,
  modelType: t.modelType,
  hasTokens: t.hasTokens,
  warnings: t.warnings,
  summary,
  segments: t.segments.map((s, i) => ({
    index: s.index,
    startMs: s.startMs,
    endMs: s.endMs,
    tokens: s.tokens.length,
    dtwTokens: s.tokens.filter((x) => x.dtwMs !== null).length,
    ...(values.text ? { text: s.text } : {}),
    confidence: perSegment[i],
  })),
};
process.stdout.write(JSON.stringify(out, null, 2) + "\n");
