/**
 * ffmpeg `silencedetect` probe + pause-split chunk plan. Requires ffmpeg.
 *
 *   node src/cli/silence.ts --input long.wav [--ffmpeg ffmpeg] [--noise-db -35]
 *        [--min-silence-ms 500] [--target-ms 25000] [--max-ms 30000] [--min-ms 10000]
 *        [--out <file.json>] [--dry-run]
 *
 * Output contains only timings (no transcript text).
 */
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { buildSilencedetectArgs, formatCommand } from "../commands.ts";
import { parseSilencedetect, planPauseChunks } from "../drift.ts";
import { runProcess } from "../proc.ts";
import { readWavInfo } from "../wav.ts";
import { die, toInt } from "./common.ts";

const { values } = parseArgs({
  options: {
    input: { type: "string" },
    ffmpeg: { type: "string", default: "ffmpeg" },
    "noise-db": { type: "string" },
    "min-silence-ms": { type: "string" },
    "target-ms": { type: "string" },
    "max-ms": { type: "string" },
    "min-ms": { type: "string" },
    out: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
  strict: true,
});
if (!values.input) die("--input is required");
const noiseDb = toInt(values["noise-db"], "noise-db", -35);
const minSilenceMs = toInt(values["min-silence-ms"], "min-silence-ms", 500);
const args = buildSilencedetectArgs(values.input, noiseDb, minSilenceMs);
if (values["dry-run"]) {
  process.stdout.write(formatCommand(values.ffmpeg, args) + "\n");
  process.exit(0);
}

const totalMs = (await readWavInfo(values.input)).durationMs;
const r = await runProcess(values.ffmpeg, args);
if (r.spawnError) die(`cannot run ffmpeg (${r.spawnError}). Install ffmpeg and/or pass --ffmpeg <path>.`);
if (r.exitCode !== 0) die(`ffmpeg exited ${r.exitCode}:\n${r.stderr.slice(-2000)}`);

const silences = parseSilencedetect(r.stderr, totalMs);
const plan = planPauseChunks(totalMs, silences, {
  targetMs: toInt(values["target-ms"], "target-ms", 25_000),
  maxMs: toInt(values["max-ms"], "max-ms", 30_000),
  minMs: toInt(values["min-ms"], "min-ms", 10_000),
});
const out = {
  input: values.input,
  totalMs,
  silencedetect: { noiseDb, minSilenceMs },
  silences,
  silenceTotalMs: silences.reduce((a, s) => a + (s.endMs - s.startMs), 0),
  plan,
  hardCuts: plan.filter((c) => c.endReason === "hard").length,
};
const json = JSON.stringify(out, null, 2) + "\n";
if (values.out) await writeFile(values.out, json);
process.stdout.write(json);
