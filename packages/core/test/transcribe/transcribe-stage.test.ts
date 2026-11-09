import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateContract,
  type CampaignConfig,
  type ChunkPlan,
  type Glossary,
  type TranscriptionSegment,
} from '@sargas-recap/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { latestJob, runStage, type RunOptions, type RunReport } from '../../src/jobs/index.ts';
import { purgeAudio, sha256File, validatePackage } from '../../src/package/index.ts';
import { parseChunkPlan, retranscribe } from '../../src/transcribe/index.ts';
import type { TranscribeStageOptions } from '../../src/transcribe/index.ts';
import { campaign as campaignFixture, glossary as glossaryFixture } from '../config/helpers.ts';
import { noSleep, openFixture, runConfig, type Fixture } from '../jobs/helpers.ts';
import { CAMPAIGN, SESSION, stagesFor, writeSealedSession } from './whisper-helpers.ts';

const WORKER = fileURLToPath(new URL('./resume-worker.ts', import.meta.url));

interface Call {
  readonly chunk: number;
  readonly model: string;
  readonly language: string;
  readonly prompt: string | null;
  readonly full: boolean;
  readonly viaResponseFile: boolean;
}

interface Script {
  failTimes?: number;
  hang?: boolean;
  killParent?: boolean;
  corruptFile?: string;
  raw?: string;
  segments?: unknown[];
}

let fx: Fixture;
let root: string;
let controlFile: string;
let logFile: string;

function control(chunks: Record<number, Script> = {}): void {
  writeFileSync(controlFile, JSON.stringify({ log: logFile, chunks }));
}

function calls(): Call[] {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Call);
}

function clearCalls(): void {
  writeFileSync(logFile, '');
}

function campaign(asr?: CampaignConfig['asr']): CampaignConfig {
  const base = campaignFixture();
  return asr === undefined ? base : { ...base, asr };
}

interface RunArgs {
  readonly asr?: CampaignConfig['asr'];
  readonly glossary?: Glossary;
  readonly campaign?: CampaignConfig;
  readonly stage?: Partial<TranscribeStageOptions>;
  readonly options?: Partial<RunOptions>;
}

function run(args: RunArgs = {}): Promise<RunReport> {
  return runStage({
    db: fx.db,
    campaignId: CAMPAIGN,
    sessionId: SESSION,
    stage: 'transcribe',
    stages: stagesFor(controlFile, args.stage),
    paths: fx.paths,
    config: runConfig(args.campaign ?? campaign(args.asr), args.glossary ?? glossaryFixture()),
    logger: fx.logger,
    sleep: noSleep,
    ...args.options,
  });
}

function outcome(report: RunReport): RunReport['stages'][number] {
  const last = report.stages.at(-1);
  if (last === undefined) throw new Error('no stages ran');
  return last;
}

function plan(): ChunkPlan {
  const dir = path.join(root, 'chunk-plans');
  const name = readdirSync(dir)[0];
  if (name === undefined) throw new Error('no plan');
  return parseChunkPlan(readFileSync(path.join(dir, name), 'utf8'));
}

function currentRun(): string {
  const job = latestJob(fx.db, CAMPAIGN, SESSION, 'transcribe', 'succeeded');
  if (job?.outputRunId === undefined) throw new Error('no succeeded run');
  return job.outputRunId;
}

function segmentsOf(runId: string): TranscriptionSegment[] {
  return readFileSync(path.join(root, 'transcript', runId, 'segments.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as TranscriptionSegment);
}

function transcriptEntries(): string[] {
  return readdirSync(path.join(root, 'transcript'));
}

async function audioHashes(): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const speaker of readdirSync(path.join(root, 'audio'))) {
    for (const name of readdirSync(path.join(root, 'audio', speaker))) {
      const file = path.join(root, 'audio', speaker, name);
      hashes[`${speaker}/${name}`] = (await sha256File(file)).hash;
    }
  }
  return hashes;
}

