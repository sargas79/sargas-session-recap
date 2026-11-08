import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli/program.ts';
import { createLogger } from '../../src/log/index.ts';
import { registerPackageCommands } from '../../src/package/index.ts';
import { makePackage, type TempPackage } from './helpers.ts';

let pkg: TempPackage;
let out: string[];
let err: string[];
let logs: string[];

beforeEach(() => {
  pkg = makePackage();
  out = [];
  err = [];
  logs = [];
  process.exitCode = undefined;
});
afterEach(() => {
  process.exitCode = undefined;
  pkg.cleanup();
});

async function run(args: string[], confirm?: (question: string) => Promise<boolean>) {
  const program = new Command().exitOverride();
  const io = { out: (t: string) => out.push(t), err: (t: string) => err.push(t) };
  program.configureOutput({ writeOut: io.out, writeErr: io.err });
  registerPackageCommands(program, io, {
    ...(confirm === undefined ? {} : { confirm }),
    logger: createLogger({ sink: (line) => logs.push(line) }),
  });
  await program.parseAsync(['node', 'recap', ...args]);
  const code = process.exitCode;
  process.exitCode = undefined;
  return { code, out: out.join(''), err: err.join('') };
}

describe('recap package', () => {
  it('is registered on the main program', () => {
    const help = buildProgram({ out: () => undefined, err: () => undefined })
      .commands.find((c) => c.name() === 'package')
      ?.commands.map((c) => c.name());
    expect(help).toEqual(['validate', 'seal', 'purge-audio']);
  });

  it('validate prints the state and exits 0 for a valid package', async () => {
    const result = await run(['package', 'validate', pkg.root]);
    expect(result.code).toBeUndefined();
    expect(result.out).toContain('state: capturing');
  });

  it('validate exits 1 and names file and field', async () => {
    writeFileSync(pkg.file('manifest.json'), '{"schema_version": 2}');
    const result = await run(['package', 'validate', pkg.root]);
    expect(result.code).toBe(1);
    expect(result.out).toContain('state: invalid');
    expect(result.out).toMatch(/error {3}manifest\.json \/schema_version: must be 1/);
  });

  it('validate --json prints a machine-readable report', async () => {
    const result = await run(['package', 'validate', '--json', pkg.root]);
    expect(JSON.parse(result.out)).toMatchObject({ state: 'capturing', ok: true, issues: [] });
  });

  it('seal then purge-audio round trip, with confirmation', async () => {
    const sealed = await run(['package', 'seal', pkg.root]);
    expect(sealed.code).toBeUndefined();
    expect(sealed.out).toContain('sealed 4 artifacts');
    expect(sealed.out).toContain('state: sealed');

    const again = await run(['package', 'seal', pkg.root]);
    expect(again.code).toBe(1);
    expect(again.err).toContain('already sealed');

    const questions: string[] = [];
    const declined = await run(['package', 'purge-audio', pkg.root], (q) => {
      questions.push(q);
      return Promise.resolve(false);
    });
    expect(declined.code).toBe(1);
    expect(declined.err).toContain('purge cancelled');
    expect(questions[0]).toContain('permanently deletes 3 audio file(s)');
    expect(existsSync(pkg.file('audio/gm/0.wav'))).toBe(true);

    const purged = await run(
      ['package', 'purge-audio', pkg.root, '--yes', '--by', 'gm', '--reason', 'retention-policy'],
      () => Promise.reject(new Error('must not ask with --yes')),
    );
    expect(purged.code).toBeUndefined();
    expect(purged.out).toContain('deleted 3 audio file(s)');
    expect(purged.out).toContain('state: audio-purged');
    expect(existsSync(pkg.file('audio'))).toBe(false);
    expect(logs.map((l) => (JSON.parse(l) as { event: string }).event)).toEqual([
      'package.sealed',
      'package.audio-purged',
    ]);

    const validated = await run(['package', 'validate', pkg.root]);
    expect(validated.code).toBeUndefined();
    expect(validated.out).toContain('state: audio-purged');
    expect(readFileSync(pkg.file('manifest.json'), 'utf8')).toContain('"purged_by": "gm"');
  });

  it('purge-audio rejects an unknown reason', async () => {
    await run(['package', 'seal', pkg.root]);
    const result = await run(['package', 'purge-audio', pkg.root, '--yes', '--reason', 'whim']);
    expect(result.code).toBe(2);
    expect(existsSync(pkg.file('audio/gm/0.wav'))).toBe(true);
  });
});
