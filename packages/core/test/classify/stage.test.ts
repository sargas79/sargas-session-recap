import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  validateContract,
  type ClassificationCorrectionsReport,
  type ClassificationResult,
  type TranscriptionSegment,
} from '@sargas-recap/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClassifyStage } from '../../src/classify/index.ts';
import {
  configInput,
  defineStages,
  latestJob,
  runStage,
  type RunReport,
} from '../../src/jobs/index.ts';
import { purgeAudio, validatePackage } from '../../src/package/index.ts';
import { glossary } from '../config/helpers.ts';
import { noSleep, openFixture, runConfig, type Fixture } from '../jobs/helpers.ts';
import { llmCampaign, probes } from '../llm/helpers.ts';
import { CAMPAIGN, SESSION, stagesFor, writeSealedSession } from '../transcribe/whisper-helpers.ts';
import {
  fakeClassifier,
  fakeTranscribe,
  MINUTE,
  RUN_ID,
  segment,
  type FakeClassifier,
} from './helpers.ts';

let fx: Fixture;
let root: string;
let classifier: FakeClassifier;
const transcribeRuns = { runs: 0 };

/** 200 synthetic lines over 100 minutes, two speakers, with the words the fake CLI reacts to. */
function sessionSegments(): TranscriptionSegment[] {
  const texts: Record<number, string> = {
    0: 'Kira abre a porta do farol',
    1: 'uma pausa pra pizza OOC',
    2: 'decisao e tambem pizza MIXED',
    3: 'nao entendi UNSURE',
    4: 'rola percepcao RULE',
    5: 'o farol range NARR',
    6: 'Zebulon apareceu ontem',
    7: 'o tesouro e falso SPOIL',
    8: 'Sara Ray nos proteja',
    9: 'Bogus chegou',
    10: 'Phantom text',
  };
  return Array.from({ length: 200 }, (_, i) =>
    segment(
      Math.floor(i / 10),
      i % 10,
      i % 2 === 0 ? 'gm' : 'player-ana',
      i * 30_000,
      texts[i] ?? `linha sintetica ${String(i)}`,
    ),
  );
}

function config() {
  return runConfig(llmCampaign(), glossary());
}

function stages(segments: readonly TranscriptionSegment[] = sessionSegments()) {
  return defineStages([
    fakeTranscribe(segments, transcribeRuns),
    createClassifyStage(classifier.options),
  ]);
}

async function run(stageSet = stages()): Promise<RunReport> {
  return runStage({
    db: fx.db,
    campaignId: CAMPAIGN,
    sessionId: SESSION,
    stage: 'classify',
    stages: stageSet,
    paths: fx.paths,
    config: config(),
    logger: fx.logger,
    sleep: noSleep,
  });
}

function outcome(report: RunReport): RunReport['stages'][number] {
  const found = report.stages.find((s) => s.stage === 'classify');
  if (found === undefined) throw new Error('classify did not run');
  return found;
}

function classifyDir(): string {
  return path.join(root, 'classify');
}

function finishedRuns(): string[] {
  return readdirSync(classifyDir()).filter((name) => !name.startsWith('.'));
}

