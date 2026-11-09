/**
 * `recap review` (T14): serves the review screen for one session on 127.0.0.1 until Ctrl+C. The
 * launch URL goes to the GM's terminal and never to the logger.
 */
import type { Command } from 'commander';
import { reportError, type JobCliIo } from '../jobs/cli.ts';
import type { StageRegistry } from '../jobs/stage.ts';
import type { Logger } from '../log/index.ts';

export interface ReviewUiCliDeps {
  readonly stages?: StageRegistry | undefined;
  readonly logger?: Logger | undefined;
  /** Called once with a function that stops the server. Defaults to Ctrl+C. */
  readonly waitForStop?: ((url: string) => Promise<void>) | undefined;
}

interface ReviewOptions {
  campaign: string;
  session: string;
  dataRoot?: string;
  allowInRepo?: boolean;
  config?: string;
  glossary?: string;
  port?: string;
  reviewer?: string;
}

function untilInterrupted(): Promise<void> {
  return new Promise((resolve) => {
    process.once('SIGINT', () => {
      resolve();
    });
  });
}

export function registerReviewUiCommand(
  program: Command,
  io: JobCliIo,
  deps: ReviewUiCliDeps = {},
): void {
  program
    .command('review')
    .description('open the localhost review screen of one session; Ctrl+C stops it')
    .requiredOption('--campaign <id>', 'campaign id (slug)')
    .requiredOption('--session <id>', 'session id (slug)')
    .option('--data-root <dir>', 'data root (default: RECAP_DATA_ROOT, then the per-user dir)')
    .option('--allow-in-repo', 'accept a data root inside a git working tree')
    .option('--config <campaign.yaml>', 'campaign config, needed to regenerate the recap')
    .option('--glossary <glossary.yaml>', 'glossary, needed to regenerate the recap')
    .option('--port <n>', 'port on 127.0.0.1 (default: a free one)')
    .option('--reviewer <slug>', 'operator slug recorded on edits and approvals', 'gm')
    .action(async (options: ReviewOptions) => {
      try {
        const { assertSlug, openDataRoot } = await import('../paths/index.ts');
        const { openStateDatabase } = await import('../db/index.ts');
        const { JobError } = await import('../jobs/errors.ts');
        assertSlug('campaign_id', options.campaign);
        assertSlug('session_id', options.session);
        const { SLUG_PATTERN } = await import('@sargas-recap/contracts');
        if (options.reviewer !== undefined && !new RegExp(SLUG_PATTERN).test(options.reviewer)) {
          throw new JobError('JOB_INVALID_INPUT', '--reviewer must be a lowercase slug such as gm');
        }
        if ((options.config === undefined) !== (options.glossary === undefined)) {
          throw new JobError('JOB_CONFIG_REQUIRED', '--config and --glossary go together', {
            hint: 'pass both files, or neither',
          });
        }
        const port = options.port === undefined ? 0 : Number(options.port);
        if (!Number.isInteger(port) || port < 0 || port > 65_535) {
          io.err('recap: --port must be an integer from 0 to 65535\n');
          process.exitCode = 2;
          return;
        }
        const { paths } = openDataRoot({
          flag: options.dataRoot,
          allowInRepo: options.allowInRepo,
        });
        const { db } = await openStateDatabase(paths, { logger: deps.logger });
        const { startReviewServer } = await import('./server.ts');
        const configFile = options.config;
        const glossaryFile = options.glossary;
        const loadConfig =
          configFile === undefined || glossaryFile === undefined
            ? undefined
            : async () => {
                const { configVersion, loadCampaignConfig, loadGlossary } =
                  await import('../config/index.ts');
                const campaign = (await loadCampaignConfig(configFile)).value;
                const glossary = (await loadGlossary(glossaryFile)).value;
                return { campaign, glossary, version: configVersion(campaign, glossary) };
              };
        const server = await startReviewServer({
          ref: { db, paths, campaignId: options.campaign, sessionId: options.session },
          port,
          stages: deps.stages,
          loadConfig,
          logger: deps.logger,
          reviewer: options.reviewer,
        });
        try {
          io.out(`Review ${options.campaign}/${options.session} at:\n  ${server.launchUrl}\n`);
          io.out('Open that link in your browser. Ctrl+C stops the server.\n');
          await (deps.waitForStop ?? untilInterrupted)(server.launchUrl);
        } finally {
          await server.close();
          db.close();
        }
      } catch (error) {
        await reportError(io, error);
      }
    });
}
