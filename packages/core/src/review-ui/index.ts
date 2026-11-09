/**
 * Review UI: the localhost review server and screen (T14). Corrections go through `review/`, recap
 * generation through the job runner, and editing, approval and export through `recap/` (T15).
 */
export const MODULE_NAME = 'review-ui';

export { registerReviewUiCommand, type ReviewUiCliDeps } from './cli.ts';
export {
  attentionReasons,
  reviewQueue,
  type AttentionReason,
  type RecapDraftView,
  type ReviewScreen,
} from './data.ts';
export { refusalOf, ReviewUiError } from './errors.ts';
export { escapeHtml, html, SafeHtml } from './html.ts';
export { startReviewServer, type ReviewServerOptions, type RunningReviewServer } from './server.ts';
