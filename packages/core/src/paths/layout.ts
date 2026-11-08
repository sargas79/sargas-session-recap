import path from 'node:path';
import { PathsError } from './errors.ts';
import { assertSlug } from './slug.ts';

/** File name of the app-state database under `<root>/state/`. */
export const DB_FILE_NAME = 'recap.sqlite';

/** File name of a campaign's config under `<root>/campaigns/<campaign_id>/` (T04). */
export const CAMPAIGN_CONFIG_FILE_NAME = 'campaign.yaml';

/**
 * The ADR-009 data root layout. Every module builds data paths through this
 * object; no module joins data-root segments by hand.
 *
 * ```text
 * <root>/campaigns/<campaign_id>/campaign.yaml            campaign config (T04)
 * <root>/campaigns/<campaign_id>/sessions/<session_id>/   session package (ADR-006)
 * <root>/state/recap.sqlite                               app state (ADR-001)
 * <root>/state/backups/                                   pre-migration DB backups
 * <root>/state/locks/<campaign_id>/<session_id>.lock      per-session job lock file (T07)
 * <root>/tools/                                           downloaded tools (T23)
 * <root>/tools/whisper/<build>/                           pinned whisper.cpp binary (T23)
 * <root>/tools/whisper/models/<file>                      pinned ggml models (T23)
 * <root>/tools/whisper/overrides.yaml                     operator-supplied paths (T23)
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
  /** `<root>/state/locks`: per-session job lock files (T07). */
  readonly locksDir: string;
  readonly toolsDir: string;
  /** `<root>/tools/whisper` (T23). */
  readonly whisperDir: string;
  /** `<root>/tools/whisper/models` (T23). */
  readonly whisperModelsDir: string;
  /** `<root>/tools/whisper/overrides.yaml`: operator-supplied binary and model paths (T23). */
  readonly whisperOverridesFile: string;
  readonly logsDir: string;
  /** `<root>/campaigns/<campaign_id>`; throws `PATHS_INVALID_ID` for a non-slug. */
  campaignDir(campaignId: string): string;
  /** `<root>/campaigns/<campaign_id>/campaign.yaml`: the campaign config (T04). */
  campaignConfigFile(campaignId: string): string;
  /** `<root>/campaigns/<campaign_id>/sessions`. */
  sessionsDir(campaignId: string): string;
  /** Session package directory `<root>/campaigns/<campaign_id>/sessions/<session_id>`. */
  sessionDir(campaignId: string, sessionId: string): string;
  /** `<root>/state/locks/<campaign_id>/<session_id>.lock` (T07); throws for a non-slug. */
  sessionLockFile(campaignId: string, sessionId: string): string;
  /** `<root>/tools/whisper/<buildDir>` (T23); throws `PATHS_INVALID_ID` unless one path segment. */
  whisperBuildDir(buildDir: string): string;
  /** `<root>/tools/whisper/models/<file>` (T23); throws `PATHS_INVALID_ID` unless one path segment. */
  whisperModelFile(file: string): string;
}

const TOOL_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertToolSegment(value: string): string {
  if (!TOOL_SEGMENT.test(value) || value.endsWith('.')) {
    throw new PathsError('PATHS_INVALID_ID', 'tool file names must be a single path segment');
  }
  return value;
}

/** Builds the layout for an absolute data root. Does not touch the filesystem. */
export function createDataPaths(root: string): DataPaths {
  const base = path.resolve(root);
  const campaignsDir = path.join(base, 'campaigns');
  const stateDir = path.join(base, 'state');
  const toolsDir = path.join(base, 'tools');
  const whisperDir = path.join(toolsDir, 'whisper');
  const whisperModelsDir = path.join(whisperDir, 'models');

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
    locksDir: path.join(stateDir, 'locks'),
    toolsDir,
    whisperDir,
    whisperModelsDir,
    whisperOverridesFile: path.join(whisperDir, 'overrides.yaml'),
    logsDir: path.join(base, 'logs'),
    campaignDir,
    campaignConfigFile: (campaignId: string): string =>
      path.join(campaignDir(campaignId), CAMPAIGN_CONFIG_FILE_NAME),
    sessionsDir,
    sessionDir: (campaignId: string, sessionId: string): string =>
      path.join(sessionsDir(campaignId), assertSlug('session_id', sessionId)),
    sessionLockFile: (campaignId: string, sessionId: string): string =>
      path.join(
        stateDir,
        'locks',
        assertSlug('campaign_id', campaignId),
        `${assertSlug('session_id', sessionId)}.lock`,
      ),
    whisperBuildDir: (buildDir: string): string =>
      path.join(whisperDir, assertToolSegment(buildDir)),
    whisperModelFile: (file: string): string =>
      path.join(whisperModelsDir, assertToolSegment(file)),
  });
}
