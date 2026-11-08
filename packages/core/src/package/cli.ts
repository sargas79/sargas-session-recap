/**
 * `recap package validate|seal|purge-audio` (T03).
 *
 * The package operations are loaded lazily inside each action, so `recap --help` and
 * `recap doctor` do not load the contract validators.
 */
import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import { createLogger, type Logger } from '../log/index.ts';
import type { PackageIssue } from './issues.ts';
import type { PurgeReason } from './lifecycle.ts';
import type { PackageReport } from './validate.ts';

export interface PackageCliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

export interface PackageCliDeps {
  /**
   * Asks the operator a yes/no question. Defaults to a prompt on stdin; refuses (returns false)
   * when stdin is not a terminal, so scripts must pass `--yes`.
   */
  readonly confirm?: (question: string) => Promise<boolean>;
  /** Receives the one-line audit record of seal and purge (allowlisted fields only). */
  readonly logger?: Logger;
}

async function promptOnStdin(question: string, io: PackageCliIo): Promise<boolean> {
  // `isTTY` is undefined at runtime when stdin is a pipe or file, despite its declared type.
  if (!process.stdin.isTTY) {
    io.err('recap: no terminal to confirm on; pass --yes to purge non-interactively\n');
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit] ?? 'TiB'}`;
}

async function printIssues(io: PackageCliIo, issues: readonly PackageIssue[]): Promise<void> {
  const { formatIssue } = await import('./issues.ts');
  for (const issue of issues) io.out(`  ${formatIssue(issue)}\n`);
}

async function printReport(io: PackageCliIo, report: PackageReport): Promise<void> {
  io.out(`${report.root}\n  state: ${report.state}\n`);
  await printIssues(io, report.issues);
}

function reportJson(report: PackageReport): string {
  return `${JSON.stringify(
    {
      root: report.root,
      state: report.state,
      ok: report.ok,
      lifecycle: report.lifecycle ?? null,
      issues: report.issues,
    },
    null,
    2,
  )}\n`;
}

/** Prints a PackageError (or rethrows anything else) and sets a failing exit code. */
async function handleFailure(io: PackageCliIo, error: unknown): Promise<void> {
  const { PackageError } = await import('./issues.ts');
  if (error instanceof PackageError) {
    io.err(`recap: ${error.message}\n`);
    for (const issue of error.issues) {
      const { formatIssue } = await import('./issues.ts');
      io.err(`  ${formatIssue(issue)}\n`);
    }
    process.exitCode = 1;
    return;
  }
  throw error;
}

export function registerPackageCommands(
  program: Command,
  io: PackageCliIo,
  deps: PackageCliDeps = {},
): void {
  const confirm = deps.confirm ?? ((question: string) => promptOnStdin(question, io));
  const logger = deps.logger ?? createLogger();
  const pkg = program
    .command('package')
    .description('validate, seal and purge audio from a session package');

  pkg
    .command('validate')
    .description('validate a session package (manifest, records, paths, seal, purge)')
    .argument('<path>', 'package directory')
    .option('--json', 'print the report as JSON')
    .action(async (root: string, options: { json?: boolean }) => {
      const { validatePackage } = await import('./validate.ts');
      const report = await validatePackage(root);
      if (options.json === true) io.out(reportJson(report));
      else await printReport(io, report);
      if (!report.ok) process.exitCode = 1;
    });

  pkg
    .command('seal')
    .description('hash source artifacts into the manifest and move the package to `sealed`')
    .argument('<path>', 'package directory')
    .action(async (root: string) => {
      const { sealPackage } = await import('./lifecycle.ts');
      try {
        const result = await sealPackage(root, { logger });
        io.out(
          `sealed ${result.artifacts} artifacts (${formatBytes(result.bytes)})\n` +
            `${result.report.root}\n  state: ${result.report.state}\n`,
        );
        await printIssues(io, result.report.issues);
      } catch (error) {
        await handleFailure(io, error);
      }
    });

  pkg
    .command('purge-audio')
    .description('permanently delete the audio and record purge provenance (`audio-purged`)')
    .argument('<path>', 'package directory')
    .option('--yes', 'do not ask for confirmation')
    .option('--by <label>', 'operator label recorded as purged_by (default: OS user name)')
    .option(
      '--reason <reason>',
      'retention-policy | operator-request | consent-withdrawn',
      'operator-request',
    )
    .action(async (root: string, options: { yes?: boolean; by?: string; reason: string }) => {
      const { PURGE_REASONS, planAudioPurge, purgeAudio } = await import('./lifecycle.ts');
      try {
        if (!(PURGE_REASONS as readonly string[]).includes(options.reason)) {
          io.err(`recap: --reason must be one of ${PURGE_REASONS.join(', ')}\n`);
          process.exitCode = 2;
          return;
        }
        const plan = await planAudioPurge(root);
        if (options.yes !== true) {
          const ok = await confirm(
            `This permanently deletes ${plan.files.length} audio file(s) ` +
              `(${formatBytes(plan.bytes)}) from ${root}. It cannot be undone.`,
          );
          if (!ok) {
            io.err('recap: purge cancelled; nothing was changed\n');
            process.exitCode = 1;
            return;
          }
        }
        const result = await purgeAudio(root, {
          purgedBy: options.by,
          reason: options.reason as PurgeReason,
          logger,
        });
        io.out(
          `deleted ${result.deleted} audio file(s) (${formatBytes(result.bytes)})\n` +
            `${result.report.root}\n  state: ${result.report.state}\n`,
        );
        await printIssues(io, result.report.issues);
      } catch (error) {
        await handleFailure(io, error);
      }
    });
}
