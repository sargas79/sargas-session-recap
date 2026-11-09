/**
 * Basic end-to-end run on a synthetic session: the real server, the real job runner and the real
 * classify and recap stages, with the fake `claude` CLI scripts. Loopback only, no model calls.
 */
import { mkdirSync } from 'node:fs';
import type { TranscriptionSegment } from '@sargas-recap/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClassifyStage } from '../../src/classify/index.ts';
import { defineStages, runStage } from '../../src/jobs/index.ts';
import { createRecapStage } from '../../src/recap/index.ts';
import { startReviewServer, type RunningReviewServer } from '../../src/review-ui/index.ts';
import { fakeClassifier, fakeTranscribe, RUN_ID, segment } from '../classify/helpers.ts';
import { glossary } from '../config/helpers.ts';
import { noSleep, openFixture, runConfig, type Fixture } from '../jobs/helpers.ts';
import { llmCampaign } from '../llm/helpers.ts';
import { fakeRecapper, note, output, sentence, type FakeRecapper } from '../recap/helpers.ts';
import { CAMPAIGN, SESSION } from '../transcribe/whisper-helpers.ts';
import { openBrowser, overridePath, type Browser } from './helpers.ts';

const LINES = (): TranscriptionSegment[] => [
  segment(0, 0, 'player-ana', 1_000, 'Kira abre a porta do farol'),
  segment(0, 1, 'gm', 5_000, 'SEGREDO-OOC vamos pedir pizza OOC'),
  segment(0, 2, 'gm', 13_000, 'o guarda e um traidor SEGREDO-SPOILER'),
  segment(0, 3, 'gm', 17_000, 'o vento uiva na escada NARR'),
];
const id = (ref: string): string => `${RUN_ID}:${ref}`;

let fx: Fixture;
let recapper: FakeRecapper;
let server: RunningReviewServer;
let browser: Browser;

function stages() {
  return defineStages([
    fakeTranscribe(LINES()),
    createClassifyStage(fakeClassifier(fx.dir).options),
    createRecapStage(recapper.options),
  ]);
}

const config = () => runConfig(llmCampaign(), glossary());

async function regenerate(): Promise<void> {
  const answer = await browser.postForm('/api/recap/regenerate', [['confirm', 'yes']]);
  expect(answer.status).toBe(303);
  await expect
    .poll(
      async () =>
        (
          JSON.parse((await browser.get('/api/recap/regeneration')).text) as {
            status: string;
          }
        ).status,
      { timeout: 20_000, interval: 50 },
    )
    .not.toBe('running');
}

beforeEach(async () => {
  fx = await openFixture();
  mkdirSync(fx.paths.sessionDir(CAMPAIGN, SESSION), { recursive: true });
  recapper = fakeRecapper(fx.dir);
  recapper.script(output([sentence(['0:0', '0:2'], 'Kira abriu o farol.')], [note(['0:3'])]));
  const report = await runStage({
    db: fx.db,
    campaignId: CAMPAIGN,
    sessionId: SESSION,
    stage: 'recap',
    stages: stages(),
    paths: fx.paths,
    config: config(),
    logger: fx.logger,
    sleep: noSleep,
  });
  expect(report.status).toBe('succeeded');
  server = await startReviewServer({
    ref: { db: fx.db, paths: fx.paths, campaignId: CAMPAIGN, sessionId: SESSION },
    stages: stages(),
    loadConfig: () => Promise.resolve(config()),
    logger: fx.logger,
    clientScript: 'export {};',
  });
  browser = await openBrowser(server);
});

afterEach(async () => {
  await server.close();
  fx.cleanup();
});

describe('review UI on a synthetic session', () => {
  it('reviews, corrects and regenerates from the corrected state', async () => {
    // The first draft is shown, with footnotes that point at lines of the page.
    const first = (await browser.get()).text;
    expect(first).toContain('Kira abriu o farol.');
    expect(first).toContain('revision 1');
    expect(first).toContain(`href="#seg-${RUN_ID}-0-0"`);
    expect(first).toContain(`id="seg-${RUN_ID}-0-0"`);

    // The GM excludes the spoiler through the same form the page shows.
    const save = await browser.postForm(overridePath(id('0:2')), [
      ['exclusions_present', '1'],
      ['exclusions', 'spoiler'],
      ['status', 'reviewed'],
    ]);
    expect(save.status).toBe(303);
    const corrected = (await browser.get()).text;
    expect(corrected).toContain('recap: exclude (spoiler)');
    expect(corrected).toContain('You changed lines since this draft was written');
    expect(corrected).toContain('cites a line you have excluded');

    // Regeneration goes through the job runner and writes revision 2 from the corrected state.
    recapper.clearCalls();
    recapper.script(output([sentence(['0:0'], 'Kira abriu o farol de novo.')]));
    await regenerate();
    expect(JSON.parse((await browser.get('/api/recap/regeneration')).text)).toMatchObject({
      status: 'succeeded',
      revision: 2,
    });
    const prompts = recapper.prompts().join('\n');
    expect(prompts).toContain('a porta do farol');
    expect(prompts).not.toContain('SEGREDO-SPOILER');

    const second = (await browser.get()).text;
    expect(second).toContain('Kira abriu o farol de novo.');
    expect(second).toContain('revision 2');
    expect(second).not.toContain('cites a line you have excluded');
    expect(second).not.toContain('You changed lines since this draft was written');
    expect(fx.logLines.join('\n')).not.toContain('SEGREDO-SPOILER');
    expect(fx.logLines.join('\n')).not.toContain('Kira abriu o farol');
  });

  it('reports up to date when nothing changed, without calling the provider', async () => {
    recapper.clearCalls();
    await regenerate();
    expect(JSON.parse((await browser.get('/api/recap/regeneration')).text)).toEqual({
      status: 'up-to-date',
    });
    expect(recapper.prompts()).toEqual([]);
  });
});