function resultsOf(runId: string): ClassificationResult[] {
  return readFileSync(path.join(classifyDir(), runId, 'results.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as ClassificationResult);
}

function reportOf(runId: string): ClassificationCorrectionsReport {
  return JSON.parse(
    readFileSync(path.join(classifyDir(), runId, 'corrections-report.json'), 'utf8'),
  ) as ClassificationCorrectionsReport;
}

beforeEach(async () => {
  fx = await openFixture();
  root = fx.paths.sessionDir(CAMPAIGN, SESSION);
  mkdirSync(root, { recursive: true });
  classifier = fakeClassifier(fx.dir);
  transcribeRuns.runs = 0;
});

afterEach(() => {
  fx.cleanup();
});

describe('recap run classify', () => {
  it('writes one valid record per segment, without Foundry events and without changing text', async () => {
    const report = await run();
    expect(report.status).toBe('succeeded');
    const [runId] = finishedRuns();
    if (runId === undefined) throw new Error('no run');

    const results = resultsOf(runId);
    expect(results).toHaveLength(200);
    for (const result of results) {
      expect(validateContract('classification-result', result).ok).toBe(true);
      expect(result).not.toHaveProperty('text_original');
      expect(result.event_ids).toEqual([]);
      expect(result.transcription_run_id).toBe(RUN_ID);
    }
    const byId = (i: number) =>
      results.find(
        (r) => r.segment_id === `${RUN_ID}:${String(Math.floor(i / 10))}:${String(i % 10)}`,
      );
    expect(byId(0)).toMatchObject({ label: 'ic', text_corrected: 'Kyra abre a porta do farol' });
    expect(byId(1)).toMatchObject({ label: 'ooc', review_required: false });
    expect(byId(2)).toMatchObject({ label: 'mixed', review_required: true });
    expect(byId(3)).toMatchObject({ label: 'uncertain', review_required: true });
    expect(byId(5)).toMatchObject({ label: 'narration' });
    expect(byId(4)).toMatchObject({ label: 'rules' });
    expect(byId(8)?.corrections).toEqual([
      { kind: 'term', from: 'Sara Ray', to: 'Sarenrae', glossary_id: 'sarenrae' },
    ]);
    expect(new Set(results.map((r) => r.window_index)).size).toBeGreaterThan(1);

    const job = latestJob(fx.db, CAMPAIGN, SESSION, 'classify', 'succeeded');
    expect(job?.outputs.map((o) => path.basename(o.path)).sort()).toEqual([
      'corrections-report.json',
      'results.jsonl',
    ]);
    const original = readFileSync(path.join(root, 'transcript', RUN_ID, 'segments.jsonl'), 'utf8');
    expect(original).toContain('Kira abre a porta');
    expect(original).not.toContain('Kyra');
  });

  it('writes the corrections report with fixed, unmatched and rejected names', async () => {
    await run();
    const [runId] = finishedRuns();
    if (runId === undefined) throw new Error('no run');
    const report = reportOf(runId);
    expect(validateContract('classification-corrections-report', report).ok).toBe(true);
    expect(report.fixed.map((f) => f.to).sort()).toEqual(['Kyra', 'Sarenrae']);
    expect(report.unmatched).toEqual([{ segment_id: `${RUN_ID}:0:6`, name: 'Zebulon' }]);
    expect(report.rejected.map((r) => r.reason).sort()).toEqual([
      'source-not-in-text',
      'unknown-glossary-entry',
    ]);
  });

  it('records the task and system prompts and the config it used', async () => {
    await run();
    const job = latestJob(fx.db, CAMPAIGN, SESSION, 'classify', 'succeeded');
    if (job === undefined) throw new Error('no job');
    const prompts = job.inputs.filter((i) => i.kind === 'prompt').map((i) => i.ref);
    expect(prompts.sort()).toEqual(['classification.system@v1', 'classification.window@v2']);
    const expectedConfig = configInput(config(), 'classification');
    expect(job.inputs).toContainEqual(expect.objectContaining(expectedConfig));
    expect(job.usage?.input_tokens).toBe(
      100 * new Set(classifier.calls().map((c) => c.first)).size,
    );
  });

  it('sends each segment as core once, with neighbours as context, all inside data blocks', async () => {
    await run();
    const calls = classifier.calls();
    const core = calls.flatMap((c) => c.refs);
    expect(new Set(core).size).toBe(200);
    expect(core).toHaveLength(200);
    const second = calls[1];
    if (second === undefined) throw new Error('expected two windows');
    expect(second.before.length).toBeGreaterThan(0);
    for (const ref of [...second.before, ...second.after]) expect(second.refs).not.toContain(ref);
    const prompt = second.prompt;
    const dataStart = prompt.indexOf('<untrusted-data-');
    expect(prompt.slice(0, dataStart)).not.toContain('linha sintetica');
    expect(prompt.slice(dataStart)).toContain('linha sintetica');
  });

  it.each([['missing'], ['duplicate'], ['unknown'], ['context']])(
    'retries a window whose output has a %s ID, then accepts a good one',
    async (mode) => {
      const first = sessionSegments()[0];
      expect(first).toBeDefined();
      classifier.script({ '0:0': [mode, 'ok'] });
      const report = await run();
      expect(report.status).toBe('succeeded');
      expect(
        classifier
          .calls()
          .filter((c) => c.first === '0:0')
          .map((c) => c.mode),
      ).toEqual([mode, 'ok']);
    },
  );

  it('gives up on a window after the bounded retries and keeps the other windows', async () => {
    classifier.script({ '0:0': ['missing'] });
    const report = await run();
    expect(report.status).toBe('failed');
    expect(outcome(report).error).toMatchObject({ code: 'classification-windows-failed' });
    expect(outcome(report).error?.message).toContain('window 0');
    const calls = classifier.calls();
    expect(calls.filter((c) => c.first === '0:0')).toHaveLength(3);
    const otherWindows = new Set(calls.filter((c) => c.first !== '0:0').map((c) => c.first));
    expect(otherWindows.size).toBeGreaterThan(0);
    expect(finishedRuns()).toEqual([]);
    expect(transcribeRuns.runs).toBe(1);
  });

  it('redoes only the failed window on the next run, without retranscribing', async () => {
    classifier.script({ '0:0': ['missing'] });
    await run();
    const finishedBefore = new Set(
      classifier
        .calls()
        .filter((c) => c.first !== '0:0')
        .map((c) => c.first),
    );
    classifier.script({});
    classifier.clearCalls();

    const report = await run();
    expect(report.status).toBe('succeeded');
    expect(classifier.calls().map((c) => c.first)).toEqual(['0:0']);
    expect(finishedBefore.has('0:0')).toBe(false);
    expect(transcribeRuns.runs).toBe(1);
    const [runId] = finishedRuns();
    if (runId === undefined) throw new Error('no run');
    expect(resultsOf(runId)).toHaveLength(200);
    expect(readdirSync(classifyDir()).filter((name) => name.startsWith('.'))).toEqual([]);
  });

  it('is up to date on a second run and makes no new call', async () => {
    await run();
    classifier.clearCalls();
    const again = await run();
    expect(outcome(again).action).toBe('up-to-date');
    expect(classifier.calls()).toEqual([]);
  });

  it('stops at once when the provider itself refuses, without burning other windows', async () => {
    classifier.script({ '0:0': ['not-logged-in'] });
    const report = await run();
    expect(report.status).toBe('failed');
    expect(outcome(report).error?.code).toBe('llm-not-logged-in');
    expect(classifier.calls()).toHaveLength(1);
  });

  it('refuses a speaker missing from campaign.yaml before any call', async () => {
    const segments = [segment(0, 0, 'stranger', 0, 'quem sou eu')];
    const report = await run(stages(segments));
    expect(report.status).toBe('failed');
    expect(outcome(report).error?.code).toBe('consent-missing');
    expect(classifier.calls()).toEqual([]);
  });

  it('fails when the transcript no longer matches the hash its job recorded', async () => {
    await runStage({
      db: fx.db,
      campaignId: CAMPAIGN,
      sessionId: SESSION,
      stage: 'transcribe',
      stages: stages(),
      paths: fx.paths,
      config: config(),
      logger: fx.logger,
      sleep: noSleep,
    });
    writeFileSync(path.join(root, 'transcript', RUN_ID, 'segments.jsonl'), '{}\n');
    const report = await run();
    expect(report.status).toBe('failed');
    expect(outcome(report).error?.code).toBe('transcript-changed');
    expect(classifier.calls()).toEqual([]);
  });

  it('keeps injection text inside the data blocks', async () => {
    const texts = probes();
    const segments = texts.map((text, i) => segment(0, i, 'gm', i * 5_000, text));
    expect((await run(stages(segments))).status).toBe('succeeded');
    const [call] = classifier.calls();
    if (call === undefined) throw new Error('no call');
    const blocks = call.prompt.match(/<untrusted-data-[0-9a-f]+ name="/g) ?? [];
    expect(blocks).toHaveLength(4);
    const instructions = call.prompt.slice(0, call.prompt.indexOf('<untrusted-data-'));
    for (const text of texts) expect(instructions).not.toContain(text);
  });

  it('never logs transcript text', async () => {
    classifier.script({ '0:0': ['bad-schema'] });
    await run();
    const logged = fx.logLines.join('\n');
    expect(logged).toContain('classify.window-failed');
    expect(logged).not.toMatch(/linha sintetica|Kira|farol/);
  });
});

describe('classification after the audio is purged (ADR-006)', () => {
  function fullStages(control: string) {
    return defineStages([...stagesFor(control).values(), createClassifyStage(classifier.options)]);
  }

  async function runFull(control: string, stage: string): Promise<RunReport> {
    return runStage({
      db: fx.db,
      campaignId: CAMPAIGN,
      sessionId: SESSION,
      stage,
      stages: fullStages(control),
      paths: fx.paths,
      config: config(),
      logger: fx.logger,
      sleep: noSleep,
    });
  }

  function whisperControl(): string {
    const file = path.join(fx.dir, 'whisper-control.json');
    writeFileSync(file, JSON.stringify({ log: path.join(fx.dir, 'whisper.log'), chunks: {} }));
    return file;
  }

  it('runs from the existing transcription, without whisper or ffmpeg', async () => {
    await writeSealedSession(root);
    const control = whisperControl();
    expect((await runFull(control, 'transcribe')).status).toBe('succeeded');
    await purgeAudio(root, { reason: 'operator-request' });

    const report = await runFull(control, 'classify');
    expect(report.status).toBe('succeeded');
    expect(report.stages.map((s) => [s.stage, s.action, s.reason])).toEqual([
      ['chunk-plan', 'up-to-date', 'source-purged'],
      ['transcribe', 'up-to-date', 'source-purged'],
      ['classify', 'succeeded', 'never-run'],
    ]);
    const validated = await validatePackage(root);
    expect(validated.lifecycle).toBe('audio-purged');
    expect(validated.ok).toBe(true);
  });

  it('can reclassify a purged package when the classification input changes', async () => {
    await writeSealedSession(root);
    const control = whisperControl();
    await runFull(control, 'classify');
    await purgeAudio(root, { reason: 'operator-request' });
    classifier.clearCalls();
    const report = await runStage({
      db: fx.db,
      campaignId: CAMPAIGN,
      sessionId: SESSION,
      stage: 'classify',
      force: true,
      stages: fullStages(control),
      paths: fx.paths,
      config: config(),
      logger: fx.logger,
      sleep: noSleep,
    });
    expect(outcome(report).action).toBe('succeeded');
    expect(finishedRuns()).toHaveLength(2);
  });

  it('still refuses to transcribe once the audio is gone', async () => {
    await writeSealedSession(root);
    const control = whisperControl();
    await runFull(control, 'transcribe');
    await purgeAudio(root, { reason: 'operator-request' });
    await expect(runFull(control, 'transcribe')).rejects.toMatchObject({
      code: 'JOB_INVALID_INPUT',
    });
  });

  it('says so when the audio is purged and nothing was ever transcribed', async () => {
    await writeSealedSession(root);
    await purgeAudio(root, { reason: 'operator-request' });
    await expect(runFull(whisperControl(), 'classify')).rejects.toMatchObject({
      code: 'JOB_INVALID_INPUT',
      message: expect.stringContaining('purged') as string,
    });
  });
});

describe('segment fixtures', () => {
  it('use minutes the windows can cut', () => {
    expect(sessionSegments().at(-1)?.start_offset_ms).toBeGreaterThan(90 * MINUTE);
  });
});
