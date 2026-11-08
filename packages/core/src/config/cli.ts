/**
 * `recap config ...` commands. The config modules are loaded inside each action so `recap --help`
 * stays fast and does not load contracts.
 */
import type { Command } from 'commander';

export interface ConfigCliIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

const SWITCH = { on: 'records', off: 'implied' } as const;

function describe(mode: 'records' | 'implied'): string {
  return mode === 'records'
    ? 'on (records): every speaker needs dated consent records'
    : 'off (implied): attending the session is consent; only listed speakers are processed';
}

export function registerConfigCommands(program: Command, io: ConfigCliIo): void {
  const config = program.command('config').description('campaign configuration');

  config
    .command('consent')
    .description('turn consent record checks on or off for a campaign, or show the current setting')
    .argument('<state>', '`on`, `off` or `status`')
    .argument('<campaign>', 'path to campaign.yaml')
    .action(async (state: string, file: string) => {
      const { isConfigError } = await import('./errors.ts');
      try {
        if (state === 'status') {
          const { readConsentMode } = await import('./consent-mode.ts');
          io.out(`consent: ${describe(await readConsentMode(file))}\n`);
          return;
        }
        if (state !== 'on' && state !== 'off') {
          io.err('recap: unknown consent state; use on, off or status\n');
          process.exitCode = 2;
          return;
        }
        const { setConsentMode } = await import('./consent-mode.ts');
        const result = await setConsentMode(file, SWITCH[state]);
        io.out(
          result.changed
            ? `consent: ${describe(result.mode)} (was ${result.previous})\n`
            : `consent: already ${describe(result.mode)}\n`,
        );
      } catch (error) {
        if (isConfigError(error)) {
          io.err(`recap: ${error.message}\n`);
          process.exitCode = 1;
          return;
        }
        throw error;
      }
    });
}
