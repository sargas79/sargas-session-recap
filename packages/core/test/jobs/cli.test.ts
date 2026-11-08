import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateJobRecord } from '@sargas-recap/contracts';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli/program.ts';
import { registerJobCommands, type JobCliDeps, type StageRegistry } from '../../src/jobs/index.ts';
import { createLogger } from '../../src/log/index.ts';
import { newWorld, pipelineStages, type World } from './helpers.ts';

const CAMPAIGN_FILE = fileURLToPath(
  new URL('../../../../fixtures/config/campaign.yaml', import.meta.url),
);
const GLOSSARY_FILE = fileURLToPath(
  new URL('../../../../fixtures/config/glossary.yaml', import.meta.url),
);

let dir: string;
let world: World;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'recap-jobs-cli-'));
  world = newWorld();
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = undefined;
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function recap(
  args: readonly string[],
  deps: Partial<JobCliDeps> & { stages?: StageRegistry } = {},
): Promise<{ out: string; err: string; code: number | string | null | undefined }> {
  let out = '';
  let err = '';
  const io = {
    out: (t: string) => (out += t),
    err: (t: string) => (err += t),
  };
  const program = new Command().name('recap').exitOverride();
  program.configureOutput({ writeOut: io.out, writeErr: io.err });
  registerJobCommands(program, io, {
    stages: pipelineStages(world),
    logger: createLogger({ level: 'error', sink: () => undefined }),
    onInterrupt: () => () => undefined,
    ...deps,
  });
  await program.parseAsync([...args], { from: 'user' });
  const code = process.exitCode;
  process.exitCode = undefined;
  return { out, err, code };
}

const target = () => [
  '--campaign',
  'synthetic-vaults',
  '--session',
  's01',
  '--data-root',
  path.join(dir, 'data'),
];
const withConfig = () => [...target(), '--config', CAMPAIGN_FILE, '--glossary', GLOSSARY_FILE];

describe('recap run / recap status', () => {
  it('are registered on the main program', () => {
    const help = buildProgram({ out: () => undefined, err: () => undefined }).helpInformation();
    expect(help).toMatch(/^ {2}run \[options\] <stage>/m);
    expect(help).toMatch(/^ {2}status \[options\]/m);
  });

  it('status before any run does not create the database', async () => {
    const result = await recap(['status', ...target()]);
    expect(result.out).toBe('synthetic-vaults/s01: no jobs recorded yet\n');
    expect(existsSync(path.join(dir, 'data', 'state', 'recap.sqlite'))).toBe(false);
  });

  it('runs a pipeline, then reports it up to date, and status shows every stage', async () => {
    const first = await recap(['run', 'recap', ...withConfig()]);
    expect(first.err).toBe('');
    expect(first.code).toBeUndefined();
    expect(first.out).toMatch(/import: succeeded \(job \w{26}\), attempt 1\n/);
    expect(first.out).toContain('result: succeeded');

    const second = await recap(['run', 'recap', ...withConfig()]);
    expect(second.out.match(/up to date/g)).toHaveLength(4);

    const status = await recap(['status', ...target()]);
    expect(status.out).toMatch(/import: succeeded, job \w{26}, attempt 1\/3/);
    expect(status.out).toMatch(/classify: succeeded, .*tokens 1200\/300/);

    const json = await recap(['status', ...target(), '--json']);
    const parsed = JSON.parse(json.out) as { jobs: unknown[]; lock: unknown };
    expect(parsed.lock).toBeNull();
    expect(parsed.jobs).toHaveLength(4);
    for (const job of parsed.jobs) expect(validateJobRecord(job).ok).toBe(true);
  });

  it('a stage that needs config says how to pass it', async () => {
    const result = await recap(['run', 'transcribe', ...target()]);
    expect(result.code).toBe(1);
    expect(result.err).toContain('stage transcribe needs the campaign config');
    expect(result.err).toContain('fix: pass --config <campaign.yaml> and --glossary');
  });

  it('refuses --config without --glossary', async () => {
    const result = await recap(['run', 'import', ...target(), '--config', CAMPAIGN_FILE]);
    expect(result.code).toBe(1);
    expect(result.err).toContain('--config and --glossary go together');
  });

  it('reports an unknown stage and, with no stages registered, says so', async () => {
    const unknown = await recap(['run', 'nope', ...target()]);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('unknown stage "nope"');
    expect(unknown.err).toContain('registered stages: import, transcribe, classify, recap');

    const none = await recap(['run', 'transcribe', ...target()], { stages: new Map() });
    expect(none.err).toContain('no stages are registered in this version of recap yet');
  });

  it('rejects a bad session id and a bad --max-attempts', async () => {
    const bad = await recap([
      'run',
      'import',
      '--campaign',
      'synthetic-vaults',
      '--session',
      '../x',
    ]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('session_id');
    const attempts = await recap(['run', 'import', ...target(), '--max-attempts', '0']);
    expect(attempts.code).toBe(2);
  });

  it('Ctrl+C cancels the running job and exits 130', async () => {
    let interrupt: () => void = () => undefined;
    const stages = pipelineStages(world, {
      import: {
        run: (ctx) =>
          new Promise((_resolve, reject) => {
            ctx.signal.addEventListener('abort', () => {
              reject(new Error('aborted'));
            });
            interrupt();
          }),
      },
    });
    const result = await recap(['run', 'import', ...target()], {
      stages,
      onInterrupt: (abort) => {
        interrupt = abort;
        return () => undefined;
      },
    });
    expect(result.code).toBe(130);
    expect(result.err).toContain('cancelling');
    expect(result.out).toMatch(/import: cancelled/);
    expect(result.out).toContain('result: cancelled');
    const status = await recap(['status', ...target()]);
    expect(status.out).toMatch(/import: cancelled/);
  });

  it('a failed stage exits 1 and status shows the actionable error', async () => {
    const stages = pipelineStages(world, {
      import: {
        run: async () => {
          const { StageError } = await import('../../src/jobs/index.ts');
          throw new StageError(
            'source-missing',
            'audio/gm/0.flac is missing; re-import the session',
          );
        },
      },
    });
    const result = await recap(['run', 'import', ...target()], { stages });
    expect(result.code).toBe(1);
    expect(result.out).toContain('import: failed');
    const status = await recap(['status', ...target()]);
    expect(status.out).toContain(
      'source-missing: audio/gm/0.flac is missing; re-import the session',
    );
  });
});
