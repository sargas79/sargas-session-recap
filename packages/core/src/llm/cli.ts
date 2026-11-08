/**
 * `recap secrets ...`: stores the Claude API key in the OS credential store. The key is read from a
 * hidden prompt (or piped stdin) and never echoed. The native module loads inside the action, so
 * `recap --help` stays fast.
 */
import { createInterface } from 'node:readline';
import type { Command } from 'commander';
import type { SecretStore } from './secrets.ts';

export interface SecretsCliIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

export interface SecretsCliDeps {
  readonly openStore?: (() => Promise<SecretStore>) | undefined;
  readonly readSecret?: ((io: SecretsCliIo) => Promise<string>) | undefined;
}

function readPiped(): Promise<string> {
  return new Promise((resolve) => {
    const lines = createInterface({ input: process.stdin });
    let first = '';
    lines.once('line', (line) => {
      first = line;
      lines.close();
    });
    lines.once('close', () => {
      resolve(first);
    });
  });
}

/** Reads one line from the terminal in raw mode, so typed characters are not shown. */
function readHidden(io: SecretsCliIo): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return readPiped();
  io.err('Anthropic API key (input hidden): ');
  return new Promise((resolve) => {
    let value = '';
    const finish = (): void => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      io.err('\n');
      resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') {
          finish();
          return;
        }
        if (char === '\u0003') {
          value = '';
          finish();
          return;
        }
        if (char === '\u0008' || char === '\u007f') value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function defaultOpenStore(): Promise<SecretStore> {
  const { openOsSecretStore } = await import('./secrets.ts');
  return openOsSecretStore();
}

export function registerSecretsCommands(
  program: Command,
  io: SecretsCliIo,
  deps: SecretsCliDeps = {},
): void {
  const openStore = deps.openStore ?? defaultOpenStore;
  const secrets = program.command('secrets').description('API keys in the OS credential store');
  const known = (name: string): boolean => {
    if (name === 'anthropic') return true;
    io.err('recap: unknown secret; the only one is `anthropic`\n');
    process.exitCode = 2;
    return false;
  };

  secrets
    .command('set')
    .description('store an API key, read from a hidden prompt or piped stdin')
    .argument('<name>', '`anthropic`')
    .action(async (name: string) => {
      if (!known(name)) return;
      const value = (await (deps.readSecret ?? readHidden)(io)).trim();
      if (value === '') {
        io.err('recap: no key given; nothing stored\n');
        process.exitCode = 1;
        return;
      }
      const store = await openStore();
      store.set(value);
      io.out('stored the anthropic key in the OS credential store\n');
    });

  secrets
    .command('delete')
    .description('remove a stored API key')
    .argument('<name>', '`anthropic`')
    .action(async (name: string) => {
      if (!known(name)) return;
      const store = await openStore();
      io.out(store.delete() ? 'removed the anthropic key\n' : 'no anthropic key was stored\n');
    });
}
