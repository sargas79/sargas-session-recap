import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { validateContract } from '@sargas-recap/contracts';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../src/log/index.ts';
import { registerReviewCommands } from '../../src/review/index.ts';
import {
  CAMPAIGN,
  CLASS_1,
  newWorld,
  result,
  RUN_A,
  RUN_B,
  seg,
  SESSION,
  type World,
} from './helpers.ts';

const SENTINEL_TEXT = 'SENTINELA-TEXTO-DO-MESTRE';
const A0 = seg(RUN_A, 0, 0, 1_000, 'SENTINELA-TRANSCRICAO', { flags: ['repetition_loop'] });

let world: World;
let logged: string[];

beforeEach(async () => {
  world = await newWorld();
  logged = [];
  process.exitCode = undefined;
  await world.transcribe(RUN_A, [A0]);
  await world.classify(CLASS_1, RUN_A, [result(CLASS_1, A0, 'mixed')]);
});

afterEach(() => {
  process.exitCode = undefined;
  world.close();
});

async function recap(args: readonly string[]) {
  let out = '';
  let err = '';
  const io = { out: (t: string) => (out += t), err: (t: string) => (err += t) };
  const program = new Command().name('recap').exitOverride();
  program.configureOutput({ writeOut: io.out, writeErr: io.err });
  registerReviewCommands(program, io, {
    logger: createLogger({ sink: (line) => logged.push(line) }),
  });
  process.exitCode = undefined;
  await program.parseAsync(['node', 'recap', ...args]);
  return { out, err, code: process.exitCode };
}

const target = () => [
  '--campaign',
  CAMPAIGN,
  '--session',
  SESSION,
  '--data-root',
  path.join(world.dir, 'data'),
];

describe('recap overrides', () => {
  it('sets, lists and shows the effect, without content in the logs', async () => {
    const set = await recap([
      'overrides',
      'set',
      ...target(),
      '--segment',
      A0.segment_id,
      '--text',
      SENTINEL_TEXT,
      '--status',
      'reviewed',
      '--json',
    ]);
    expect(set.code).toBeUndefined();
    expect(validateContract('review-override', JSON.parse(set.out)).ok).toBe(true);

    const list = await recap(['overrides', 'list', ...target()]);
    expect(list.out).toContain('overrides (1):');
    expect(list.out).toContain('cleaned-text');
    expect(list.out).not.toContain(SENTINEL_TEXT);

    const effective = await recap(['overrides', 'effective', ...target()]);
    expect(effective.out).toContain('mixed/classification include reviewed review-required');
    expect(effective.out).toContain('[repetition_loop]');
    expect(effective.out).not.toContain(SENTINEL_TEXT);

    const withText = await recap(['overrides', 'effective', ...target(), '--text']);
    expect(withText.out).toContain(`override: ${SENTINEL_TEXT}`);
    expect(withText.out).toContain(`original: ${A0.text_original}`);

    const json = await recap(['overrides', 'effective', ...target(), '--json']);
    expect(validateContract('effective-transcript-review', JSON.parse(json.out)).ok).toBe(true);

    expect(logged.some((line) => line.includes('review.override-set'))).toBe(true);
    for (const line of logged) {
      expect(line).not.toContain(SENTINEL_TEXT);
      expect(line).not.toContain(A0.text_original);
    }
  });

  it('reads the text from a file, and clears values', async () => {
    const file = path.join(world.dir, 'clean.txt');
    writeFileSync(file, `${String.fromCharCode(0xfeff)}Texto limpo.\r\n`);
    await recap(['overrides', 'set', ...target(), '--segment', A0.segment_id, '--text-file', file]);
    const set = await recap([
      'overrides',
      'set',
      ...target(),
      '--segment',
      A0.segment_id,
      '--label',
      'ic',
      '--json',
    ]);
    expect(JSON.parse(set.out)).toMatchObject({
      text_override: 'Texto limpo.',
      label_override: 'ic',
    });
    const cleared = await recap([
      'overrides',
      'set',
      ...target(),
      '--segment',
      A0.segment_id,
      '--clear-text',
      '--clear-label',
      '--json',
    ]);
    const parsed = JSON.parse(cleared.out) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('text_override');
    expect(parsed).not.toHaveProperty('label_override');
  });

  it('shows unreconciled overrides first, warns about exclusions and reconciles', async () => {
    const created = await recap([
      'overrides',
      'set',
      ...target(),
      '--segment',
      A0.segment_id,
      '--exclusion',
      'spoiler,privacy',
      '--json',
    ]);
    const id = (JSON.parse(created.out) as { override_id: string }).override_id;
    const b0 = seg(RUN_B, 0, 0, 1_000, 'Outra fala.');
    await world.transcribe(RUN_B, [b0]);

    const list = await recap(['overrides', 'list', ...target()]);
    expect(list.out.indexOf('needs reconciliation (1):')).toBeLessThan(
      list.out.indexOf('overrides (0):'),
    );
    expect(list.out).toContain(`${id} ${A0.segment_id} run_changed exclusions=spoiler,privacy`);
    expect(list.out).toContain('a recap is refused');

    const reconciled = await recap([
      'overrides',
      'reconcile',
      ...target(),
      '--override',
      id,
      '--segment',
      b0.segment_id,
    ]);
    expect(reconciled.code).toBeUndefined();

    const json = await recap(['overrides', 'list', ...target(), '--json']);
    const parsed = JSON.parse(json.out) as {
      needs_reconciliation: unknown[];
      overrides: { supersedes_override_id?: string }[];
    };
    expect(parsed.needs_reconciliation).toEqual([]);
    expect(parsed.overrides[0]?.supersedes_override_id).toBe(id);

    const history = await recap(['overrides', 'history', ...target(), '--override', id]);
    expect(history.out).toContain('rev 1');
    expect(history.out).toContain('rev 2');
    expect(history.out).toContain('needs_reconciliation');
  });

  it('reports usage errors with exit code 2 and other errors with 1', async () => {
    const seg0 = ['--segment', A0.segment_id];
    expect((await recap(['overrides', 'set', ...target(), ...seg0])).code).toBe(2);
    const badLabel = await recap(['overrides', 'set', ...target(), ...seg0, '--label', 'nope']);
    expect(badLabel.code).toBe(2);
    expect(badLabel.err).toContain('--label must be one of');
    expect(
      (await recap(['overrides', 'set', ...target(), ...seg0, '--text', 'a', '--clear-text'])).code,
    ).toBe(2);
    expect((await recap(['overrides', 'reconcile', ...target(), '--override', 'x'])).code).toBe(2);
    const missing = await recap([
      'overrides',
      'set',
      ...target(),
      '--segment',
      `${RUN_A}:5:5`,
      '--status',
      'reviewed',
    ]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('fix: list the segments');
  });

  it('error messages do not repeat the text', async () => {
    const result2 = await recap([
      'overrides',
      'set',
      ...target(),
      '--segment',
      A0.segment_id,
      '--text',
      `${SENTINEL_TEXT}${'x'.repeat(20_001)}`,
    ]);
    expect(result2.code).toBe(1);
    expect(result2.err).not.toContain(SENTINEL_TEXT);
  });
});
