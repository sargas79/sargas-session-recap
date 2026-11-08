/**
 * Child-process harness for the job tests: the real `recap run` / `recap status` commands with
 * synthetic stages (no real stage logic exists before T08). Run with Node's type stripping:
 *
 *   node worker.ts <workdir> run classify --campaign c --session s --data-root <dir>
 *
 * WORKER_MODE controls the `transcribe` stage:
 * - `ok`: returns at once;
 * - `hang`: writes `<workdir>/started` and never returns (the test kills the process);
 * - `gate`: writes `<workdir>/started` and returns once `<workdir>/release` exists.
 *
 * Every stage call is appended to `<workdir>/calls.log`. Only imports modules that do not need a
 * contracts build, so it runs straight from `src/`.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { registerJobCommands } from '../../src/jobs/cli.ts';
import { defineStages } from '../../src/jobs/stage.ts';
import { createLogger } from '../../src/log/index.ts';

const [workdir, ...args] = process.argv.slice(2);
if (workdir === undefined) throw new Error('usage: worker.ts <workdir> <recap args...>');
const mode = process.env['WORKER_MODE'] ?? 'ok';

const sha = (text: string): string => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const called = (stage: string): void => {
  appendFileSync(path.join(workdir, 'calls.log'), `${stage}\n`);
};

const stages = defineStages([
  {
    name: 'import',
    inputs: () => [{ kind: 'artifact', ref: 'audio/gm/0.flac', hash: sha('source') }],
    run: () => {
      called('import');
      return { outputs: [{ path: 'fragments.jsonl', hash: sha('fragments') }] };
    },
  },
  {
    name: 'transcribe',
    upstream: ['import'],
    run: async () => {
      called('transcribe');
      if (mode !== 'ok') {
        writeFileSync(path.join(workdir, 'started'), String(process.pid));
        await new Promise<void>((resolve) => {
          const timer = setInterval(() => {
            if (mode === 'gate' && existsSync(path.join(workdir, 'release'))) {
              clearInterval(timer);
              resolve();
            }
          }, 25);
        });
      }
      return { outputs: [{ path: 'transcript/segments.jsonl', hash: sha('segments') }] };
    },
  },
  {
    name: 'classify',
    upstream: ['transcribe'],
    inputs: () => [{ kind: 'prompt', ref: 'classification.window@v1', hash: sha('prompt') }],
    run: () => {
      called('classify');
      return { outputs: [{ path: 'classify/results.jsonl', hash: sha('results') }] };
    },
  },
]);

const program = new Command().name('recap').exitOverride();
const io = {
  out: (text: string) => process.stdout.write(text),
  err: (text: string) => process.stderr.write(text),
};
program.configureOutput({ writeOut: io.out, writeErr: io.err });
registerJobCommands(program, io, {
  stages,
  logger: createLogger({ level: 'error' }),
});
await program.parseAsync(args, { from: 'user' });
