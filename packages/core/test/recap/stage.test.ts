import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  validateContract,
  type CampaignConfig,
  type Manifest,
  type Recap,
  type TranscriptionSegment,
} from '@sargas-recap/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClassifyStage } from '../../src/classify/index.ts';
import { defineStages, latestJob, runStage, type RunReport } from '../../src/jobs/index.ts';
import { createRecapStage } from '../../src/recap/index.ts';
import { setOverride, setSegmentOverride, type SessionRef } from '../../src/review/index.ts';
import { fakeClassifier, fakeTranscribe, RUN_ID, segment } from '../classify/helpers.ts';
import { glossary } from '../config/helpers.ts';
import { noSleep, openFixture, runConfig, type Fixture } from '../jobs/helpers.ts';
import { llmCampaign } from '../llm/helpers.ts';
import { CAMPAIGN, SESSION } from '../transcribe/whisper-helpers.ts';
import { fakeRecapper, note, output, sentence, type FakeRecapper } from './helpers.ts';

const OTHER_RUN = '01JBX7Q8M2N4P6R8S0T2V4W6XZ';
const id = (ref: string): string => `${RUN_ID}:${ref}`;

/** The fake classifier labels by the words in the text. */
function sessionSegments(): TranscriptionSegment[] {
  return [
    segment(0, 0, 'player-ana', 1_000, 'Kira abre a porta do farol'),
    segment(0, 1, 'gm', 5_000, 'SEGREDO-OOC vamos pedir pizza OOC'),
    segment(0, 2, 'gm', 9_000, 'o farol range e TEXTO-MISTO pizza MIXED'),
    segment(0, 3, 'gm', 13_000, 'o guarda e um traidor SEGREDO-SPOILER'),
    segment(0, 4, 'gm', 17_000, 'o vento uiva na escada NARR'),
  ];
}

let fx: Fixture;
let root: string;
let recapper: FakeRecapper;
let ref: SessionRef;

function config(campaign: CampaignConfig = llmCampaign()) {
  return runConfig(campaign, glossary());
}

function stages(segments: readonly TranscriptionSegment[] = sessionSegments()) {
  const classifier = fakeClassifier(fx.dir);
  return defineStages([
    fakeTranscribe(segments),
    createClassifyStage(classifier.options),
    createRecapStage(recapper.options),
  ]);
}

async function run(
  options: {
    readonly sessionId?: string;
    readonly stageSet?: ReturnType<typeof stages>;
    readonly campaign?: CampaignConfig;
    readonly force?: boolean;
  } = {},
): Promise<RunReport> {
  return runStage({
    db: fx.db,
    campaignId: CAMPAIGN,
    sessionId: options.sessionId ?? SESSION,
    stage: 'recap',
    stages: options.stageSet ?? stages(),
    paths: fx.paths,
    config: config(options.campaign),
    logger: fx.logger,
    sleep: noSleep,
    force: options.force,
  });
}

function outcome(report: RunReport): RunReport['stages'][number] {
  const found = report.stages.find((s) => s.stage === 'recap');
  if (found === undefined) throw new Error('recap did not run');
  return found;
}

function readRecap(revision: number, sessionDir = root): Recap {
  const raw = readFileSync(path.join(sessionDir, 'recap', String(revision), 'recap.json'), 'utf8');
  return JSON.parse(raw) as Recap;
}

function excludeSpoiler(): Promise<unknown> {
  return setSegmentOverride(ref, id('0:3'), { exclusionReasons: ['spoiler'] });
}

/** Runs through classification, so overrides have a run to attach to. */
async function classifyFirst(): Promise<void> {
  await runStage({
    db: fx.db,
    campaignId: CAMPAIGN,
    sessionId: SESSION,
    stage: 'classify',
    stages: stages(),
    paths: fx.paths,
    config: config(),
    logger: fx.logger,
    sleep: noSleep,
  });
}

beforeEach(async () => {
  fx = await openFixture();
  root = fx.paths.sessionDir(CAMPAIGN, SESSION);
  mkdirSync(root, { recursive: true });
  recapper = fakeRecapper(fx.dir);
  ref = { db: fx.db, paths: fx.paths, campaignId: CAMPAIGN, sessionId: SESSION };
});

afterEach(() => {
  fx.cleanup();
});