const seg = (from: number, to: number, text: string, p = 0.9): Record<string, unknown> => ({
  offsets: { from, to },
  text,
  tokens: [
    { text: '[_BEG_]', p: 0.01 },
    { text, p },
  ],
});

beforeEach(async () => {
  fx = await openFixture();
  root = fx.paths.sessionDir(CAMPAIGN, SESSION);
  mkdirSync(root, { recursive: true });
  await writeSealedSession(root);
  controlFile = path.join(fx.dir, 'control.json');
  logFile = path.join(fx.dir, 'calls.log');
  control();
});

afterEach(() => {
  fx.cleanup();
});

describe('transcribe through the job runner', () => {
  it('writes immutable, schema-valid segments and keeps the raw output', async () => {
    const report = await run();
    expect(report.status).toBe('succeeded');
    const runId = currentRun();
    expect(transcriptEntries()).toEqual([runId]);

    const chunks = plan().chunks;
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    const segments = segmentsOf(runId);
    expect(segments).toHaveLength(chunks.length);
    for (const segment of segments) {
      expect(validateContract('transcription-segment', segment).ok).toBe(true);
      expect(segment.segment_id).toBe(`${runId}:${String(segment.chunk_index)}:0`);
      expect(segment.language).toBe('pt');
      expect(segment.timing_uncertainty_ms).toBeGreaterThanOrEqual(50);
    }

    const raw = readdirSync(path.join(root, 'transcript', runId, 'raw')).sort();
    expect(raw).toEqual(chunks.map((c) => `chunk-${String(c.chunk_index)}.json`).sort());
    expect(existsSync(path.join(root, 'transcript', runId, 'work'))).toBe(false);

    const validated = await validatePackage(root);
    expect(validated.ok).toBe(true);
    expect(validated.issues).toEqual([]);

    const job = latestJob(fx.db, CAMPAIGN, SESSION, 'transcribe', 'succeeded');
    expect(job?.outputs).toEqual([
      {
        path: `transcript/${runId}/segments.jsonl`,
        hash: (await sha256File(path.join(root, 'transcript', runId, 'segments.jsonl'))).hash,
      },
    ]);
  });

  it('calls whisper once per chunk with the language and the glossary prompt', async () => {
    await run();
    const made = calls();
    expect(made.map((c) => c.chunk)).toEqual(plan().chunks.map((c) => c.chunk_index));
    for (const call of made) {
      expect(call.language).toBe('pt');
      expect(call.full).toBe(true);
      expect(call.model).toBe('fake-model.bin');
      expect(call.prompt).toContain('Sarenrae');
      expect(call.prompt).toContain('Kyra');
    }
  });

  it('sends an accented prompt to whisper intact on Windows, through a response file', async () => {
    const glossary = glossaryFixture();
    const first = glossary.entries[0];
    if (first === undefined) throw new Error('no entries');
    first.spelling = 'Zéfirão';
    await run({ glossary, stage: { platform: 'win32' } });
    for (const call of calls()) {
      expect(call.viaResponseFile).toBe(true);
      expect(call.prompt).toContain('Zéfirão');
    }
    expect(transcriptEntries().filter((name) => name.includes('.args'))).toEqual([]);
  });

  it('leaves the original audio byte-identical', async () => {
    const before = await audioHashes();
    await run();
    expect(await audioHashes()).toEqual(before);
    expect((await validatePackage(root)).ok).toBe(true);
  });

  it('fails instead of publishing a run when the audio changed during it', async () => {
    await planOnly();
    control({
      [plan().chunks[1]?.chunk_index ?? 1]: {
        corruptFile: path.join(root, 'audio', 'gm', '0.wav'),
      },
    });
    const report = await run();
    expect(outcome(report).action).toBe('failed');
    expect(outcome(report).error?.code).toBe('package-invalid');
    expect(transcriptEntries().filter((name) => !name.startsWith('.'))).toEqual([]);
  });

  it('is up to date on a second run and does not call whisper again', async () => {
    await run();
    const before = calls().length;
    const again = await run();
    expect(outcome(again).action).toBe('up-to-date');
    expect(calls()).toHaveLength(before);
  });

  it('maps through the chunk plan, across a removed pause', async () => {
    await planOnly();
    const multi = plan().chunks.find((c) => c.pieces.length > 1);
    if (multi === undefined) throw new Error('the fixture should produce a multi-piece chunk');
    const first = multi.pieces[0];
    if (first === undefined) throw new Error('no piece');
    const junction = first.chunk_start_ms + first.duration_ms;
    control({
      [multi.chunk_index]: { segments: [seg(junction - 500, junction + 500, ' sim', 0.9)] },
    });
    await run();
    const segment = segmentsOf(currentRun()).find((s) => s.chunk_index === multi.chunk_index);
    expect(segment?.source_spans).toHaveLength(2);
    expect(segment?.chunk_start_ms).toBe(junction - 500);
    expect(segment?.start_offset_ms).toBe(first.session_start_offset_ms + first.duration_ms - 500);
    // Crossing the removed pause: more than 1 s of session time for 1 s of chunk time.
    const span = (segment?.end_offset_ms ?? 0) - (segment?.start_offset_ms ?? 0);
    expect(span).toBeGreaterThan(1_000);
    expect(segment?.flags).not.toContain('timestamp_clamped');
  });

  it('clamps invalid timestamps, flags them and keeps the segments', async () => {
    await planOnly();
    const chunk = plan().chunks[0];
    if (chunk === undefined) throw new Error('no chunk');
    const d = chunk.duration_ms;
    control({
      [chunk.chunk_index]: {
        segments: [
          seg(100, 900, ' ok'),
          seg(700, 400, ' fim antes do inicio'),
          seg(-50, 300, ' negativo'),
          seg(d - 100, d + 500, ' passa do fim'),
          { text: ' sem tempos', tokens: [] },
          seg(1, 2, '   '),
        ],
      },
    });
    const report = await run();
    expect(report.status).toBe('succeeded');
    const segments = segmentsOf(currentRun()).filter((s) => s.chunk_index === chunk.chunk_index);
    expect(segments.map((s) => s.text_original)).toEqual([
      'ok',
      'fim antes do inicio',
      'negativo',
      'passa do fim',
      'sem tempos',
    ]);
    expect(segments.map((s) => s.flags.includes('timestamp_clamped'))).toEqual([
      false,
      true,
      true,
      true,
      true,
    ]);
    for (const segment of segments) {
      expect(segment.chunk_end_ms).toBeGreaterThanOrEqual(segment.chunk_start_ms);
      expect(segment.chunk_end_ms).toBeLessThanOrEqual(d);
      expect(validateContract('transcription-segment', segment).ok).toBe(true);
    }
    const starts = segments.map((s) => s.chunk_start_ms);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it('flags short and low-confidence segments using the configured thresholds', async () => {
    await planOnly();
    const chunk = plan().chunks[0];
    if (chunk === undefined) throw new Error('no chunk');
    control({
      [chunk.chunk_index]: {
        segments: [seg(0, 400, ' curto'), seg(500, 2500, ' incerto', 0.5)],
      },
    });
    await run();
    const flags = (): TranscriptionSegment['flags'][] =>
      segmentsOf(currentRun())
        .filter((s) => s.chunk_index === chunk.chunk_index)
        .map((s) => s.flags);
    expect(flags()).toEqual([['short'], ['low_confidence']]);
    await run({ asr: { short_segment_ms: 300, low_confidence_mean_permille: 400 } });
    expect(flags()).toEqual([[], []]);
  });

  it('flags a repetition loop and keeps every word', async () => {
    await planOnly();
    const chunk = plan().chunks[0];
    if (chunk === undefined) throw new Error('no chunk');
    const passage = 'o dragao dorme sob a torre antiga e ninguem ousa acordar a fera';
    const loop = Array.from({ length: 8 }, (_, i) => seg(i * 300, i * 300 + 290, ` ${passage}.`));
    control({
      [chunk.chunk_index]: {
        segments: [seg(0, 100, ' uma frase normal antes'), ...loop],
      },
    });
    await run({ asr: { short_segment_ms: 1 } });
    const segments = segmentsOf(currentRun()).filter((s) => s.chunk_index === chunk.chunk_index);
    expect(segments).toHaveLength(9);
    expect(segments[0]?.flags).toEqual([]);
    for (const segment of segments.slice(1)) {
      expect(segment.flags).toContain('repetition_loop');
      expect(segment.text_original).toBe(`${passage}.`);
    }
  });

  it('does not log transcript text', async () => {
    await run();
    expect(fx.logLines.join('\n')).not.toContain('sintetica');
    expect(fx.logLines.join('\n')).toContain('transcribe.finished');
    expect(fx.logLines.find((l) => l.includes('transcribe.finished'))).not.toContain('redacted');
  });

  it('refuses a speaker missing from the campaign before any whisper call', async () => {
    const without = campaignFixture();
    without.speakers = without.speakers.filter((s) => s.speaker_id !== 'player-ana');
    const report = await run({ campaign: without });
    expect(outcome(report).action).toBe('failed');
    expect(outcome(report).error?.code).toBe('consent-missing');
    expect(calls()).toEqual([]);
  });

  it('refuses when consent for a chunk has been withdrawn since the run started', async () => {
    const withdrawn = campaignFixture();
    for (const speaker of withdrawn.speakers) {
      if (speaker.speaker_id === 'gm') continue;
      for (const record of speaker.consent ?? []) {
        if (record.purpose === 'asr') record.withdrawn_on = '2035-06-01';
      }
    }
    const report = await run({
      campaign: withdrawn,
      stage: { now: () => new Date('2036-01-01T00:00:00Z') },
    });
    expect(outcome(report).action).toBe('failed');
    expect(outcome(report).error?.code).toBe('consent-missing');
    expect(calls().every((c) => plan().chunks[c.chunk]?.speaker_id === 'gm')).toBe(true);
  });

  it('records a missing output as a retryable failure and does not keep bad JSON', async () => {
    await planOnly();
    const first = plan().chunks[0]?.chunk_index ?? 0;
    control({ [first]: { raw: 'not json' } });
    const report = await run({ options: { retry: { maxAttempts: 1 } } });
    expect(outcome(report).error).toMatchObject({
      code: 'whisper-output-invalid',
      retryable: true,
    });
    const unfinished = transcriptEntries();
    expect(unfinished).toHaveLength(1);
    expect(readdirSync(path.join(root, 'transcript', unfinished[0] ?? '', 'raw'))).toEqual([]);
  });

  it('stops a hung whisper at the timeout', async () => {
    await planOnly();
    control({ [plan().chunks[0]?.chunk_index ?? 0]: { hang: true } });
    const report = await run({
      asr: { timeout_base_ms: 200, timeout_audio_multiplier: 1 },
      options: { retry: { maxAttempts: 1 } },
    });
    expect(outcome(report).error).toMatchObject({ code: 'whisper-timeout', retryable: true });
  });

  it('cancels a running whisper and resumes later', async () => {
    await planOnly();
    const chunks = plan().chunks;
    control({ [chunks[1]?.chunk_index ?? 1]: { hang: true } });
    const controller = new AbortController();
    const running = run({ options: { signal: controller.signal } });
    while (calls().length < 2) await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    expect(outcome(await running).action).toBe('cancelled');

    control();
    clearCalls();
    expect((await run()).status).toBe('succeeded');
    expect(calls().map((c) => c.chunk)).toEqual(chunks.slice(1).map((c) => c.chunk_index));
  });
});

async function planOnly(): Promise<void> {
  await runStage({
    db: fx.db,
    campaignId: CAMPAIGN,
    sessionId: SESSION,
    stage: 'chunk-plan',
    stages: stagesFor(controlFile),
    paths: fx.paths,
    config: runConfig(campaign(), glossaryFixture()),
    logger: fx.logger,
    sleep: noSleep,
  });
}

describe('resuming', () => {
  it('retries a whisper crash without redoing finished chunks', async () => {
    await planOnly();
    const chunks = plan().chunks;
    control({ [chunks[1]?.chunk_index ?? 1]: { failTimes: 2 } });
    const report = await run();
    expect(report.status).toBe('succeeded');
    expect(outcome(report).attempts).toBe(3);
    const counts = new Map<number, number>();
    for (const call of calls()) counts.set(call.chunk, (counts.get(call.chunk) ?? 0) + 1);
    expect(counts.get(chunks[0]?.chunk_index ?? 0)).toBe(1);
    expect(counts.get(chunks[1]?.chunk_index ?? 1)).toBe(3);
  });

  it('resumes from the last finished chunk after the process is killed', async () => {
    await planOnly();
    const chunks = plan().chunks;
    const victim = chunks[1]?.chunk_index ?? 1;
    control({ [victim]: { killParent: true } });
    const campaignFile = path.join(fx.dir, 'campaign.json');
    const glossaryFile = path.join(fx.dir, 'glossary.json');
    writeFileSync(campaignFile, JSON.stringify(campaign()));
    writeFileSync(glossaryFile, JSON.stringify(glossaryFixture()));
    const exit = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [WORKER, fx.paths.root, controlFile, campaignFile, glossaryFile],
        { stdio: 'ignore' },
      );
      child.once('error', reject);
      child.once('close', resolve);
    });
    expect(exit).not.toBe(0);

    const finishedBefore = calls().map((c) => c.chunk);
    expect(finishedBefore).toEqual([chunks[0]?.chunk_index, victim]);
    const unfinished = transcriptEntries();
    expect(unfinished).toHaveLength(1);

    control();
    clearCalls();
    const report = await run();
    expect(report.recovered).toEqual([
      expect.objectContaining({ stage: 'transcribe', to: 'failed' }),
    ]);
    expect(outcome(report).reason).toBe('recovering');
    expect(report.status).toBe('succeeded');
    expect(calls().map((c) => c.chunk)).toEqual(chunks.slice(1).map((c) => c.chunk_index));

    const runId = currentRun();
    expect(unfinished[0]).toContain(runId);
    expect(transcriptEntries()).toEqual([runId]);
    expect(segmentsOf(runId)).toHaveLength(chunks.length);
    expect((await validatePackage(root)).ok).toBe(true);
  });

  it('never resumes with different inputs', async () => {
    await planOnly();
    const chunks = plan().chunks;
    control({ [chunks[1]?.chunk_index ?? 1]: { failTimes: 5 } });
    const failed = await run({ options: { retry: { maxAttempts: 1 } } });
    expect(failed.status).toBe('failed');
    const unfinishedBefore = transcriptEntries();
    expect(unfinishedBefore).toHaveLength(1);

    control();
    clearCalls();
    const other = glossaryFixture();
    other.entries = other.entries.slice(0, 1);
    expect((await run({ glossary: other })).status).toBe('succeeded');
    expect(calls().map((c) => c.chunk)).toEqual(chunks.map((c) => c.chunk_index));
    expect(transcriptEntries()).toEqual([currentRun()]);
  });

  it('removes an unfinished run when the audio is purged', async () => {
    await planOnly();
    control({ [plan().chunks[1]?.chunk_index ?? 1]: { failTimes: 5 } });
    await run({ options: { retry: { maxAttempts: 1 } } });
    expect(transcriptEntries()).toHaveLength(1);
    await purgeAudio(root, { reason: 'operator-request' });
    expect(transcriptEntries()).toEqual([]);
  });
});

