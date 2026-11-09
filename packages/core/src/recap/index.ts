/**
 * Recap: evidence-backed recap generation (T13). Approval and export build on this (T15).
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
export { allocateRecapRevision } from './revisions.ts';