describe('recap run recap', () => {
  it('writes a validated draft, its Markdown and the GM notes apart', async () => {
    recapper.script(output([sentence(['0:0'])], [note(['0:4'], 'Quem abriu mesmo?')]));
    const report = await run();
    expect(report.status).toBe('succeeded');

    const recap = readRecap(1);
    expect(validateContract('recap', recap).ok).toBe(true);
    expect(recap).toMatchObject({
      campaign_id: CAMPAIGN,
      session_id: SESSION,
      recap_revision: 1,
      transcription_run_id: RUN_ID,
      language: 'pt-BR',
      title: 'Sessão sintética',
    });
    expect(recap.sentences).toEqual([
      {
        sentence_id: 'r1:s0',
        text: 'Kyra abriu a porta do farol.',
        assertion: 'completed',
        citations: { segment_ids: [id('0:0')], event_ids: [] },
      },
    ]);
    expect(recap.gm_notes.map((n) => [n.note_id, n.reason])).toEqual([
      ['r1:g0', 'unresolved'],
      // The mixed segment waits for a GM decision and is cited by core's own note.
      ['r1:g1', 'unresolved'],
    ]);
    expect(recap.gm_notes[1]?.citations.segment_ids).toEqual([id('0:2')]);

    const dir = path.join(root, 'recap', '1');
    expect(readdirSync(dir).sort()).toEqual(['gm-notes.md', 'recap.json', 'recap.md']);
    const markdown = readFileSync(path.join(dir, 'recap.md'), 'utf8');
    expect(markdown).toContain('Kyra abriu a porta do farol.[^1]');
    expect(markdown).not.toContain('Quem abriu');
    expect(readFileSync(path.join(dir, 'gm-notes.md'), 'utf8')).toContain('Quem abriu');

    const job = latestJob(fx.db, CAMPAIGN, SESSION, 'recap', 'succeeded');
    expect(job?.outputRecapRevision).toBe(1);
    expect(job?.outputs.map((o) => o.path).sort()).toEqual([
      'recap/1/gm-notes.md',
      'recap/1/recap.json',
      'recap/1/recap.md',
    ]);
    const inputs = job?.inputs.map((i) => `${i.kind}:${i.ref}`) ?? [];
    expect(inputs).toContain('prompt:recap.draft@v2');
    expect(inputs).toContain('prompt:recap.system@v1');
    expect(inputs).toContain('overrides:effective-transcript');
  });

  it('never sends excluded or unresolved text, while sending the override text', async () => {
    await classifyFirst();
    await excludeSpoiler();
    await setSegmentOverride(ref, id('0:2'), { textOverride: 'o farol range LIMPO' });
    recapper.script(output([sentence(['0:0'])]));
    expect((await run()).status).toBe('succeeded');

    const [prompt] = recapper.prompts();
    if (prompt === undefined) throw new Error('no provider call');
    expect(prompt).toContain('Kyra');
    expect(prompt).toContain('LIMPO');
    expect(prompt).not.toMatch(/SEGREDO-OOC|SEGREDO-SPOILER|TEXTO-MISTO|pizza/);
  });

  it('sends unresolved segments nowhere, not even as context', async () => {
    recapper.script(output([sentence(['0:0'])]));
    await run();
    const [prompt] = recapper.prompts();
    if (prompt === undefined) throw new Error('no provider call');
    expect(prompt).not.toContain('TEXTO-MISTO');
    expect(prompt).not.toContain('0:2');
  });

  it.each([['spoiler'], ['privacy']] as const)(
    'refuses, without any provider call, while a %s exclusion is unreconciled',
    async (reason) => {
      await classifyFirst();
      setOverride(
        fx.db,
        {
          campaign_id: CAMPAIGN,
          session_id: SESSION,
          transcription_run_id: OTHER_RUN,
          segment_id: `${OTHER_RUN}:0:3`,
          base_text_hash: `sha256:${'a'.repeat(64)}`,
        },
        { exclusionReasons: [reason] },
        new Date('2026-11-02T20:00:00.000Z'),
      );
      const report = await run();
      expect(report.status).toBe('failed');
      expect(outcome(report).error?.code).toBe('recap-unreconciled-exclusions');
      expect(recapper.prompts()).toEqual([]);
      expect(existsSync(path.join(root, 'recap'))).toBe(false);
    },
  );

  it('is not blocked by an unreconciled off-topic exclusion', async () => {
    await classifyFirst();
    setOverride(
      fx.db,
      {
        campaign_id: CAMPAIGN,
        session_id: SESSION,
        transcription_run_id: OTHER_RUN,
        segment_id: `${OTHER_RUN}:0:3`,
        base_text_hash: `sha256:${'a'.repeat(64)}`,
      },
      { exclusionReasons: ['off-topic'] },
      new Date('2026-11-02T20:00:00.000Z'),
    );
    expect((await run()).status).toBe('succeeded');
  });

  it('retries an invented citation and uses the attempt that passes', async () => {
    recapper.script(output([sentence(['0:99'])]), output([sentence(['0:4'])]));
    const report = await run();
    expect(report.status).toBe('succeeded');
    expect(recapper.prompts()).toHaveLength(2);
    expect(readRecap(1).sentences[0]?.citations.segment_ids).toEqual([id('0:4')]);
  });

  it('fails the job on a citation of an excluded segment, allocating no revision', async () => {
    await classifyFirst();
    await excludeSpoiler();
    // 0:3 exists in the transcript, but it was excluded and so never sent.
    recapper.script(output([sentence(['0:3'])]));
    const report = await run();
    expect(report.status).toBe('failed');
    expect(outcome(report).error?.code).toBe('llm-schema-invalid');
    expect(recapper.prompts()).toHaveLength(3);
    expect(existsSync(path.join(root, 'recap'))).toBe(false);
    const row = fx.db.prepare('SELECT COUNT(*) AS n FROM recap_revisions').get() as { n: number };
    expect(row.n).toBe(0);
  });

  it('turns uncited and background claims into GM notes', async () => {
    recapper.script(
      output([
        sentence(['0:0']),
        sentence([], 'Frase sem fonte.'),
        sentence(['0:4'], 'Lembrança antiga.', { assertion: 'background' }),
      ]),
    );
    await run();
    const recap = readRecap(1);
    expect(recap.sentences.map((s) => s.text)).toEqual(['Kyra abriu a porta do farol.']);
    const notes = recap.gm_notes.filter((n) => n.reason === 'unsupported').map((n) => n.text);
    expect(notes).toEqual(['Frase sem fonte.', 'Lembrança antiga.']);
    expect(readFileSync(path.join(root, 'recap', '1', 'recap.md'), 'utf8')).not.toMatch(
      /sem fonte|Lembrança/,
    );
  });

  it('allocates a new revision when the GM changes a decision, and keeps the old one', async () => {
    recapper.script(output([sentence(['0:0'])]));
    await run();
    const first = readFileSync(path.join(root, 'recap', '1', 'recap.json'), 'utf8');

    recapper.clearCalls();
    const again = await run();
    expect(outcome(again).action).toBe('up-to-date');
    expect(recapper.prompts()).toEqual([]);

    await excludeSpoiler();
    const third = await run();
    expect(outcome(third).action).toBe('succeeded');
    expect(outcome(third).changedInputs).toEqual(['overrides:effective-transcript']);
    expect(readRecap(2).sentences[0]?.sentence_id).toBe('r2:s0');
    expect(readFileSync(path.join(root, 'recap', '1', 'recap.json'), 'utf8')).toBe(first);
  });

  it('refuses when nothing is included, without calling the provider', async () => {
    const stageSet = stages([segment(0, 0, 'gm', 1_000, 'SEGREDO-OOC pizza OOC')]);
    const report = await run({ stageSet });
    expect(outcome(report).error?.code).toBe('recap-no-eligible-segments');
    expect(recapper.prompts()).toEqual([]);
  });

  it('refuses a language the prompt does not write', async () => {
    const campaign = llmCampaign();
    campaign.language = 'en';
    const report = await run({ campaign });
    expect(outcome(report).error?.code).toBe('recap-language-unsupported');
    expect(recapper.prompts()).toEqual([]);
  });

  it('never logs transcript or recap text', async () => {
    recapper.script(output([sentence(['0:99'])]), output([sentence(['0:0'])]));
    await run();
    const logged = fx.logLines.join('\n');
    expect(logged).toContain('recap.finished');
    expect(logged).not.toMatch(/Kyra abriu|farol|SEGREDO|Sessão sintética/);
  });
});

