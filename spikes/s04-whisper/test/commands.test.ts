import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseBenchConfig, planRuns, realTimeFactor } from "../src/bench-config.ts";
import {
  buildFfmpegExtractArgs,
  buildFfmpegToWav16kArgs,
  buildSilencedetectArgs,
  buildWhisperArgs,
  formatCommand,
} from "../src/commands.ts";
import { renderMarkdown, type BenchResults } from "../src/report.ts";
import { parseStderr } from "../src/stderr.ts";
import { makeSilentWav, parseWavHeader } from "../src/wav.ts";

describe("buildWhisperArgs", () => {
  it("builds a minimal full-JSON GPU invocation", () => {
    expect(
      buildWhisperArgs({ modelPath: "m.bin", audioPath: "a.wav", outPrefix: "out/x", language: "pt", gpu: true, fullJson: true }),
    ).toEqual(["-m", "m.bin", "-f", "a.wav", "-l", "pt", "-of", "out/x", "-oj", "-ojf"]);
  });

  it("adds prompt as a single argument (no shell quoting), CPU flag, VAD and extras", () => {
    const prompt = "Termos: Shield Block, d'água; \"aspas\" & $(nope)";
    const args = buildWhisperArgs({
      modelPath: "C:/m dir/m.bin",
      audioPath: "a.wav",
      outPrefix: "o",
      language: "pt",
      gpu: false,
      fullJson: false,
      prompt,
      threads: 8,
      beamSize: 5,
      bestOf: 5,
      vad: { modelPath: "vad.bin", threshold: 0.5, minSpeechMs: 250, minSilenceMs: 500, speechPadMs: 30 },
      extraArgs: ["-dev", "0"],
    });
    expect(args).toEqual([
      "-m", "C:/m dir/m.bin", "-f", "a.wav", "-l", "pt", "-of", "o", "-oj",
      "-t", "8", "-bs", "5", "-bo", "5", "-ng",
      "--prompt", prompt,
      "--vad", "-vm", "vad.bin", "-vt", "0.5", "-vspd", "250", "-vsd", "500", "-vp", "30",
      "-dev", "0",
    ]);
    expect(args).not.toContain("-ojf");
  });

  it("omits empty prompts", () => {
    const args = buildWhisperArgs({ modelPath: "m", audioPath: "a", outPrefix: "o", language: "pt", gpu: true, fullJson: true, prompt: "" });
    expect(args).not.toContain("--prompt");
  });
});

describe("ffmpeg args", () => {
  it("extracts a chunk with output seeking at ms precision", () => {
    expect(buildFfmpegExtractArgs("in.wav", 30_000, 25_500, "c.wav")).toEqual([
      "-hide_banner", "-nostdin", "-y", "-i", "in.wav", "-ss", "30.000", "-t", "25.500",
      "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "c.wav",
    ]);
    expect(() => buildFfmpegExtractArgs("in.wav", -1, 10, "c.wav")).toThrow();
    expect(() => buildFfmpegExtractArgs("in.wav", 1.5, 10, "c.wav")).toThrow();
  });
  it("builds silencedetect and wav conversion", () => {
    expect(buildSilencedetectArgs("in.wav", -35, 500)).toEqual([
      "-hide_banner", "-nostdin", "-i", "in.wav", "-af", "silencedetect=noise=-35dB:d=0.500", "-f", "null", "-",
    ]);
    expect(buildFfmpegToWav16kArgs("in.m4a", "out.wav")).toContain("16000");
  });
});

describe("formatCommand", () => {
  it("quotes for PowerShell display", () => {
    expect(formatCommand("C:/w/whisper-cli.exe", ["-m", "C:/a b/m.bin", "--prompt", "it's"])).toBe(
      "& C:/w/whisper-cli.exe -m 'C:/a b/m.bin' --prompt 'it''s'",
    );
  });
});

