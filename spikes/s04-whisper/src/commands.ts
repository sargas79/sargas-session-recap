/**
 * Pure argument-array builders for whisper.cpp (`whisper-cli`) and ffmpeg.
 * Nothing here spawns a process; everything is unit-tested.
 *
 * Flag names follow whisper.cpp `whisper-cli --help` of the v1.7.x line. The GM
 * must check them against `--help` of the pinned binary (see the doc).
 */

export interface VadOptions {
  /** Path to the Silero VAD ggml model (e.g. ggml-silero-v5.1.2.bin). */
  modelPath: string;
  threshold?: number;
  minSpeechMs?: number;
  minSilenceMs?: number;
  speechPadMs?: number;
}

export interface WhisperInvocation {
  modelPath: string;
  audioPath: string;
  /** Output path WITHOUT extension; whisper.cpp appends `.json`. */
  outPrefix: string;
  language: string;
  prompt?: string | null;
  threads?: number;
  /** false adds `-ng` (CPU-only baseline). */
  gpu: boolean;
  /** true => `-ojf` (tokens + probabilities); false => `-oj`. */
  fullJson: boolean;
  beamSize?: number;
  bestOf?: number;
  vad?: VadOptions | null;
  /** Appended verbatim, e.g. ["-dev", "0"] or ["--max-len", "1"]. */
  extraArgs?: string[];
}

export function buildWhisperArgs(inv: WhisperInvocation): string[] {
  const args: string[] = [
    "-m", inv.modelPath,
    "-f", inv.audioPath,
    "-l", inv.language,
    "-of", inv.outPrefix,
  ];
  // -ojf implies -oj in whisper-cli, but passing both is harmless and survives
  // versions where it does not.
  args.push("-oj");
  if (inv.fullJson) args.push("-ojf");
  if (inv.threads !== undefined) args.push("-t", String(inv.threads));
  if (inv.beamSize !== undefined) args.push("-bs", String(inv.beamSize));
  if (inv.bestOf !== undefined) args.push("-bo", String(inv.bestOf));
  if (!inv.gpu) args.push("-ng");
  if (inv.prompt !== undefined && inv.prompt !== null && inv.prompt.length > 0) {
    args.push("--prompt", inv.prompt);
  }
  if (inv.vad) {
    args.push("--vad", "-vm", inv.vad.modelPath);
    if (inv.vad.threshold !== undefined) args.push("-vt", String(inv.vad.threshold));
    if (inv.vad.minSpeechMs !== undefined) args.push("-vspd", String(inv.vad.minSpeechMs));
    if (inv.vad.minSilenceMs !== undefined) args.push("-vsd", String(inv.vad.minSilenceMs));
    if (inv.vad.speechPadMs !== undefined) args.push("-vp", String(inv.vad.speechPadMs));
  }
  if (inv.extraArgs) args.push(...inv.extraArgs);
  return args;
}

function msToSeconds(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0) throw new Error(`invalid ms: ${ms}`);
  return (ms / 1000).toFixed(3);
}

/**
 * Extract [startMs, startMs+durationMs) as 16 kHz mono s16 WAV.
 * `-ss`/`-t` are placed AFTER `-i` (output seeking): slower, but
 * sample-accurate for every input format, which the drift probe needs.
 */
export function buildFfmpegExtractArgs(
  input: string,
  startMs: number,
  durationMs: number,
  output: string,
): string[] {
  return [
    "-hide_banner", "-nostdin", "-y",
    "-i", input,
    "-ss", msToSeconds(startMs),
    "-t", msToSeconds(durationMs),
    "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
    output,
  ];
}

/** Whole-file conversion to whisper's preferred input format. */
export function buildFfmpegToWav16kArgs(input: string, output: string): string[] {
  return ["-hide_banner", "-nostdin", "-y", "-i", input, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", output];
}

/** `silencedetect` run; results are printed on stderr. */
export function buildSilencedetectArgs(input: string, noiseDb: number, minSilenceMs: number): string[] {
  return [
    "-hide_banner", "-nostdin",
    "-i", input,
    "-af", `silencedetect=noise=${noiseDb}dB:d=${msToSeconds(minSilenceMs)}`,
    "-f", "null", "-",
  ];
}

/**
 * Render a command for humans (PowerShell syntax). Display only: execution
 * always uses the argument array with `shell: false`.
 */
export function formatCommand(bin: string, args: readonly string[]): string {
  const q = (a: string): string => (/^[A-Za-z0-9_\-.:\\/=,+]+$/.test(a) ? a : `'${a.replace(/'/g, "''")}'`);
  return ["&", q(bin), ...args.map(q)].join(" ");
}
