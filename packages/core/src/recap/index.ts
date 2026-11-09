/**
 * Recap: evidence-backed recap generation (T13), and its editing, approval and export (T15).
 */
export const MODULE_NAME = 'recap';

export {
  buildRecap,
  finalizeRecapOutput,
  finishedRecapProblems,
  recapCitationProblems,
  unresolvedNote,
  type DraftNote,
  type DraftSentence,
  type FinalizeOutcome,
  type RecapDraft,
  type RecapIdentity,
} from './citations.ts';
export {
  evidenceOf,
  refOf,
  segmentsData,
  selectRecapInput,
  speakersOf,
  type RecapEvidence,
  type RecapInput,
  type ReviewSegment,
} from './evidence.ts';
export { loadPreviousRecaps, MAX_PREVIOUS_RECAPS, type PreviousRecap } from './previous.ts';
export { createRecapStage, type RecapStageOptions } from './recap-stage.ts';
export {
  renderGmNotesMarkdown,
  renderRecapMarkdown,
  type SegmentSource,
  type SegmentSources,
} from './render.ts';
export { allocateForkRevision, allocateRecapRevision } from './revisions.ts';
export {
  applyRecapEdit,
  approvedRecapMarkdown,
  approveRecap,
  effectiveRecap,
  exportRecap,
  latestExportFile,
  latestRecapRevision,
  loadEditorialView,
  loadRecapDraft,
  markRecapReviewed,
  normalizeEditText,
  reopenRecap,
  releaseBlockers,
  type EditOutcome,
  type EditRequest,
  type EffectiveNote,
  type EffectiveRecap,
  type EffectiveSentence,
  type ExportFile,
  type ExportOutcome,
  type RecapEditorialView,
  type ReleaseBlocker,
  type SpoilerAcknowledgement,
} from './editorial.ts';
export { isRecapEditorialError, RecapEditorialError } from './errors.ts';
export { buildRecapPackage, EXPORT_GENERATOR_VERSION } from './export-package.ts';
