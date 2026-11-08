import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import {
  checkAudioToolchain,
  formatAudioToolCheck,
  type AudioToolCheck,
  type AudioToolchainOptions,
} from '../audio/index.ts';
import { registerPackageCommands } from '../package/cli.ts';

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
}

/**
 * Runs the `recap doctor` checks (Node, platform, ffmpeg, ffprobe). Never
 * throws for a missing or broken tool: problems become report lines with a fix.
 */
export async function doctorReport(options: AudioToolchainOptions = {}): Promise<DoctorResult> {
  const checks = await checkAudioToolchain(options);
  const ok = checks.every((check) => check.ok);
  const lines = [
    'recap doctor',
    `  node:     ${process.version}`,
    `  platform: ${process.platform} ${process.arch}`,
    ...checks.flatMap(formatAudioToolCheck),
    ok ? '  result:   ok' : '  result:   problems found (`recap doctor --strict` exits non-zero)',
  ];
  return { lines, ok, checks };
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
    .description('check the local environment (Node, ffmpeg, ffprobe)')
    .option('--strict', 'exit with code 1 when a check fails')
    .action(async (options: { strict?: boolean }) => {
      const report = await doctorReport();
      io.out(`${report.lines.join('\n')}\n`);
      // Plain `doctor` stays informational (exit 0) so it can run anywhere;
      // `--strict` turns problems into a failing exit code for scripts.
      if (!report.ok && options.strict === true) {
        process.exitCode = 1;
      }
    });

  registerPackageCommands(program, io);

  return program;
}
