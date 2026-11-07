/**
 * Benchmark config parsing and matrix expansion (pure).
 *
 * Paths in the config are resolved relative to the config file's directory.
 * Keep the config (it contains local paths) and all outputs OUTSIDE git.
 */
import path from "node:path";
import { buildWhisperArgs, type VadOptions } from "./commands.ts";

export interface ModelSpec {
  id: string;
  path: string;
}

export interface AudioSpec {
  id: string;
  path: string;
  /** Optional hand-checked reference transcript (UTF-8 text) for WER/CER. */
  referenceTextFile?: string;
  /** Optional override when duration cannot be read from a WAV header. */
  durationMs?: number;
}

export type PromptVariant = "none" | "glossary";
export type VadVariant = "off" | "whisper-vad";

export interface BenchConfig {
  whisperBin: string;
  models: ModelSpec[];
  audio: AudioSpec[];
  language: string;
  promptVariants: PromptVariant[];
  /** Text file containing the exact `--prompt` (preferred: reviewed by the GM). */
  glossaryPromptFile?: string;
  /** Glossary JSON ({ entries }) for term/name accuracy and/or prompt building. */
  glossaryFile?: string;
  vadVariants: VadVariant[];
  vad?: VadOptions;
  /** Run a CPU-only (`-ng`) baseline in addition to GPU. */
  includeCpuBaseline: boolean;
  threads?: number;
  beamSize?: number;
  fullJson: boolean;
  repeats: number;
  /** Seconds; a run exceeding it is killed and recorded as timed out. */
  timeoutSec: number;
  extraArgs: string[];
  outDir: string;
}

function fail(msg: string): never {
  throw new Error(`bench config: ${msg}`);
}

function reqString(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  if (typeof v !== "string" || v.trim() === "") fail(`\`${k}\` must be a non-empty string`);
  return v;
}

function optString(o: Record<string, unknown>, k: string): string | undefined {
  const v = o[k];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.trim() === "") fail(`\`${k}\` must be a non-empty string`);
  return v;
}

function optPosInt(o: Record<string, unknown>, k: string): number | undefined {
  const v = o[k];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) fail(`\`${k}\` must be a positive integer`);
  return v;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function parseBenchConfig(json: unknown, configDir: string): BenchConfig {
  if (typeof json !== "object" || json === null || Array.isArray(json)) fail("root must be an object");
  const o = json as Record<string, unknown>;
  const r = (p: string): string => path.resolve(configDir, p);

  const ids = new Set<string>();
  const checkId = (id: string, what: string): void => {
    if (!SAFE_ID.test(id)) fail(`${what} id "${id}" must match ${SAFE_ID}`);
    if (ids.has(`${what}:${id}`)) fail(`duplicate ${what} id "${id}"`);
    ids.add(`${what}:${id}`);
  };

  if (!Array.isArray(o["models"]) || o["models"].length === 0) fail("`models` must be a non-empty array");
  const models = (o["models"] as unknown[]).map((m, i): ModelSpec => {
    if (typeof m !== "object" || m === null) fail(`models[${i}] must be an object`);
    const mo = m as Record<string, unknown>;
    const id = reqString(mo, "id");
    checkId(id, "model");
    return { id, path: r(reqString(mo, "path")) };
  });

  if (!Array.isArray(o["audio"]) || o["audio"].length === 0) fail("`audio` must be a non-empty array");
  const audio = (o["audio"] as unknown[]).map((a, i): AudioSpec => {
    if (typeof a !== "object" || a === null) fail(`audio[${i}] must be an object`);
    const ao = a as Record<string, unknown>;
    const id = reqString(ao, "id");
    checkId(id, "audio");
    const spec: AudioSpec = { id, path: r(reqString(ao, "path")) };
    const ref = optString(ao, "referenceTextFile");
    if (ref !== undefined) spec.referenceTextFile = r(ref);
    const d = optPosInt(ao, "durationMs");
    if (d !== undefined) spec.durationMs = d;
    return spec;
  });

  const promptVariants = (o["promptVariants"] ?? ["none", "glossary"]) as unknown;
  if (!Array.isArray(promptVariants) || promptVariants.length === 0 || !promptVariants.every((p) => p === "none" || p === "glossary")) {
    fail('`promptVariants` must be a non-empty subset of ["none","glossary"]');
  }
  const vadVariants = (o["vadVariants"] ?? ["off"]) as unknown;
  if (!Array.isArray(vadVariants) || vadVariants.length === 0 || !vadVariants.every((p) => p === "off" || p === "whisper-vad")) {
    fail('`vadVariants` must be a non-empty subset of ["off","whisper-vad"]');
  }

  const cfg: BenchConfig = {
    whisperBin: r(reqString(o, "whisperBin")),
    models,
    audio,
    language: optString(o, "language") ?? "pt",
    promptVariants: promptVariants as PromptVariant[],
    vadVariants: vadVariants as VadVariant[],
    includeCpuBaseline: o["includeCpuBaseline"] === true,
    fullJson: o["fullJson"] !== false,
    repeats: optPosInt(o, "repeats") ?? 1,
    timeoutSec: optPosInt(o, "timeoutSec") ?? 3600,
    extraArgs: [],
    outDir: r(reqString(o, "outDir")),
  };

  const extra = o["extraArgs"];
  if (extra !== undefined) {
    if (!Array.isArray(extra) || !extra.every((x) => typeof x === "string")) fail("`extraArgs` must be an array of strings");
    cfg.extraArgs = extra as string[];
  }
  const t = optPosInt(o, "threads");
  if (t !== undefined) cfg.threads = t;
  const bs = optPosInt(o, "beamSize");
  if (bs !== undefined) cfg.beamSize = bs;
  const gp = optString(o, "glossaryPromptFile");
  if (gp !== undefined) cfg.glossaryPromptFile = r(gp);
  const gf = optString(o, "glossaryFile");
  if (gf !== undefined) cfg.glossaryFile = r(gf);

  if (cfg.promptVariants.includes("glossary") && !cfg.glossaryPromptFile && !cfg.glossaryFile) {
    fail('promptVariants includes "glossary" but neither `glossaryPromptFile` nor `glossaryFile` is set');
  }

  if (o["vad"] !== undefined) {
    if (typeof o["vad"] !== "object" || o["vad"] === null) fail("`vad` must be an object");
    const vo = o["vad"] as Record<string, unknown>;
    const vad: VadOptions = { modelPath: r(reqString(vo, "modelPath")) };
    if (typeof vo["threshold"] === "number") vad.threshold = vo["threshold"];
    const ms = optPosInt(vo, "minSpeechMs");
    if (ms !== undefined) vad.minSpeechMs = ms;
    const msl = optPosInt(vo, "minSilenceMs");
    if (msl !== undefined) vad.minSilenceMs = msl;
    const sp = optPosInt(vo, "speechPadMs");
    if (sp !== undefined) vad.speechPadMs = sp;
    cfg.vad = vad;
  }
  if (cfg.vadVariants.includes("whisper-vad") && !cfg.vad) {
    fail('vadVariants includes "whisper-vad" but `vad.modelPath` is not set');
  }
  return cfg;
}