describe('consent', () => {
  function withoutRecapConsent(speakerId: string): CampaignConfig {
    const campaign = llmCampaign();
    campaign.consent_mode = 'records';
    for (const speaker of campaign.speakers) {
      if (speaker.speaker_id === speakerId) {
        speaker.consent = (speaker.consent ?? []).filter((r) => r.purpose !== 'recap');
      }
    }
    return campaign;
  }

  const anaOnlyOoc = [
    segment(0, 0, 'gm', 1_000, 'o vento uiva na escada NARR'),
    segment(0, 1, 'player-ana', 5_000, 'uma pausa pra pizza OOC'),
  ];

  it('does not ask consent of a speaker whose only words stay out of the prompt', async () => {
    recapper.script(output([sentence(['0:0'])]));
    const report = await run({
      campaign: withoutRecapConsent('player-ana'),
      stageSet: stages(anaOnlyOoc),
    });
    expect(report.status).toBe('succeeded');
  });

  it('refuses a speaker in the prompt who has no recap consent', async () => {
    const report = await run({ campaign: withoutRecapConsent('player-ana') });
    expect(report.status).toBe('failed');
    expect(outcome(report).error?.code).toMatch(/consent/);
    expect(recapper.prompts()).toEqual([]);
  });
});

describe('previous recaps as background', () => {
  const EARLIER = 's00';

  function writeManifest(sessionId: string, createdAt: string): void {
    const fixture = new URL(
      '../../../../fixtures/contracts/manifest/valid-audio-purged.json',
      import.meta.url,
    );
    const manifest = JSON.parse(readFileSync(fixture, 'utf8')) as Manifest;
    manifest.campaign_id = CAMPAIGN;
    manifest.session_id = sessionId;
    manifest.created_at = createdAt;
    const dir = fx.paths.sessionDir(CAMPAIGN, sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  }

  async function earlierRecap(): Promise<void> {
    writeManifest(EARLIER, '2026-10-26T20:00:00.000Z');
    recapper.script(
      output(
        [sentence(['0:0'], 'FRASE-ANTERIOR.'), sentence(['0:3'], 'FRASE-SPOILER.')],
        [note(['0:0'], 'NOTA-SECRETA.')],
      ),
    );
    expect((await run({ sessionId: EARLIER })).status).toBe('succeeded');
    recapper.clearCalls();
  }

  it('sends the earlier recap as background, without its GM notes or citations', async () => {
    await earlierRecap();
    writeManifest(SESSION, '2026-11-02T20:00:00.000Z');
    recapper.script(output([sentence(['0:0'])]));
    expect((await run()).status).toBe('succeeded');

    const [prompt] = recapper.prompts();
    if (prompt === undefined) throw new Error('no provider call');
    expect(prompt).toMatch(/name="previous_recaps">\n.*FRASE-ANTERIOR/);
    expect(prompt).not.toContain('NOTA-SECRETA');
    expect(prompt).not.toContain(`${EARLIER}:`);
    expect(prompt).not.toContain(id('0:0'));

    const job = latestJob(fx.db, CAMPAIGN, SESSION, 'recap', 'succeeded');
    expect(job?.inputs).toContainEqual(
      expect.objectContaining({
        kind: 'artifact',
        ref: `previous-recap/${EARLIER}/1`,
        role: 'receipt',
      }),
    );
  });

  it('drops a sentence whose segment was excluded after that recap was written', async () => {
    await earlierRecap();
    await setSegmentOverride({ ...ref, sessionId: EARLIER }, id('0:3'), {
      exclusionReasons: ['spoiler'],
    });
    writeManifest(SESSION, '2026-11-02T20:00:00.000Z');
    recapper.script(output([sentence(['0:0'])]));
    await run();
    const [prompt] = recapper.prompts();
    if (prompt === undefined) throw new Error('no provider call');
    expect(prompt).toContain('FRASE-ANTERIOR');
    expect(prompt).not.toContain('FRASE-SPOILER');
  });

  it('does not use a later session as background', async () => {
    writeManifest(EARLIER, '2026-11-20T20:00:00.000Z');
    recapper.script(output([sentence(['0:0'], 'FRASE-FUTURA.')]));
    await run({ sessionId: EARLIER });
    recapper.clearCalls();
    writeManifest(SESSION, '2026-11-02T20:00:00.000Z');
    recapper.script(output([sentence(['0:0'])]));
    await run();
    const [prompt] = recapper.prompts();
    expect(prompt).not.toContain('FRASE-FUTURA');
  });

  it('fails an attempt that cites the background, since it has no refs in this session', async () => {
    await earlierRecap();
    writeManifest(SESSION, '2026-11-02T20:00:00.000Z');
    recapper.script(output([sentence(['7:7'])]));
    const report = await run();
    expect(report.status).toBe('failed');
    expect(outcome(report).error?.code).toBe('llm-schema-invalid');
  });
});
