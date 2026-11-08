/**
 * `recap retranscribe` (T09): the explicit way to apply a changed ASR glossary. `recap run` never
 * does this on its own, because a new transcription run has new segment IDs and sends the GM's
 * overrides to reconciliation (ADR-005). The previous run stays as it was (ADR-004).
 */
import type { Command } from 'commander';
import { printReport, reportError, type JobCliIo } from '../jobs/cli.ts';
import type { RunOptions, RunReport } from '../jobs/runner.ts';
import type { RunConfig, StageRegistry } from '../jobs/stage.ts';
import { JobError } from '../jobs/errors.ts';
import { latestJob } from '../jobs/store.ts';
import type { Logger } from '../log/index.ts';
import { ASR_GLOSSARY_RECEIPT } from './transcribe-stage.ts';

export interface RetranscribeOptions extends Omit<RunOptions, 'stage' | 'force' | 'config'> {
  readonly config: RunConfig;
}

export type RetranscribeResult =
  | { readonly status: 'unchanged'; readonly transcriptionRunId: string | undefined }
  | {
      readonly status: 'ran';
      readonly report: RunReport;
      readonly previousRunId: string | undefined;
    };

/**
 * Runs transcription again if the ASR glossary differs from the one the current run used. With no
 * current run it is an ordinary first run. A repeat with the same glossary would produce the
 * same text under new IDs, so it does nothing.
 */
export async function retranscribe(options: RetranscribeOptions): Promise<RetranscribeResult> {
  const { runStage } = await import('../jobs/runner.ts');
  const current = latestJob(
    options.db,
    options.campaignId,
    options.sessionId,
    'transcribe',
    'succeeded',
  );
  const used = current?.inputs.find(
    (input) =>
      input.role === 'receipt' &&
      input.kind === ASR_GLOSSARY_RECEIPT.kind &&
      input.ref === ASR_GLOSSARY_RECEIPT.ref,
  );
  if (used?.hash === options.config.version.stage_hashes.asr) {
    return { status: 'unchanged', transcriptionRunId: current?.outputRunId };
  }
  const report = await runStage({ ...options, stage: 'transcribe', force: true });
  return { status: 'ran', report, previousRunId: current?.outputRunId };
}

interface RetranscribeCliOptions {
  campaign: string;
  session: string;
  config: string;
  glossary: string;
  dataRoot?: string;
  allowInRepo?: boolean;
}

export interface RetranscribeCliDeps {
  readonly stages: StageRegistry;
  readonly logger?: Logger | undefined;
}

export function registerRetranscribeCommand(
  program: Command,
  io: JobCliIo,
  deps: RetranscribeCliDeps,
): void {
  program
    .command('retranscribe')
    .description('transcribe a session again with the current ASR glossary; the old run is kept')
    .requiredOption('--campaign <id>', 'campaign id (slug)')
    .requiredOption('--session <id>', 'session id (slug)')
    .requiredOption('--config <campaign.yaml>', 'campaign config')
    .requiredOption('--glossary <glossary.yaml>', 'glossary')
    .option('--data-root <dir>', 'data root (default: RECAP_DATA_ROOT, then the per-user dir)')
    .option('--allow-in-repo', 'accept a data root inside a git working tree')
    .action(async (options: RetranscribeCliOptions) => {
      try {
        const { assertSlug, openDataRoot } = await import('../paths/index.ts');
        const { openStateDatabase } = await import('../db/index.ts');
        const { configVersion, loadCampaignConfig, loadGlossary } =
          await import('../config/index.ts');
        assertSlug('campaign_id', options.campaign);
        assertSlug('session_id', options.session);
        const campaign = (await loadCampaignConfig(options.config)).value;
        const glossary = (await loadGlossary(options.glossary)).value;
        if (campaign.campaign_id !== options.campaign) {
          throw new JobError(
            'JOB_CONFIG_REQUIRED',
            `--config is for campaign ${campaign.campaign_id}, not ${options.campaign}`,
          );
        }
        const { paths } = openDataRoot({
          flag: options.dataRoot,
          allowInRepo: options.allowInRepo,
        });
        const { db } = await openStateDatabase(paths, { logger: deps.logger });
        const controller = new AbortController();
        const onSigint = (): void => {
          io.err('recap: cancelling; the running job will be marked cancelled\n');
          controller.abort();
        };
        process.once('SIGINT', onSigint);
        try {
          const result = await retranscribe({
            db,
            campaignId: options.campaign,
            sessionId: options.session,
            stages: deps.stages,
            paths,
            config: { campaign, glossary, version: configVersion(campaign, glossary) },
            signal: controller.signal,
            logger: deps.logger,
          });
          if (result.status === 'unchanged') {
            io.out(
              `nothing to do: run ${result.transcriptionRunId ?? '(unknown)'} already used this ASR glossary\n`,
            );
            return;
          }
          printReport(io, result.report);
          if (result.report.status === 'succeeded' && result.previousRunId !== undefined) {
            io.out(
              `previous run ${result.previousRunId} is unchanged and still used the old glossary\n`,
            );
          }
          if (result.report.status === 'failed') process.exitCode = 1;
          if (result.report.status === 'cancelled') process.exitCode = 130;
        } finally {
          process.off('SIGINT', onSigint);
          db.close();
        }
      } catch (error) {
        await reportError(io, error);
      }
    });
}
