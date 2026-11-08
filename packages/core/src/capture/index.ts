/**
 * Capture: the multitrack recording import adapter (T05). The optional Discord recorder (T06)
 * will live here too; both produce packages that pass the same validator (ADR-006).
 */
export const MODULE_NAME = 'capture';

export { ImportError, isImportError, type ImportErrorCode } from './errors.ts';
export {
  AUDIO_EXTENSIONS,
  defaultTrackProbe,
  importRecording,
  MAPPING_FILE_NAMES,
  type ExcludedTrack,
  type ExclusionReason,
  type ImportedTrack,
  type ImportHooks,
  type ImportOptions,
  type ImportResult,
  type TrackProbe,
} from './import.ts';
export { newUlid } from './ulid.ts';
export { probeWavHeader } from './wav.ts';
export { registerImportCommands, type ImportCliDeps, type ImportCliIo } from './cli.ts';