describe("bench config + planRuns", () => {
  const dir = path.resolve("/tmp/s04cfg");
  const example = JSON.parse(readFileSync(new URL("../fixtures/bench.config.example.json", import.meta.url), "utf8"));

  it("parses the example config", () => {
    const cfg = parseBenchConfig(example, dir);
    expect(cfg.models.map((m) => m.id)).toEqual(["large-v3-turbo", "large-v3"]);
    expect(cfg.promptVariants).toEqual(["none", "glossary"]);
    expect(cfg.vadVariants).toEqual(["off", "whisper-vad"]);
    expect(cfg.fullJson).toBe(true);
    expect(cfg.repeats).toBe(2);
  });

  it("resolves relative paths against the config directory", () => {
    const cfg = parseBenchConfig(
      { whisperBin: "bin/w.exe", models: [{ id: "t", path: "m.bin" }], audio: [{ id: "a", path: "a.wav" }], promptVariants: ["none"], outDir: "out" },
      dir,
    );
    expect(cfg.whisperBin).toBe(path.join(dir, "bin", "w.exe"));
    expect(cfg.outDir).toBe(path.join(dir, "out"));
    expect(cfg.language).toBe("pt");
    expect(cfg.vadVariants).toEqual(["off"]);
  });

  it("rejects bad configs", () => {
    const base = { whisperBin: "w", models: [{ id: "t", path: "m" }], audio: [{ id: "a", path: "a" }], outDir: "o", promptVariants: ["none"] };
    expect(() => parseBenchConfig({ ...base, models: [] }, dir)).toThrow(/models/);
    expect(() => parseBenchConfig({ ...base, models: [{ id: "../x", path: "m" }] }, dir)).toThrow(/id/);
    expect(() => parseBenchConfig({ ...base, models: [{ id: "t", path: "m" }, { id: "t", path: "n" }] }, dir)).toThrow(/duplicate/);
    expect(() => parseBenchConfig({ ...base, promptVariants: ["glossary"] }, dir)).toThrow(/glossary/);
    expect(() => parseBenchConfig({ ...base, vadVariants: ["whisper-vad"] }, dir)).toThrow(/vad/);
    expect(() => parseBenchConfig({ ...base, extraArgs: [1] }, dir)).toThrow(/extraArgs/);
  });

  it("expands the full matrix with deterministic ids and paths", () => {
    const cfg = parseBenchConfig({ ...example, includeCpuBaseline: true }, dir);
    const runs = planRuns(cfg, "Termos: Shield Block.");
    // 2 models × 2 audio × 2 prompts × 2 vad × 2 devices × 2 repeats
    expect(runs).toHaveLength(64);
    expect(new Set(runs.map((r) => r.runId)).size).toBe(64);
    const r = runs.find((x) => x.runId === "large-v3__excerpt01__prompt-glossary__vad-whisper-vad__cpu__r2")!;
    expect(r).toBeDefined();
    expect(r.args).toContain("-ng");
    expect(r.args.slice(r.args.indexOf("--prompt"), r.args.indexOf("--prompt") + 2)).toEqual(["--prompt", "Termos: Shield Block."]);
    expect(r.args).toContain("--vad");
    expect(r.jsonPath).toBe(path.join(cfg.outDir, "runs", r.runId, "out") + ".json");
    const none = runs.find((x) => x.prompt === "none")!;
    expect(none.args).not.toContain("--prompt");
  });

  it("refuses a glossary variant with an empty prompt", () => {
    const cfg = parseBenchConfig(example, dir);
    expect(() => planRuns(cfg, "  ")).toThrow(/empty/);
  });

  it("computes RTF", () => {
    expect(realTimeFactor(5000, 50_000)).toBe(0.1);
    expect(realTimeFactor(5000, null)).toBeNull();
    expect(realTimeFactor(5000, 0)).toBeNull();
  });
});

describe("stderr evidence (synthetic log lines)", () => {
  it("extracts vulkan lines, system_info and timings", () => {
    const log = [
      "ggml_vulkan: Found 1 Vulkan devices:",
      "ggml_vulkan: 0 = SYNTHETIC GPU (driver) | uma: 0 | fp16: 1",
      "whisper_init_with_params_no_state: use gpu    = 1",
      "system_info: n_threads = 8 / 16 | WHISPER : COREML = 0 |",
      "whisper_print_timings:     load time =   812.34 ms",
      "whisper_print_timings:   encode time =  1234.50 ms /     3 runs (  411.50 ms per run)",
      "whisper_print_timings:    total time =  4321.00 ms",
    ].join("\r\n");
    const e = parseStderr(log);
    expect(e.vulkanMentioned).toBe(true);
    expect(e.cpuFallbackSuspected).toBe(false);
    expect(e.systemInfo).toMatch(/^system_info:/);
    expect(e.timings).toEqual({ load_time: 812.34, encode_time: 1234.5, total_time: 4321 });
  });
  it("flags suspected CPU fallback", () => {
    expect(parseStderr("whisper_init_with_params_no_state: use gpu    = 0").cpuFallbackSuspected).toBe(true);
  });
});

describe("WAV header", () => {
  it("reads duration of a synthetic silent WAV", () => {
    const w = parseWavHeader(makeSilentWav(2500));
    expect(w).toMatchObject({ sampleRate: 16000, channels: 1, bitsPerSample: 16, durationMs: 2500 });
  });
  it("rejects non-WAV", () => {
    expect(() => parseWavHeader(Buffer.from("not a wav file at all"))).toThrow(/RIFF/);
  });
});

describe("renderMarkdown", () => {
  it("renders empty cells as dashes and never invents values", () => {
    const r: BenchResults = {
      harness: { name: "s04-whisper-bench", schemaVersion: 1 },
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: null,
      host: { platform: "win32", release: "x", arch: "x64", cpus: "1x test", node: "v24" },
      manual: { gpuDriverVersion: null, whisperCppVersion: null, notes: null },
      binary: { path: "w.exe", sha256: null },
      models: [{ id: "t", path: "m", sha256: null, bytes: null }],
      audio: [],
      glossaryPromptSha256: null,
      runs: [
        {
          runId: "t__a", modelId: "t", audioId: "a", prompt: "none", vad: "off", gpu: true, repeat: 1,
          command: "& w.exe", exitCode: 1, timedOut: false, spawnError: null, wallMs: 1500, audioMs: null, rtf: null,
          outputs: { json: null, jsonSha256: null, stdout: "s", stderr: "e" },
          segments: null, parseWarnings: [], confidence: null, scores: null, evidence: null,
        },
      ],
    };
    const md = renderMarkdown(r);
    expect(md).toContain("(GM to fill)");
    expect(md).toContain("| t__a | t | a | none | off | gpu | 1 | 1.5 | — | — |");
    expect(md).toContain("PROVISIONAL");
  });
});
