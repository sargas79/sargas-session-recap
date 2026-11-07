/**
 * S04 benchmark runner.
 *
 *   node src/cli/bench.ts --config <bench.config.json> [--dry-run] [--no-hash]
 *        [--driver "<AMD Adrenalin x.y.z>"] [--whisper-version "<tag/commit>"]
 *
 * Runs every model × audio × prompt × vad (× cpu baseline) × repeat config via
 * child_process (argument arrays, no shell), records wall time, RTF, output
 * files and hashes into <outDir>/results.json and <outDir>/results.md.
 * --dry-run prints the commands and exits without executing or writing.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { parseBenchConfig, planRuns, realTimeFactor, type BenchConfig } from "../bench-config.ts";
import { formatCommand } from "../commands.ts";
import { summarizeConfidence } from "../confidence.ts";
import { buildGlossaryPrompt, parseGlossary, type Glossary } from "../glossary.ts";
import { runProcess, sha256File } from "../proc.ts";
import { renderMarkdown, type BenchResults, type RunResult } from "../report.ts";
import { scoreTranscript } from "../score.ts";
import { parseStderr } from "../stderr.ts";
import { readWavInfo } from "../wav.ts";
import { parseWhisperJson, transcriptText } from "../whisper-json.ts";
import { assertSafeOutDir, die } from "./common.ts";

const { values } = parseArgs({
  options: {
    config: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    "no-hash": { type: "boolean", default: false },
    driver: { type: "string" },
    "whisper-version": { type: "string" },
    notes: { type: "string" },
  },
  strict: true,
});

if (!values.config) die("--config is required");
const configPath = path.resolve(values.config);
const cfg: BenchConfig = parseBenchConfig(JSON.parse(await readFile(configPath, "utf8")), path.dirname(configPath));

const dryRun = values["dry-run"];
const missingInDryRun = (p: string | undefined): boolean => {
  if (!dryRun || p === undefined || existsSync(p)) return false;
  process.stdout.write(`# dry run: ${p} not found, using a placeholder\n`);
  return true;
};

let glossary: Glossary | null = null;
if (cfg.glossaryFile && !missingInDryRun(cfg.glossaryFile)) {
  glossary = parseGlossary(JSON.parse(await readFile(cfg.glossaryFile, "utf8")));
}

let glossaryPrompt: string | null = null;
if (cfg.promptVariants.includes("glossary")) {
  if (cfg.glossaryPromptFile && missingInDryRun(cfg.glossaryPromptFile)) {
    glossaryPrompt = `<contents of ${cfg.glossaryPromptFile}>`;
  } else if (cfg.glossaryPromptFile) {
    glossaryPrompt = (await readFile(cfg.glossaryPromptFile, "utf8")).replace(/^﻿/, "").trim();
  } else if (glossary) {
    const built = buildGlossaryPrompt(glossary);
    glossaryPrompt = built.prompt;
    if (built.dropped.length > 0) process.stderr.write(`warning: prompt length limit dropped terms: ${built.dropped.join(", ")}\n`);
  } else if (dryRun) {
    glossaryPrompt = `<prompt built from ${cfg.glossaryFile ?? "glossary"}>`;
  }
}

const runs = planRuns(cfg, glossaryPrompt);

if (dryRun) {
  process.stdout.write(`# dry run: ${runs.length} run(s), nothing executed\n`);
  if (glossaryPrompt !== null) process.stdout.write(`# glossary prompt (${glossaryPrompt.length} chars): ${glossaryPrompt}\n`);
  for (const r of runs) {
    process.stdout.write(`\n# ${r.runId}\n${formatCommand(cfg.whisperBin, r.args)}\n`);
  }
  process.exit(0);
}

assertSafeOutDir(cfg.outDir);
if (!existsSync(cfg.whisperBin)) die(`whisper binary not found: ${cfg.whisperBin}`);
for (const m of cfg.models) if (!existsSync(m.path)) die(`model not found: ${m.path}`);
for (const a of cfg.audio) if (!existsSync(a.path)) die(`audio not found: ${a.path}`);
await mkdir(cfg.outDir, { recursive: true });

const hash = async (p: string): Promise<{ sha256: string | null; bytes: number | null }> => {
  if (values["no-hash"]) return { sha256: null, bytes: null };
  process.stderr.write(`hashing ${p} ...\n`);
  return sha256File(p);
};

const audioMs = new Map<string, number | null>();
const references = new Map<string, string>();
const audioMeta: BenchResults["audio"] = [];
for (const a of cfg.audio) {
  let ms: number | null = a.durationMs ?? null;
  if (ms === null) {
    try {
      ms = (await readWavInfo(a.path)).durationMs;
    } catch (e) {
      process.stderr.write(`warning: cannot read WAV duration of ${a.id} (${(e as Error).message}); RTF will be empty. Convert to 16 kHz WAV or set durationMs.\n`);
    }
  }
  audioMs.set(a.id, ms);
  if (a.referenceTextFile) references.set(a.id, (await readFile(a.referenceTextFile, "utf8")).replace(/^﻿/, ""));
  audioMeta.push({ id: a.id, durationMs: ms, sha256: (await hash(a.path)).sha256, hasReference: a.referenceTextFile !== undefined });
}

const results: BenchResults = {
  harness: { name: "s04-whisper-bench", schemaVersion: 1 },
  startedAt: new Date().toISOString(),
  finishedAt: null,
  host: {
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    cpus: `${os.cpus().length}x ${os.cpus()[0]?.model ?? "?"}`,
    node: process.version,
  },
  manual: {
    gpuDriverVersion: values.driver ?? null,
    whisperCppVersion: values["whisper-version"] ?? null,
    notes: values.notes ?? null,
  },
  binary: { path: cfg.whisperBin, sha256: (await hash(cfg.whisperBin)).sha256 },
  models: [],
  audio: audioMeta,
  glossaryPromptSha256: glossaryPrompt === null ? null : createHash("sha256").update(glossaryPrompt, "utf8").digest("hex"),
  runs: [],
};
for (const m of cfg.models) results.models.push({ id: m.id, path: m.path, ...(await hash(m.path)) });

const persist = async (): Promise<void> => {
  await writeFile(path.join(cfg.outDir, "results.json"), JSON.stringify(results, null, 2));
  await writeFile(path.join(cfg.outDir, "results.md"), renderMarkdown(results));
};
if (glossaryPrompt !== null) await writeFile(path.join(cfg.outDir, "glossary-prompt.txt"), glossaryPrompt);
await persist();

for (const [i, r] of runs.entries()) {
  process.stderr.write(`[${i + 1}/${runs.length}] ${r.runId}\n`);
  await mkdir(path.dirname(r.outPrefix), { recursive: true });
  const proc = await runProcess(cfg.whisperBin, r.args, { timeoutMs: cfg.timeoutSec * 1000 });
  await writeFile(r.stdoutPath, proc.stdout);
  await writeFile(r.stderrPath, proc.stderr);

  const res: RunResult = {
    runId: r.runId,
    modelId: r.modelId,
    audioId: r.audioId,
    prompt: r.prompt,
    vad: r.vad,
    gpu: r.gpu,
    repeat: r.repeat,
    command: formatCommand(cfg.whisperBin, r.args),
    exitCode: proc.exitCode,
    timedOut: proc.timedOut,
    spawnError: proc.spawnError,
    wallMs: proc.wallMs,
    audioMs: audioMs.get(r.audioId) ?? null,
    rtf: realTimeFactor(proc.wallMs, audioMs.get(r.audioId) ?? null),
    outputs: { json: null, jsonSha256: null, stdout: r.stdoutPath, stderr: r.stderrPath },
    segments: null,
    parseWarnings: [],
    confidence: null,
    scores: null,
    evidence: parseStderr(proc.stderr),
  };

  if (existsSync(r.jsonPath)) {
    res.outputs.json = r.jsonPath;
    res.outputs.jsonSha256 = (await sha256File(r.jsonPath)).sha256;
    try {
      const t = parseWhisperJson(await readFile(r.jsonPath, "utf8"));
      res.segments = t.segments.length;
      res.parseWarnings = t.warnings;
      res.confidence = summarizeConfidence(t).summary;
      const ref = references.get(r.audioId);
      if (ref !== undefined) res.scores = scoreTranscript(ref, transcriptText(t), glossary);
    } catch (e) {
      res.parseWarnings.push(`parse failed: ${(e as Error).message}`);
    }
  } else {
    res.parseWarnings.push("no JSON output produced");
  }
  results.runs.push(res);
  await persist();
}

results.finishedAt = new Date().toISOString();
await persist();
process.stdout.write(renderMarkdown(results));
process.stderr.write(`\nwrote ${path.join(cfg.outDir, "results.json")} and results.md\n`);
