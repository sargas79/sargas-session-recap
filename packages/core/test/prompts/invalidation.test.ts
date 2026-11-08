/**
 * Prompt changes and T07 selective invalidation: a prompt is a `prompt` dependency input of the
 * stages that use it, so a new prompt version reruns exactly those stages (and downstream stages
 * only through their changed upstream outputs).
 */
import { validateJobRecord } from '@sargas-recap/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defineStages,
  JobError,
  latestJob,
  runStage,
  toJobRecord,
  type RunReport,
  type StageRegistry,
} from '../../src/jobs/index.ts';
import {
  loadPromptRegistry,
  promptJobInput,
  type PromptRegistry,
} from '../../src/prompts/index.ts';
import { campaign, glossary } from '../config/helpers.ts';
import {
  newWorld,
  noSleep,
  openFixture,
  pipelineStages,
  runConfig,
  type Fixture,
  type World,
} from '../jobs/helpers.ts';
import { promptText, tempPromptDir, type PromptDir } from './helpers.ts';

const CAMPAIGN = 'synthetic-vaults';
const SESSION = 's01';

let fx: Fixture;
let world: World;
let prompts: PromptDir;
const config = runConfig(campaign(), glossary());

/** Which prompt version each LLM stage pins: a fixed version, or `latest`. */
interface Pins {
  classify: number | 'latest';
  recap: number | 'latest';
}

function applyPins(registry: PromptRegistry, pins: Pins): void {
  const pick = (id: string, pin: number | 'latest') =>
    pin === 'latest' ? registry.latest(id) : registry.get(id, pin);
  world.prompts = {
    classify: promptJobInput(pick('classification.window', pins.classify)),
    recap: promptJobInput(pick('recap.draft', pins.recap)),
  };
}

function reload(pins: Pins): void {
  applyPins(loadPromptRegistry({ dir: prompts.dir }), pins);
}

function run(stages: StageRegistry = pipelineStages(world)): Promise<RunReport> {
  return runStage({
    db: fx.db,
    campaignId: CAMPAIGN,
    sessionId: SESSION,
    stage: 'recap',
    stages,
    paths: fx.paths,
    config,
    logger: fx.logger,
    sleep: noSleep,
  });
}

function reran(report: RunReport): string[] {
  return report.stages.filter((s) => s.action === 'succeeded').map((s) => s.stage);
}

beforeEach(async () => {
  fx = await openFixture();
  world = newWorld();
  prompts = tempPromptDir();
});

afterEach(() => {
  fx.cleanup();
  prompts.cleanup();
});

const CLASSIFY_V1 = 'classification/window.v1.md';
const RECAP_V1 = 'recap/draft.v1.md';

describe('prompt invalidation matrix (T26 x T07)', () => {
  const matrix: [string, () => Pins, string[]][] = [
    ['nothing changed', () => ({ classify: 1, recap: 1 }), []],
    [
      'CRLF-only rewrite of both prompts (hash unchanged)',
      () => {
        prompts.write(CLASSIFY_V1, prompts.read(CLASSIFY_V1).replace(/\r?\n/g, '\r\n'));
        prompts.write(RECAP_V1, '﻿' + prompts.read(RECAP_V1).replace(/\r?\n/g, '\r\n'));
        return { classify: 1, recap: 1 };
      },
      [],
    ],
    [
      'new recap prompt version (recap only)',
      () => {
        prompts.write('recap/draft.v2.md', promptText('recap', 'draft', 2));
        return { classify: 1, recap: 'latest' };
      },
      ['recap'],
    ],
    [
      'new classification prompt version (classify, then recap through its output)',
      () => {
        prompts.write('classification/window.v2.md', promptText('classification', 'window', 2));
        return { classify: 'latest', recap: 1 };
      },
      ['classify', 'recap'],
    ],
    [
      'new version that no stage pins (nothing)',
      () => {
        prompts.write('classification/window.v2.md', promptText('classification', 'window', 2));
        prompts.write('recap/draft.v2.md', promptText('recap', 'draft', 2));
        return { classify: 1, recap: 1 };
      },
      [],
    ],
    [
      'in-place edit without a version bump is still detected by the hash (classify, recap)',
      () => {
        prompts.write(CLASSIFY_V1, `${prompts.read(CLASSIFY_V1)}Extra line.\n`);
        return { classify: 1, recap: 1 };
      },
      ['classify', 'recap'],
    ],
  ];

  it.each(matrix)('%s', async (_name, change, expected) => {
    reload({ classify: 1, recap: 1 });
    const first = await run();
    expect(reran(first)).toEqual(['import', 'transcribe', 'classify', 'recap']);

    reload(change());
    const report = await run();
    expect(report.status).toBe('succeeded');
    expect(reran(report)).toEqual(expected);
    for (const stage of report.stages) {
      if (!expected.includes(stage.stage)) expect(stage.action).toBe('up-to-date');
    }
  });

  it('only the stage that uses the prompt sees a prompt input change', async () => {
    reload({ classify: 1, recap: 1 });
    await run();
    prompts.write('classification/window.v2.md', promptText('classification', 'window', 2));
    reload({ classify: 'latest', recap: 1 });
    const report = await run();
    const byStage = Object.fromEntries(report.stages.map((s) => [s.stage, s.changedInputs]));
    expect(byStage['classify']).toEqual([
      'prompt:classification.window@v1',
      'prompt:classification.window@v2',
    ]);
    // recap reruns only because classify's output changed, not because of a prompt.
    expect(byStage['recap']).toEqual(['artifact:classify/results.jsonl']);
  });
});

describe('prompt recorded in run records', () => {
  it('every classify and recap job records the prompt id, version and hash it used', async () => {
    reload({ classify: 1, recap: 1 });
    await run();
    const registry = loadPromptRegistry({ dir: prompts.dir });
    const expected = {
      classify: registry.get('classification.window', 1),
      recap: registry.get('recap.draft', 1),
    } as const;
    for (const stage of ['classify', 'recap'] as const) {
      const job = latestJob(fx.db, CAMPAIGN, SESSION, stage);
      if (job === undefined) throw new Error(`no ${stage} job`);
      const prompt = job.inputs.filter((i) => i.kind === 'prompt');
      expect(prompt).toEqual([
        {
          kind: 'prompt',
          ref: `${expected[stage].id}@v${String(expected[stage].version)}`,
          hash: expected[stage].hash,
          role: 'dependency',
        },
      ]);
      const record = toJobRecord(job);
      expect(validateJobRecord(record).ok).toBe(true);
      expect(record.inputs).toContainEqual(
        expect.objectContaining({ kind: 'prompt', hash: expected[stage].hash }),
      );
    }
  });

  it('the runner refuses a classify or recap stage that declares no prompt', async () => {
    for (const stage of ['classify', 'recap'] as const) {
      const stages = pipelineStages(world, { [stage]: { inputs: () => [] } });
      const error = await run(stages).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(JobError);
      expect((error as JobError).code).toBe('JOB_INVALID_INPUT');
      expect((error as JobError).message).toContain(`stage ${stage} declared no prompt input`);
    }
    // Stages without an LLM prompt need none.
    expect(() => defineStages([{ name: 'import', run: () => undefined }])).not.toThrow();
  });
});
