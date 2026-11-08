/**
 * `recap import <dir> --campaign <id> --session <id>` (T05).
 *
 * The import code is loaded inside the action, so `recap --help` stays fast.
 */
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import { createLogger, type Logger } from '../log/index.ts';
import type { ExclusionReason, ImportResult, TrackProbe } from './import.ts';

export interface ImportCliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

export interface ImportCliDeps {
  /** Recorded as `manifest.source.tool_version`. */
  readonly toolVersion: string;
  /**
   * Asks the operator a yes/no question before replacing a package. Defaults to a prompt on stdin;
   * refuses (returns false) when stdin is not a terminal, so scripts must pass `--yes`.
   */
  readonly confirm?: (question: string) => Promise<boolean>;
  /** Receives allowlisted log records (IDs, counts, codes; never file names or contents). */
  readonly logger?: Logger;
  /** Track probe override (tests). */
  readonly probe?: TrackProbe;
}

interface ImportCliOptions {
  readonly campaign: string;
  readonly session: string;
  readonly mapping?: string;
  readonly config?: string;
  readonly dataRoot?: string;
  readonly allowInRepo?: boolean;
  readonly replace?: boolean;
  readonly yes?: boolean;
}

const REASON_TEXT: Readonly<Record<ExclusionReason, string>> = {
  unmapped: 'not in the track mapping',
  'unknown-speaker': 'speaker is not listed in campaign.yaml',
  'no-record': 'no recording consent record for this provider',
  withdrawn: 'recording consent was withdrawn',
  'not-yet-granted': 'recording consent starts later',
  'no-recording-consent': 'no active recording consent',
};

async function promptOnStdin(question: string, io: ImportCliIo): Promise<boolean> {
  // `isTTY` is undefined at runtime when stdin is a pipe or file, despite its declared type.
  if (!process.stdin.isTTY) {
    io.err('recap: no terminal to confirm on; pass --yes to replace non-interactively\n');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${question} Type "yes" to continue: `);
    return answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

function formatResult(result: ImportResult): string {
  const lines = [
    `imported ${String(result.imported.length)} track(s) into ${result.packageDir}`,
    ...result.imported.map(
      (t) =>
        `  ${t.fragmentId.padEnd(20)} ${t.path}  start ${String(t.startOffsetMs)} ms  ` +
        `duration ${String(t.durationMs)} ms  (from ${t.file})`,
    ),
  ];
  if (result.excluded.length > 0) {
    lines.push(`excluded ${String(result.excluded.length)} file(s):`);
    for (const e of result.excluded) {
      const who = e.speakerId === undefined ? '' : ` (${e.speakerId})`;
      lines.push(`  ${e.file}${who}: ${REASON_TEXT[e.reason]}`);
    }
  }
  const c = result.consent;
  lines.push(
    `consent: ${c.stage} with ${c.provider}, mode ${c.mode}, policy ${c.policy_hash}`,
    `  package: ${result.packageId}${result.replaced ? ' (replaced the previous package)' : ''}`,
    `  state:   ${result.report.state}`,
  );
  return `${lines.join('\n')}\n`;
}

/** Turns known errors into an operator message and exit code 1; rethrows anything else. */
async function handleFailure(io: ImportCliIo, logger: Logger, error: unknown): Promise<void> {
  const [{ isImportError }, { isConfigError, isConsentError }, { PathsError }, { PackageError }] =
    await Promise.all([
      import('./errors.ts'),
      import('../config/index.ts'),
      import('../paths/index.ts'),
      import('../package/index.ts'),
    ]);
  const { isAudioToolError } = await import('../audio/index.ts');
  let message: string | undefined;
  let code: string | undefined;
  if (isImportError(error) || isAudioToolError(error)) {
    message = error.toUserMessage();
    code = error.code;
  } else if (isConfigError(error) || isConsentError(error)) {
    message = error.message;
    code = error.code;
  } else if (error instanceof PathsError) {
    message = error.hint === undefined ? error.message : `${error.message}\n  fix: ${error.hint}`;
    code = error.code;
  } else if (error instanceof PackageError) {
    const { formatIssue } = await import('../package/index.ts');
    message = [error.message, ...error.issues.map((i) => `  ${formatIssue(i)}`)].join('\n');
    code = error.code;
  }
  if (message === undefined || code === undefined) throw error;
  logger.error('import.failed', { command: 'import', errorCode: code });
  io.err(`recap: ${message}\n`);
  process.exitCode = 1;
}

export function registerImportCommands(
  program: Command,
  io: ImportCliIo,
  deps: ImportCliDeps,
): void {
  const confirm = deps.confirm ?? ((question: string) => promptOnStdin(question, io));
  const logger = deps.logger ?? createLogger();

  program
    .command('import')
    .description('import a multitrack recording (one file per speaker) as a sealed session package')
    .argument('<dir>', 'folder with the tracks and recap-tracks.yaml')
    .requiredOption('--campaign <id>', 'campaign id (campaign.yaml campaign_id)')
    .requiredOption('--session <id>', 'session id, e.g. s07')
    .option('--mapping <file>', 'track mapping (default: recap-tracks.yaml|.yml|.json in <dir>)')
    .option('--config <file>', 'campaign.yaml (default: <data root>/campaigns/<id>/campaign.yaml)')
    .option(
      '--data-root <dir>',
      'data root (default: RECAP_DATA_ROOT, config, per-user dir; see `recap doctor`)',
    )
    .option('--allow-in-repo', 'accept a data root inside a git working tree')
    .option('--replace', 'replace an existing package of this session that was not processed yet')
    .option('--yes', 'do not ask before replacing')
    .action(async (dir: string, options: ImportCliOptions) => {
      try {
        const { openDataRoot } = await import('../paths/index.ts');
        const { paths } = openDataRoot({
          flag: options.dataRoot,
          allowInRepo: options.allowInRepo,
        });
        const sessionDir = paths.sessionDir(options.campaign, options.session);
        if (options.replace === true && options.yes !== true && existsSync(sessionDir)) {
          const ok = await confirm(
            `This replaces the existing package of session ${options.session} at ${sessionDir}, ` +
              'including its audio copies. The original tracks are not touched.',
          );
          if (!ok) {
            io.err('recap: import cancelled; nothing was changed\n');
            process.exitCode = 1;
            return;
          }
        }
        const { importRecording } = await import('./import.ts');
        const result = await importRecording({
          dir,
          campaignId: options.campaign,
          sessionId: options.session,
          paths,
          mappingFile: options.mapping,
          campaignFile: options.config,
          replace: options.replace,
          toolVersion: deps.toolVersion,
          probe: deps.probe,
          logger,
        });
        io.out(formatResult(result));
      } catch (error) {
        await handleFailure(io, logger, error);
      }
    });
}
