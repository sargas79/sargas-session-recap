/**
 * `recap setup whisper` (T23). The tools modules load inside the action so `recap --help` stays
 * fast. There is deliberately no `--yes`: a download always needs a person at a terminal.
 */
import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import type { ToolsLock } from '@sargas-recap/contracts';
import type { PlannedDownload, SetupResult } from './setup.ts';

export interface SetupCliIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

/** A terminal-like stdin: what {@link confirmOnTerminal} needs. */
export interface ConfirmInput extends NodeJS.ReadableStream {
  readonly isTTY?: boolean | undefined;
}

export interface SetupCliDeps {
  readonly lockFile?: string | undefined;
  readonly confirm?: ((downloads: readonly PlannedDownload[]) => Promise<boolean>) | undefined;
  readonly fetch?: typeof fetch | undefined;
}

/** Asks on the terminal; default No. Without a terminal the answer is No: nothing can consent. */
export async function confirmOnTerminal(
  io: SetupCliIo,
  input: ConfirmInput = process.stdin,
): Promise<boolean> {
  if (input.isTTY !== true) {
    io.err('recap: confirmation needs an interactive terminal; nothing was downloaded\n');
    return false;
  }
  const prompt = createInterface({ input, output: process.stderr });
  try {
    const answer = await prompt.question('Download these files? [y/N] ');
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

function describeDownloads(
  downloads: readonly PlannedDownload[],
  formatBytes: (bytes: number) => string,
): string {
  const lines = ['recap will download:'];
  for (const item of downloads) {
    lines.push(`  ${item.fileName}  (${formatBytes(item.bytes)}, ${String(item.bytes)} bytes)`);
    lines.push(`    source: ${item.url}`);
    lines.push(`    into:   ${item.dest}`);
    lines.push(`    sha256: ${item.sha256}`);
    if (item.replaces) {
      lines.push('    note:   replaces the file at that path, which failed its hash check');
    }
  }
  return `${lines.join('\n')}\n`;
}

function reportResult(result: SetupResult, lock: ToolsLock, io: SetupCliIo): void {
  const { model, binary } = result.inspection;
  if (result.status === 'declined') {
    io.out('nothing was downloaded\n');
    process.exitCode = 1;
    return;
  }
  io.out(`model:  ok ${model.id} (${model.path})\n`);
  if (result.status === 'ready') {
    io.out(
      binary.state === 'ok'
        ? `binary: ok ${lock.whisper.version} (${binary.executable ?? ''})\n`
        : `binary: the lock pins none for this platform; set binary_path in overrides.yaml\n`,
    );
    return;
  }
  const pin = lock.whisper.binary;
  const flags = pin.source === 'local-build' ? pin.build.flags.join(' ') : '';
  io.err(
    [
      `recap: whisper binary is ${binary.state}; this lock pins a locally built binary`,
      `  manual step: build whisper.cpp ${lock.whisper.version} (commit ${lock.whisper.commit})`,
      `  with ${flags} as described in docs/setup-windows.md, then run:`,
      '  recap setup whisper --from-build <build dir>\\bin\\Release',
      '',
    ].join('\n'),
  );
  process.exitCode = 1;
}

export function registerSetupCommands(
  program: Command,
  io: SetupCliIo,
  deps: SetupCliDeps = {},
): void {
  const setup = program.command('setup').description('install external tools');

  setup
    .command('whisper')
    .description('install the pinned whisper.cpp binary and model into the data root')
    .option('--data-root <dir>', 'data root (default: RECAP_DATA_ROOT, config, per-user dir)')
    .option('--allow-in-repo', 'accept a data root inside a git working tree')
    .option('--from-build <dir>', 'adopt a locally built binary from this directory')
    .action(async (options: { dataRoot?: string; allowInRepo?: boolean; fromBuild?: string }) => {
      const { formatBytes, openDataRoot, PathsError } = await import('../paths/index.ts');
      const { loadToolsLock, defaultToolsLockFile, runWhisperSetup, isToolsError } =
        await import('./index.ts');
      try {
        const lock = await loadToolsLock(deps.lockFile ?? defaultToolsLockFile());
        const { paths } = openDataRoot({
          flag: options.dataRoot,
          allowInRepo: options.allowInRepo,
        });
        let nextPercent = 10;
        const result = await runWhisperSetup({
          lock,
          paths,
          fromBuild: options.fromBuild,
          fetch: deps.fetch,
          onStep: (message) => {
            io.out(`${message}\n`);
          },
          onProgress: (received, total) => {
            const percent = Math.floor((received / total) * 100);
            if (percent >= nextPercent) {
              io.err(`  ${String(percent)}%\n`);
              nextPercent = percent + 10 - (percent % 10);
            }
          },
          confirm: async (downloads) => {
            io.out(describeDownloads(downloads, formatBytes));
            nextPercent = 10;
            return deps.confirm === undefined ? confirmOnTerminal(io) : deps.confirm(downloads);
          },
        });
        reportResult(result, lock, io);
      } catch (error) {
        if (isToolsError(error) || error instanceof PathsError) {
          io.err(`recap: ${error.message} [${error.code}]\n`);
          if (error.hint !== undefined) io.err(`  ${error.hint}\n`);
          process.exitCode = 1;
          return;
        }
        throw error;
      }
    });
}
