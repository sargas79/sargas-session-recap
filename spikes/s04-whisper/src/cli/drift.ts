/**
 * Chunk-boundary / timestamp drift probe. Requires ffmpeg (chunk extraction)
 * and whisper-cli.
 *
 *   node src/cli/drift.ts --whisper <whisper-cli.exe> --model <ggml.bin> --input <long.wav>
 *        --out <dir outside git> [--chunk-sec 20,25,30] [--overlap-ms 0]
 *        [--mode fixed|pause] [--noise-db -35] [--min-silence-ms 500]
 *        [--language pt] [--prompt-file glossary-prompt.txt] [--ffmpeg ffmpeg]
 *        [--vad-model ggml-silero.bin] [--extra "-dev 0"] [--dry-run]
 *
 * 1. Transcribes the whole file once (reference timeline).
 * 2. For each chunk length: plans chunks (fixed, or pause-split via
 *    silencedetect with target = chunk length), extracts each chunk with
 *    ffmpeg, transcribes it, shifts segments by the chunk start.
 * 3. Compares timelines (src/drift.ts) and writes drift-<mode>-<sec>s.json
 *    plus a summary drift-summary.md.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  buildFfmpegExtractArgs,
  buildSilencedetectArgs,
  buildWhisperArgs,
  formatCommand,
  type WhisperInvocation,
} from "../commands.ts";
import {
  compareTimelines,
  parseSilencedetect,
  planFixedChunks,
  planPauseChunks,
  type Chunk,
  type ChunkTranscript,
  type DriftReport,
} from "../drift.ts";
import { runProcess } from "../proc.ts";
import { readWavInfo } from "../wav.ts";
import { parseWhisperJson } from "../whisper-json.ts";
import { assertSafeOutDir, die, toInt } from "./common.ts";

const { values } = parseArgs({
  options: {
    whisper: { type: "string" },
    model: { type: "string" },
    input: { type: "string" },
    out: { type: "string" },
    "chunk-sec": { type: "string", default: "20,25,30" },
    "overlap-ms": { type: "string" },
    mode: { type: "string", default: "fixed" },
    "noise-db": { type: "string" },
    "min-silence-ms": { type: "string" },
    language: { type: "string", default: "pt" },
    "prompt-file": { type: "string" },
    ffmpeg: { type: "string", default: "ffmpeg" },
    "vad-model": { type: "string" },
    extra: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
  strict: true,
});

const { whisper, model, input, out } = values;
if (!whisper || !model || !input || !out) die("--whisper, --model, --input and --out are required");
const mode = values.mode;
if (mode !== "fixed" && mode !== "pause") die("--mode must be fixed or pause");
const chunkSecs = values["chunk-sec"].split(",").map((s) => toInt(s.trim(), "chunk-sec", 0));
if (chunkSecs.some((s) => s <= 0)) die("--chunk-sec values must be positive integers");
const overlapMs = toInt(values["overlap-ms"], "overlap-ms", 0);
const noiseDb = toInt(values["noise-db"], "noise-db", -35);
const minSilenceMs = toInt(values["min-silence-ms"], "min-silence-ms", 500);
const outDir = path.resolve(out);
const prompt = values["prompt-file"] ? (await readFile(values["prompt-file"], "utf8")).replace(/^﻿/, "").trim() : null;

const inv = (audioPath: string, outPrefix: string): WhisperInvocation => ({
  modelPath: model,
  audioPath,
  outPrefix,
  language: values.language,
  prompt,
  gpu: true,
  fullJson: true,
  vad: values["vad-model"] ? { modelPath: values["vad-model"] } : null,
  extraArgs: values.extra ? values.extra.split(/\s+/).filter(Boolean) : [],
});

const dry = values["dry-run"];
const show = (bin: string, args: string[]): void => {
  process.stdout.write(formatCommand(bin, args) + "\n");
};

async function run(bin: string, args: string[], what: string): Promise<string> {
  if (dry) {
    show(bin, args);
    return "";
  }
  const r = await runProcess(bin, args);
  if (r.spawnError) die(`${what}: cannot spawn ${bin}: ${r.spawnError}`);
  if (r.exitCode !== 0) die(`${what}: exit ${r.exitCode}\n${r.stderr.slice(-2000)}`);
  return r.stderr;
}

async function transcribe(audioPath: string, outPrefix: string, what: string): Promise<{ startMs: number; endMs: number; text: string }[]> {
  await run(whisper!, buildWhisperArgs(inv(audioPath, outPrefix)), what);
  if (dry) return [];
  const t = parseWhisperJson(await readFile(`${outPrefix}.json`, "utf8"));
  return t.segments.map((s) => ({ startMs: s.startMs, endMs: s.endMs, text: s.text }));
}

if (!dry) {
  assertSafeOutDir(outDir);
  for (const [k, p] of [["whisper", whisper], ["model", model], ["input", input]] as const) {
    if (!existsSync(p)) die(`${k} not found: ${p}`);
  }
  await mkdir(outDir, { recursive: true });
}

let totalMs: number;
try {
  totalMs = (await readWavInfo(input)).durationMs;
} catch (e) {
  if (!dry) die(`input must be a PCM WAV (convert with ffmpeg first): ${(e as Error).message}`);
  totalMs = 600_000;
  process.stdout.write(`# dry run: input not readable as WAV, assuming 600000 ms for the plan\n`);
}

process.stdout.write(dry ? "# dry run: commands only\n# full-file reference transcription\n" : "transcribing full file...\n");
const full = await transcribe(input, path.join(outDir, "full", "out"), "full transcription");

let silences: { startMs: number; endMs: number }[] = [];
if (mode === "pause") {
  if (dry) process.stdout.write("# silencedetect\n");
  const stderr = await run(values.ffmpeg, buildSilencedetectArgs(input, noiseDb, minSilenceMs), "silencedetect");
  silences = parseSilencedetect(stderr, totalMs);
}

const summary: string[] = [
  `# Drift probe (${new Date().toISOString()})`,
  "",
  `- input duration: ${totalMs} ms; mode: ${mode}; overlap: ${overlapMs} ms; prompt: ${prompt ? "yes" : "no"}; vad: ${values["vad-model"] ? "whisper-vad" : "off"}`,
  "- method: segment-level, text-matched (approximate). Deltas = chunked − full.",
  "",
  "| chunk s | chunks | hard cuts | segs | matched | unmatched | interior mean|Δstart| ms | boundary mean|Δstart| ms | boundary max|Δstart| ms | issues | boundary WER (mean) | overall WER full vs chunked |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|",
];

for (const sec of chunkSecs) {
  const chunkMs = sec * 1000;
  const chunks: (Chunk & { endReason?: string })[] =
    mode === "fixed"
      ? planFixedChunks(totalMs, chunkMs, overlapMs)
      : planPauseChunks(totalMs, silences, { targetMs: chunkMs, maxMs: Math.round(chunkMs * 1.2), minMs: Math.round(chunkMs * 0.5) });
  const dir = path.join(outDir, `${mode}-${sec}s`);
  if (!dry) await mkdir(dir, { recursive: true });
  if (dry) process.stdout.write(`# ${mode} ${sec}s: ${chunks.length} chunks\n`);
  const transcripts: ChunkTranscript[] = [];
  for (const c of chunks) {
    const wav = path.join(dir, `chunk-${String(c.index).padStart(4, "0")}.wav`);
    await run(values.ffmpeg, buildFfmpegExtractArgs(input, c.startMs, c.durationMs, wav), `extract chunk ${c.index}`);
    const segs = await transcribe(wav, path.join(dir, `chunk-${String(c.index).padStart(4, "0")}`), `chunk ${c.index}`);
    transcripts.push({ chunk: { index: c.index, startMs: c.startMs, durationMs: c.durationMs }, segments: segs });
    if (dry && c.index >= 1 && chunks.length > 3) {
      process.stdout.write(`# ... ${chunks.length - 2} more chunks with the same pattern\n`);
      break;
    }
  }
  if (dry) continue;
  const report: DriftReport = compareTimelines(full, transcripts);
  await writeFile(path.join(outDir, `drift-${mode}-${sec}s.json`), JSON.stringify({ chunkSec: sec, mode, overlapMs, chunks, report }, null, 2));
  const bw = report.boundaries.map((b) => b.wer.rate).filter((x): x is number => x !== null);
  const hard = chunks.filter((c) => c.endReason === "hard").length;
  summary.push(
    `| ${sec} | ${chunks.length} | ${mode === "pause" ? hard : "n/a"} | ${report.chunkSegments} | ${report.matched} | ${report.unmatched} | ${report.interior.meanAbsStartMs ?? "—"} | ${report.nearBoundary.meanAbsStartMs ?? "—"} | ${report.nearBoundary.maxAbsStartMs ?? "—"} | ${report.issues.length} | ${bw.length ? ((bw.reduce((a, b) => a + b, 0) / bw.length) * 100).toFixed(1) + "%" : "—"} | ${report.overallWerFullVsChunked.rate === null ? "—" : (report.overallWerFullVsChunked.rate * 100).toFixed(1) + "%"} |`,
  );
}

if (!dry) {
  await writeFile(path.join(outDir, "drift-summary.md"), summary.join("\n") + "\n");
  process.stdout.write(summary.join("\n") + "\n");
}
