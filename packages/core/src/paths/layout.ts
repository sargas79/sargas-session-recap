import path from 'node:path';
import { assertSlug } from './slug.ts';

/** File name of the app-state database under `<root>/state/`. */
export const DB_FILE_NAME = 'recap.sqlite';

/**
 * The ADR-009 data root layout. Every module builds data paths through this
 * object; no module joins data-root segments by hand.
 *
 * ```text
 * <root>/campaigns/<campaign_id>/sessions/<session_id>/   session package (ADR-006)
 * <root>/state/recap.sqlite                               app state (ADR-001)
 * <root>/state/backups/                                   pre-migration DB backups
 * <root>/tools/                                           downloaded tools (T23)
 * <root>/logs/                                            structured logs
 * ```
 */
export interface DataPaths {
  /** Absolute data root. */
  readonly root: string;
  readonly campaignsDir: string;
  readonly stateDir: string;
  readonly dbFile: string;
  readonly backupsDir: string;
  readonly toolsDir: string;
  readonly logsDir: string;
  /** `<root>/campaigns/<campaign_id>`; throws `PATHS_INVALID_ID` for a non-slug. */
  campaignDir(campaignId: string): string;
  /** `<root>/campaigns/<campaign_id>/sessions`. */
  sessionsDir(campaignId: string): string;
  /** Session package directory `<root>/campaigns/<campaign_id>/sessions/<session_id>`. */
  sessionDir(campaignId: string, sessionId: string): string;
}

/** Builds the layout for an absolute data root. Does not touch the filesystem. */
export function createDataPaths(root: string): DataPaths {
  const base = path.resolve(root);
  const campaignsDir = path.join(base, 'campaigns');
  const stateDir = path.join(base, 'state');

  const campaignDir = (campaignId: string): string =>
    path.join(campaignsDir, assertSlug('campaign_id', campaignId));
  const sessionsDir = (campaignId: string): string =>
    path.join(campaignDir(campaignId), 'sessions');

  return Object.freeze({
    root: base,
    campaignsDir,
    stateDir,
    dbFile: path.join(stateDir, DB_FILE_NAME),
    backupsDir: path.join(stateDir, 'backups'),
    toolsDir: path.join(base, 'tools'),
    logsDir: path.join(base, 'logs'),
    campaignDir,
    sessionsDir,
    sessionDir: (campaignId: string, sessionId: string): string =>
      path.join(sessionsDir(campaignId), assertSlug('session_id', sessionId)),
  });
}