describe('a changed ASR glossary', () => {
  function changedGlossary(): Glossary {
    const glossary = glossaryFixture();
    const first = glossary.entries[0];
    if (first === undefined) throw new Error('no entries');
    first.spelling = 'Zefirao';
    return glossary;
  }

  it('does not rerun or claim the old transcript used it', async () => {
    await run();
    const runId = currentRun();
    const before = readFileSync(path.join(root, 'transcript', runId, 'segments.jsonl'));
    const usedBefore = latestJob(fx.db, CAMPAIGN, SESSION, 'transcribe', 'succeeded')?.inputs;
    clearCalls();

    const report = await run({ glossary: changedGlossary() });
    expect(outcome(report).action).toBe('up-to-date');
    expect(outcome(report).staleReceipts).toEqual(['glossary:asr-prompt']);
    expect(calls()).toEqual([]);
    expect(currentRun()).toBe(runId);
    expect(latestJob(fx.db, CAMPAIGN, SESSION, 'transcribe', 'succeeded')?.inputs).toEqual(
      usedBefore,
    );
    expect(readFileSync(path.join(root, 'transcript', runId, 'segments.jsonl'))).toEqual(before);
  });

  it('applies it through retranscribe, as a new run beside the old one', async () => {
    await run();
    const oldRun = currentRun();
    const oldBytes = readFileSync(path.join(root, 'transcript', oldRun, 'segments.jsonl'));
    clearCalls();
    const glossary = changedGlossary();
    const config = runConfig(campaign(), glossary);
    const options = {
      db: fx.db,
      campaignId: CAMPAIGN,
      sessionId: SESSION,
      stages: stagesFor(controlFile),
      paths: fx.paths,
      config,
      logger: fx.logger,
      sleep: noSleep,
    };

    const result = await retranscribe(options);
    expect(result.status).toBe('ran');
    if (result.status !== 'ran') throw new Error('unreachable');
    expect(result.report.status).toBe('succeeded');
    expect(result.previousRunId).toBe(oldRun);
    expect(calls().every((c) => c.prompt?.includes('Zefirao') === true)).toBe(true);

    const newRun = currentRun();
    expect(newRun).not.toBe(oldRun);
    expect(transcriptEntries().sort()).toEqual([oldRun, newRun].sort());
    expect(readFileSync(path.join(root, 'transcript', oldRun, 'segments.jsonl'))).toEqual(oldBytes);
    expect(segmentsOf(newRun).every((s) => s.segment_id.startsWith(newRun))).toBe(true);
    const receipt = latestJob(fx.db, CAMPAIGN, SESSION, 'transcribe', 'succeeded')?.inputs.find(
      (i) => i.kind === 'glossary',
    );
    expect(receipt?.role).toBe('receipt');
    expect(receipt?.hash).toBe(config.version.stage_hashes.asr);

    // Same glossary again: nothing to do, and no new IDs.
    clearCalls();
    expect(await retranscribe(options)).toEqual({
      status: 'unchanged',
      transcriptionRunId: newRun,
    });
    expect(calls()).toEqual([]);
    // And a plain run sees it as current.
    const after = await run({ glossary });
    expect(outcome(after).action).toBe('up-to-date');
    expect(outcome(after).staleReceipts).toBeUndefined();
  });

  it('refuses after the audio was purged, because the audio is gone', async () => {
    await run();
    await purgeAudio(root, { reason: 'operator-request' });
    await expect(
      retranscribe({
        db: fx.db,
        campaignId: CAMPAIGN,
        sessionId: SESSION,
        stages: stagesFor(controlFile),
        paths: fx.paths,
        config: runConfig(campaign(), changedGlossary()),
        logger: fx.logger,
        sleep: noSleep,
      }),
    ).rejects.toMatchObject({ code: 'JOB_INVALID_INPUT' });
  });
});