export interface RunPlan {
  runId: string;
  modelId: string;
  audioId: string;
  prompt: PromptVariant;
  vad: VadVariant;
  gpu: boolean;
  repeat: number;
  args: string[];
  outPrefix: string;
  jsonPath: string;
  stdoutPath: string;
  stderrPath: string;
}

/** Expand models × audio × prompt × vad × device × repeats into concrete runs. */
export function planRuns(cfg: BenchConfig, glossaryPrompt: string | null): RunPlan[] {
  if (cfg.promptVariants.includes("glossary") && (glossaryPrompt === null || glossaryPrompt.trim() === "")) {
    throw new Error('planRuns: "glossary" prompt variant requested but prompt text is empty');
  }
  const devices = cfg.includeCpuBaseline ? [true, false] : [true];
  const runs: RunPlan[] = [];
  for (const model of cfg.models) {
    for (const audio of cfg.audio) {
      for (const prompt of cfg.promptVariants) {
        for (const vad of cfg.vadVariants) {
          for (const gpu of devices) {
            for (let repeat = 1; repeat <= cfg.repeats; repeat++) {
              const runId = [model.id, audio.id, `prompt-${prompt}`, `vad-${vad}`, gpu ? "gpu" : "cpu", `r${repeat}`].join("__");
              const outPrefix = path.join(cfg.outDir, "runs", runId, "out");
              const args = buildWhisperArgs({
                modelPath: model.path,
                audioPath: audio.path,
                outPrefix,
                language: cfg.language,
                prompt: prompt === "glossary" ? glossaryPrompt : null,
                gpu,
                fullJson: cfg.fullJson,
                vad: vad === "whisper-vad" ? (cfg.vad ?? null) : null,
                extraArgs: cfg.extraArgs,
                ...(cfg.threads !== undefined ? { threads: cfg.threads } : {}),
                ...(cfg.beamSize !== undefined ? { beamSize: cfg.beamSize } : {}),
              });
              runs.push({
                runId,
                modelId: model.id,
                audioId: audio.id,
                prompt,
                vad,
                gpu,
                repeat,
                args,
                outPrefix,
                jsonPath: `${outPrefix}.json`,
                stdoutPath: path.join(cfg.outDir, "runs", runId, "stdout.txt"),
                stderrPath: path.join(cfg.outDir, "runs", runId, "stderr.txt"),
              });
            }
          }
        }
      }
    }
  }
  return runs;
}

/** Real-time factor = processing wall time / audio duration (lower is faster). */
export function realTimeFactor(wallMs: number, audioMs: number | null): number | null {
  if (audioMs === null || audioMs <= 0) return null;
  return wallMs / audioMs;
}
