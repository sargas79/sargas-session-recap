/**
 * Extract evidence from whisper-cli stderr. Line formats are based on
 * whisper.cpp v1.7.x / ggml-vulkan log lines and MUST be re-checked against
 * the real stderr captured by the bench runner (raw stderr is always kept).
 */

export interface WhisperTimings {
  /** ms values from `whisper_print_timings:` lines, keyed by label. */
  [label: string]: number;
}

export interface StderrEvidence {
  /** Lines that mention Vulkan / GPU devices / backends (deduplicated). */
  gpuLines: string[];
  /** `system_info:` line, if present. */
  systemInfo: string | null;
  timings: WhisperTimings;
  /** True if any line suggests Vulkan was initialised. Heuristic. */
  vulkanMentioned: boolean;
  /** True if a line suggests a fallback to CPU / no GPU. Heuristic. */
  cpuFallbackSuspected: boolean;
}

export function parseStderr(stderr: string): StderrEvidence {
  const lines = stderr.split(/\r?\n/);
  const gpuLines = new Set<string>();
  const timings: WhisperTimings = {};
  let systemInfo: string | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") continue;
    if (/vulkan|ggml_vk|use gpu|gpu_device|\bdevice \d|backend/i.test(line)) gpuLines.add(line);
    if (line.startsWith("system_info:")) systemInfo = line;
    // e.g. "whisper_print_timings:   encode time =   123.45 ms /     1 runs (  123.45 ms per run)"
    const t = /^whisper_print_timings:\s*(.+?)\s*=\s*([0-9.]+)\s*ms/.exec(line);
    if (t && t[1] !== undefined && t[2] !== undefined) timings[t[1].replace(/\s+/g, "_")] = Number(t[2]);
  }
  const all = [...gpuLines];
  return {
    gpuLines: all,
    systemInfo,
    timings,
    vulkanMentioned: all.some((l) => /vulkan|ggml_vk/i.test(l)),
    cpuFallbackSuspected: all.some((l) => /use gpu\s*=\s*0|no gpu|failed to initiali[sz]e.*(vulkan|gpu)/i.test(l)),
  };
}
