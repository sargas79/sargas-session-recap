import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import {
  checkAudioToolchain,
  formatAudioToolCheck,
  type AudioToolCheck,
  type AudioToolchainOptions,
} from '../audio/index.ts';
import { registerImportCommands } from '../capture/cli.ts';
import { registerConfigCommands } from '../config/cli.ts';
import { registerJobCommands } from '../jobs/cli.ts';
import { registerSecretsCommands } from '../llm/cli.ts';
import { registerPackageCommands } from '../package/cli.ts';
import { checkDataRoot, type DataRootCheck, type DataRootCheckOptions } from '../paths/index.ts';

/** Output channel, injectable so the program can be tested in-process. */
export interface CliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

const defaultIo: CliIo = {
  out: (text) => {
    process.stdout.write(text);
  },
  err: (text) => {
    process.stderr.write(text);
  },
};

/**
 * Reads the core package version. The relative path resolves to
 * `packages/core/package.json` from both `src/cli/` and `dist/cli/`.
 */
export function readVersion(): string {
  const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'version' in parsed &&
    typeof parsed.version === 'string'
  ) {
    return parsed.version;
  }
  return '0.0.0';
}

export interface DoctorResult {
  readonly lines: string[];
  /** True when every required external tool is present and supported. */
  readonly ok: boolean;
  readonly checks: readonly AudioToolCheck[];
  /** Data root, free disk space and DB schema version (T25). */
  readonly dataRoot: DataRootCheck;
}

export interface DoctorOptions extends AudioToolchainOptions {
  readonly dataRoot?: DataRootCheckOptions | undefined;
}

/**
 * Runs the `recap doctor` checks (Node, platform, ffmpeg, ffprobe, data root,
 * disk, DB). Never throws for a missing or broken tool: problems become report
 * lines with a fix. Never creates the data root or the database.
 */
export async function doctorReport(options: DoctorOptions = {}): Promise<DoctorResult> {
  const [checks, dataRoot] = await Promise.all([
    checkAudioToolchain(options),
    checkDataRoot(options.dataRoot),
  ]);
  const ok = checks.every((check) => check.ok) && dataRoot.ok;
  const lines = [
    'recap doctor',
    `  node:     ${process.version}`,
    `  platform: ${process.platform} ${process.arch}`,
    ...checks.flatMap(formatAudioToolCheck),
    ...dataRoot.lines,
    ok ? '  result:   ok' : '  result:   problems found (`recap doctor --strict` exits non-zero)',
  ];
  return { lines, ok, checks, dataRoot };
}

export function buildProgram(io: CliIo = defaultIo): Command {
  const program = new Command();

  program
    .name('recap')
    .description(
      'Session Recap Bot: local PF2e session audio -> transcript -> classification -> recap -> Foundry journal.',
    )
    .version(readVersion(), '-v, --version', 'print the recap version')
    .configureOutput({
      writeOut: io.out,
      writeErr: io.err,
    })
    .showHelpAfterError();

  program
    .command('doctor')
    .description('check the local environment (Node, ffmpeg, ffprobe, data root, database)')
    .option('--strict', 'exit with code 1 when a check fails')
    .option(
      '--data-root <dir>',
      'data root to check (default: RECAP_DATA_ROOT, config, per-user dir)',
    )
    .option('--allow-in-repo', 'accept a data root inside a git working tree')
    .action(async (options: { strict?: boolean; dataRoot?: string; allowInRepo?: boolean }) => {
      const report = await doctorReport({
        dataRoot: { flag: options.dataRoot, allowInRepo: options.allowInRepo },
      });
      io.out(`${report.lines.join('\n')}\n`);
      // Plain `doctor` stays informational (exit 0) so it can run anywhere;
      // `--strict` turns problems into a failing exit code for scripts.
      if (!report.ok && options.strict === true) {
        process.exitCode = 1;
      }
    });

  registerImportCommands(program, io, { toolVersion: readVersion() });
  registerPackageCommands(program, io);
  registerConfigCommands(program, io);
  registerJobCommands(program, io);
  registerSecretsCommands(program, io);

  return program;
}
