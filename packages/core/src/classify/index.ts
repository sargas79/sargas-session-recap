/**
 * Classify: core-owned classification windows, corrections and evidence validation (T11).
 */
export const MODULE_NAME = 'classify';

export { createClassifyStage, type ClassifyStageOptions } from './classify-stage.ts';
export {
  applyCorrections,
  glossarySpellings,
  type Correction,
  type CorrectionOutcome,
  type GlossarySpellings,
  type RejectedCorrection,
} from './corrections.ts';
export { coverageProblems, finalizeWindow, type FinalizeOutcome } from './finalize.ts';
export { defaultRecapInclusion, type DefaultRecapInclusion } from './recap-input.ts';
export {
  DEFAULT_WINDOW_PARAMS,
  orderSegments,
  planWindows,
  segmentRef,
  windowData,
  windowSpeakers,
  type ClassificationWindow,
  type WindowParams,
} from './windows.ts';
