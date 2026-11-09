/**
 * Regenerates the recap from the corrected state (T14) through the job runner, exactly as
 * `recap run recap` does: same stages, same consent check, same session lock. It runs in the
 * background because a provider call can take minutes.
 */
import { isJobError } from '../jobs/errors.ts';
import { runStage } from '../jobs/runner.ts';
import type { RunConfig, StageRegistry } from '../jobs/stage.ts';
import { latestJob } from '../jobs/store.ts';
import type { Logger } from '../log/index.ts';
import type { SessionRef } from '../review/session.ts';
import { ReviewUiError } from './errors.ts';

export type RegenerationStatus =
  'idle' | 'running' | 'succeeded' | 'up-to-date' | 'failed' | 'cancelled';

export interface RegenerationState {
  readonly status: RegenerationStatus;
  readonly revision?: number | undefined;
  readonly errorCode?: string | undefined;
  /** IDs, counts and fixes only, as `recap run` prints them. Shown to the GM, never logged. */
  readonly message?: string | undefined;
}

export interface RegeneratorDeps {
  readonly ref: SessionRef;
  readonly stages?: StageRegistry | undefined;
  readonly loadConfig?: (() => Promise<RunConfig>) | undefined;
  readonly logger?: Logger | undefined;
}

export interface Regenerator {
  available(): boolean;
  state(): RegenerationState;
  start(): void;
  /** Cancels a running generation and waits for it. */
  close(): Promise<void>;
}

/** Errors whose text `recap run` already shows the GM. */
function presentable(error: unknown): { code: string; message: string } | undefined {
  if (isJobError(error)) return { code: error.code, message: error.message };
  if (error instanceof ReviewUiError) return { code: error.code, message: error.message };
  if (error instanceof Error && (error.name === 'ConfigError' || error.name === 'ConsentError')) {
    return { code: error.name, message: error.message };
  }
  return undefined;
}

export function createRegenerator(deps: RegeneratorDeps): Regenerator {
  const { ref, stages, loadConfig, logger } = deps;
  let state: RegenerationState = { status: 'idle' };
  let running: Promise<void> | undefined;
  let controller: AbortController | undefined;

  const run = async (registry: StageRegistry, load: () => Promise<RunConfig>): Promise<void> => {
    const abort = new AbortController();
    controller = abort;
    try {
      const report = await runStage({
        db: ref.db,
        campaignId: ref.campaignId,
        sessionId: ref.sessionId,
        stage: 'recap',
        stages: registry,
        paths: ref.paths,
        config: await load(),
        signal: abort.signal,
        logger,
      });
      const failed = report.stages.find((outcome) => outcome.action === 'failed');
      const recap = report.stages.find((outcome) => outcome.stage === 'recap');
      if (report.status === 'failed') {
        state = {
          status: 'failed',
          errorCode: failed?.error?.code ?? 'failed',
          message: failed?.error?.message ?? 'the run failed',
        };
      } else if (report.status === 'cancelled') {
        state = { status: 'cancelled' };
      } else if (recap?.action === 'up-to-date') {
        state = { status: 'up-to-date' };
      } else {
        const job = latestJob(ref.db, ref.campaignId, ref.sessionId, 'recap', 'succeeded');
        state = { status: 'succeeded', revision: job?.outputRecapRevision };
      }
    } catch (error) {
      const shown = presentable(error);
      logger?.error('review-ui.regeneration-failed', {
        errorCode: shown?.code ?? (error instanceof Error ? error.name : 'unknown'),
      });
      state = {
        status: 'failed',
        errorCode: shown?.code ?? 'unexpected',
        message: shown?.message ?? 'generation stopped on an unexpected error; see the terminal',
      };
    } finally {
      controller = undefined;
    }
  };

  return {
    available: () => stages !== undefined && loadConfig !== undefined,
    state: () => state,
    start: () => {
      if (stages === undefined || loadConfig === undefined) {
        throw new ReviewUiError(
          409,
          'REVIEW_UI_NO_CONFIG',
          'this review server was started without --config and --glossary',
          'restart `recap review` with both, or use `recap run recap`',
        );
      }
      if (state.status === 'running') {
        throw new ReviewUiError(409, 'REVIEW_UI_BUSY', 'a recap generation is already running');
      }
      state = { status: 'running' };
      running = run(stages, loadConfig).finally(() => {
        running = undefined;
      });
    },
    close: async () => {
      controller?.abort();
      await running;
    },
  };
}
