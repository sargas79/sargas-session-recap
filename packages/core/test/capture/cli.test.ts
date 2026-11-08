import { existsSync } from 'node:fs';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerImportCommands } from '../../src/capture/index.ts';
import { buildProgram } from '../../src/cli/program.ts';
import { createLogger } from '../../src/log/index.ts';
import {
  BASIC_MAPPING,
  CAMPAIGN_ID,
  makeImportFixture,
  wavBytes,
  writeBasicTracks,
  type ImportFixture,
} from './helpers.ts';

let fx: ImportFixture;
let logs: string[];

beforeEach(() => {
  fx = makeImportFixture();
  logs = [];
  process.exitCode = undefined;
});
afterEach(() => {
  process.exitCode = undefined;
  fx.cleanup();
});

async function run(args: string[], confirm?: (question: string) => Promise<boolean>) {
  const out: string[] = [];
  const err: string[] = [];
  const program = new Command().exitOverride();
  const io = { out: (t: string) => out.push(t), err: (t: string) => err.push(t) };
  program.configureOutput({ writeOut: io.out, writeErr: io.err });
  registerImportCommands(program, io, {
    toolVersion: '0.0.0-test',
    ...(confirm === undefined ? {} : { confirm }),
    logger: createLogger({ sink: (line) => logs.push(line) }),
  });
  await program.parseAsync(['node', 'recap', ...args]);
  const code = process.exitCode;
  process.exitCode = undefined;
  return { code, out: out.join(''), err: err.join('') };
}

const base = () => [
  'import',
  fx.dir,
  '--campaign',
  CAMPAIGN_ID,
  '--session',
  's01',
  '--data-root',
  fx.dataRoot,
];

describe('recap import', () => {
  it('is registered on the main program', () => {
    const names = buildProgram({ out: () => undefined, err: () => undefined }).commands.map((c) =>
      c.name(),
    );
    expect(names).toContain('import');
  });

  it('imports, prints the fragments, exclusions and consent, and exits 0', async () => {
    writeBasicTracks(fx);
    fx.writeTrack('3-cora.wav', wavBytes());
    fx.writeTrack('4-stranger.flac', Buffer.from('x'));
    fx.writeMapping(`${BASIC_MAPPING}  - { file: 3-cora.wav, speaker_id: player-cora }\n`);
    const result = await run(base());
    expect(result.err).toBe('');
    expect(result.code).toBeUndefined();
    expect(result.out).toContain('imported 2 track(s)');
    expect(result.out).toContain('player-ana:1');
    expect(result.out).toContain('start -1500 ms');
    expect(result.out).toContain(
      '3-cora.wav (player-cora): no recording consent record for this provider',
    );
    expect(result.out).toContain('4-stranger.flac: not in the track mapping');
    expect(result.out).toContain('consent: recording with craig, mode records, policy sha256:');
    expect(result.out).toContain('state:   sealed');
  });

  it('exits 1 with an actionable message on a missing track', async () => {
    fx.writeTrack('1-gm.wav', wavBytes());
    fx.writeMapping(BASIC_MAPPING);
    const result = await run(base());
    expect(result.code).toBe(1);
    expect(result.err).toContain('/tracks/1/file: the track is not in the import directory');
    expect(result.err).toContain('fix:');
    expect(logs.map((l) => JSON.parse(l) as Record<string, unknown>)).toEqual([
      expect.objectContaining({
        event: 'import.failed',
        command: 'import',
        errorCode: 'IMPORT_TRACK_MISSING',
      }),
    ]);
  });

  it('refuses re-import, and replaces only after confirmation', async () => {
    writeBasicTracks(fx);
    fx.writeMapping(BASIC_MAPPING);
    expect((await run(base())).code).toBeUndefined();

    const again = await run(base());
    expect(again.code).toBe(1);
    expect(again.err).toContain('already has a package');
    expect(again.err).toContain('--replace');

    const questions: string[] = [];
    const declined = await run([...base(), '--replace'], (q) => {
      questions.push(q);
      return Promise.resolve(false);
    });
    expect(declined.code).toBe(1);
    expect(declined.err).toContain('import cancelled; nothing was changed');
    expect(questions[0]).toContain('replaces the existing package of session s01');

    const accepted = await run([...base(), '--replace'], () => Promise.resolve(true));
    expect(accepted.code).toBeUndefined();
    expect(accepted.out).toContain('(replaced the previous package)');

    const scripted = await run([...base(), '--replace', '--yes'], () =>
      Promise.reject(new Error('must not ask')),
    );
    expect(scripted.code).toBeUndefined();
  });

  it('reports consent provider and config problems without a stack trace', async () => {
    writeBasicTracks(fx);
    fx.writeMapping(`recorder: zoom-h6\n${BASIC_MAPPING}`);
    const result = await run(base());
    expect(result.code).toBe(1);
    expect(result.err).toContain('consent check refused stage recording with provider zoom-h6');
    expect(existsSync(fx.sessionDir())).toBe(false);
  });

  it('refuses an invalid session id', async () => {
    const result = await run([
      'import',
      fx.dir,
      '--campaign',
      CAMPAIGN_ID,
      '--session',
      'S 01',
      '--data-root',
      fx.dataRoot,
    ]);
    expect(result.code).toBe(1);
    expect(result.err).toContain('invalid session_id');
  });
});
