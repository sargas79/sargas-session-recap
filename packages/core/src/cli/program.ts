import { readFileSync } from 'node:fs';
import { Command } from 'commander';

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

/** Lines printed by `recap doctor`. Environment checks are added by later tasks (e.g. T22 ffmpeg). */
export function doctorReport(): string[] {
  return [
    'recap doctor',
    `  node:     ${process.version}`,
    `  platform: ${process.platform} ${process.arch}`,
    '  checks:   no checks configured yet',
  ];
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
    .description('check the local environment (no checks are configured yet)')
    .action(() => {
      io.out(`${doctorReport().join('\n')}\n`);
    });

  return program;
}
