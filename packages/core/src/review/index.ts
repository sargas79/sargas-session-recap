/**
 * Review: GM review overrides and the effective transcript projection (T12). The localhost review
 * screen (T14) builds on this.
 */
export const MODULE_NAME = 'review';

export { isReviewError, ReviewError, type ReviewErrorCode } from './errors.ts';
export { registerReviewCommands, type ReviewCliDeps } from './cli.ts';
export {
  projectEffectiveTranscript,
  toEffectiveTranscript,
  unattachedReason,
  unreconciledExclusions,
  type ProjectionInput,
  type UnattachedReason,
} from './project.ts';
export {
  discardUnreconciled,
  loadActiveRuns,
  loadSessionReview,
  reconcileToSegment,
  setSegmentOverride,
  type ActiveRuns,
  type SessionRef,
  type SessionReview,
} from './session.ts';
export {
  getOverride,
  listOverrideHistory,
  listOverrides,
  setOverride,
  toReviewOverride,
  type ExclusionReason,
  type HistoryAction,
  type OverrideChanges,
  type OverrideHistoryEntry,
  type OverrideIdentity,
  type RecapInclusion,
  type Reconciliation,
  type ReviewStatus,
  type StoredOverride,
} from './store.ts';
