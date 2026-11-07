/** Bench results shape + Markdown rendering (pure). */
import type { ConfidenceSummary } from "./confidence.ts";
import type { PromptVariant, VadVariant } from "./bench-config.ts";
import type { StderrEvidence } from "./stderr.ts";

export interface RunScores {
  wer: number | null;
  werNoDiacritics: number | null;
  cer: number | null;
  termAccuracy: number | null;
  nameAccuracy: number | null;
}

export interface RunResult {
  runId: string;
  modelId: string;
  audioId: string;
  prompt: PromptVariant;
  vad: VadVariant;
  gpu: boolean;
  repeat: number;
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  spawnError: string | null;
  wallMs: number;
  audioMs: number | null;
  rtf: number | null;
  outputs: { json: string | null; jsonSha256: string | null; stdout: string; stderr: string };
  segments: number | null;
  parseWarnings: string[];
  confidence: ConfidenceSummary | null;
  scores: RunScores | null;
  evidence: StderrEvidence | null;
}

export interface BenchResults {
  harness: { name: string; schemaVersion: 1 };
  startedAt: string;
  finishedAt: string | null;
  host: { platform: string; release: string; arch: string; cpus: string; node: string };
  /** Filled in by the GM, never guessed by the harness. */
  manual: { gpuDriverVersion: string | null; whisperCppVersion: string | null; notes: string | null };
  binary: { path: string; sha256: string | null };
  models: { id: string; path: string; sha256: string | null; bytes: number | null }[];
  audio: { id: string; durationMs: number | null; sha256: string | null; hasReference: boolean }[];
  glossaryPromptSha256: string | null;
  runs: RunResult[];
}

const dash = "—";
const f = (n: number | null | undefined, digits: number): string =>
  n === null || n === undefined ? dash : n.toFixed(digits);
const pct = (n: number | null | undefined): string =>
  n === null || n === undefined ? dash : `${(n * 100).toFixed(1)}%`;

export function renderMarkdown(r: BenchResults): string {
  const lines: string[] = [];
  lines.push(`# S04 bench results (${r.startedAt})`, "");
  lines.push(`- Host: ${r.host.platform} ${r.host.release} ${r.host.arch}, ${r.host.cpus}, Node ${r.host.node}`);
  lines.push(`- Binary: \`${r.binary.path}\` sha256 \`${r.binary.sha256 ?? "not computed"}\``);
  for (const m of r.models) lines.push(`- Model \`${m.id}\`: sha256 \`${m.sha256 ?? "not computed"}\` (${m.bytes ?? "?"} bytes)`);
  lines.push(`- Glossary prompt sha256: \`${r.glossaryPromptSha256 ?? "n/a"}\``);
  lines.push(`- GPU driver: ${r.manual.gpuDriverVersion ?? "(GM to fill)"}; whisper.cpp version: ${r.manual.whisperCppVersion ?? "(GM to fill)"}`);
  lines.push("", "Confidence columns use PROVISIONAL, uncalibrated thresholds.", "");
  lines.push(
    "| run | model | audio | prompt | vad | device | exit | wall s | audio s | RTF | segs | low-conf | mean p | WER | WER (no diacr.) | CER | term acc | name acc | Vulkan in log |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  );
  for (const x of r.runs) {
    const exit = x.spawnError ? "spawn-error" : x.timedOut ? "timeout" : String(x.exitCode);
    lines.push(
      `| ${x.runId} | ${x.modelId} | ${x.audioId} | ${x.prompt} | ${x.vad} | ${x.gpu ? "gpu" : "cpu"} | ${exit} | ${f(x.wallMs / 1000, 1)} | ${f(x.audioMs === null ? null : x.audioMs / 1000, 1)} | ${f(x.rtf, 3)} | ${x.segments ?? dash} | ${x.confidence ? `${x.confidence.lowConfidenceYes}/${x.confidence.segments}` : dash} | ${f(x.confidence?.meanOfMeanP, 3)} | ${pct(x.scores?.wer)} | ${pct(x.scores?.werNoDiacritics)} | ${pct(x.scores?.cer)} | ${pct(x.scores?.termAccuracy)} | ${pct(x.scores?.nameAccuracy)} | ${x.evidence ? (x.evidence.vulkanMentioned ? "yes" : "no") : dash} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
