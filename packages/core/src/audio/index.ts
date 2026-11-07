/**
 * Audio toolchain: ffmpeg/ffprobe discovery, probing, 16 kHz mono decoding and
 * silence detection (T22). ffmpeg is an external prerequisite; it is never
 * vendored. See docs/setup-windows.md.
 */
export {
  AudioToolError,
  installHint,
  isAudioToolError,
  type AudioErrorCode,
  type AudioToolErrorOptions,
  type AudioToolName,
} from './errors.ts';
export {
  compareVersions,
  formatVersion,
  meetsMinimum,
  MIN_FFMPEG_VERSION,
  parseToolVersion,
  RECOMMENDED_FFMPEG_VERSION,
  type ReleaseVersion,
  type ToolVersion,
} from './version.ts';
export {
  DEFAULT_VERSION_TIMEOUT_MS,
  findOnPath,
  locateTool,
  resolveAudioToolchain,
  resolveTool,
  TOOL_ENV_VARS,
  type AudioToolchain,
  type AudioToolchainOptions,
  type ResolvedTool,
  type ToolLocation,
  type ToolRunner,
  type ToolSource,
} from './locate.ts';
export {
  DEFAULT_MAX_OUTPUT_BYTES,
  runTool,
  type RunToolOptions,
  type RunToolResult,
} from './run.ts';
export {
  DEFAULT_PROBE_TIMEOUT_MS,
  parseProbeJson,
  probeArgs,
  probeAudio,
  type AudioOperationOptions,
  type AudioProbe,
  type ProbeOptions,
} from './probe.ts';
export {
  DEFAULT_DECODE_TIMEOUT_MS,
  decodeArgs,
  decodeToPcm16kMono,
  PCM_16K_SAMPLE_RATE,
  type DecodeOptions,
} from './decode.ts';
export {
  DEFAULT_SILENCE_TIMEOUT_MS,
  detectSilences,
  parseSilenceDetect,
  silenceArgs,
  silenceFilter,
  type DetectSilencesOptions,
  type SilenceInterval,
  type SilenceParams,
} from './silence.ts';
export {
  checkAudioTool,
  checkAudioToolchain,
  formatAudioToolCheck,
  type AudioToolCheck,
} from './doctor.ts';
