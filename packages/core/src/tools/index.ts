/** Pinned external tools: whisper.cpp binary and model provisioning and verification (T23). */
export { ToolsError, isToolsError, type ToolsErrorCode } from './errors.ts';
export {
  activeModel,
  defaultToolsLockFile,
  isAllowedDownloadUrl,
  loadToolsLock,
  parseToolsLock,
} from './lock.ts';
export { loadWhisperOverrides, type ResolvedOverrides } from './overrides.ts';
export {
  inspectWhisper,
  isUsable,
  resolveWhisperTools,
  whisperJobInputs,
  type BinaryCheck,
  type FileCheck,
  type FileState,
  type InspectOptions,
  type ItemState,
  type ModelCheck,
  type ResolveWhisperOptions,
  type WhisperInspection,
  type WhisperTools,
} from './inspect.ts';
export { downloadVerified, type DownloadOptions, type DownloadTarget } from './download.ts';
export { extractZip } from './archive.ts';
export {
  runWhisperSetup,
  type PlannedDownload,
  type SetupOptions,
  type SetupResult,
  type SetupStatus,
} from './setup.ts';
export { checkWhisper, type WhisperCheck, type WhisperCheckOptions } from './doctor.ts';
export {
  parseVulkanSummary,
  probeVulkan,
  vulkanStatusFromOutput,
  type VulkanDevice,
  type VulkanProbe,
  type VulkanStatus,
} from './vulkan.ts';
export {
  confirmOnTerminal,
  registerSetupCommands,
  type ConfirmInput,
  type SetupCliDeps,
  type SetupCliIo,
} from './cli.ts';
