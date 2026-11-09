/**
 * The body of the `classify` stage (T11). Loaded on first use by classify-stage.ts.
 *
 * A run is built in a temporary directory beside `classify/<run>/` and renamed into place when
 * complete (ADR-006). Each window's finished records are written to `windows/` as soon as they
 * pass validation, so a failed window costs only itself: the temporary name embeds a hash of
 * everything that shapes the output, and the next `recap run classify` picks up where this left
 * off, redoing only the windows without a file. Earlier stages are not touched.
 */
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  validateContract,
  type ClassificationCorrectionsReport,
  type ClassificationResult,
  type TranscriptionSegment,
} from '@sargas-recap/contracts';
import { contentHash, stageDependencies } from '../config/index.ts';
import { JobError, StageError } from '../jobs/errors.ts';
import {
  configInput,
  modelInput,
  requireConfig,
  type InputContext,
  type StageContext,
  type StageResult,
} from '../jobs/stage.ts';
import type { JobInput, JobUsage } from '../jobs/store.ts';
import {
  addUsage,
  createLlmBackend,
  isLlmError,
  llmSystemPrompt,
  type LlmErrorCode,
} from '../llm/index.ts';
import {
  finalizeDirectory,
  realPackageRoot,
  resolveInsidePackage,
  sha256File,
  writeFileAtomic,
} from '../package/index.ts';
import {
  loadPromptRegistry,
  promptJobInput,
  type PromptAsset,
  type PromptRegistry,
} from '../prompts/index.ts';
import { openPartialRun, TRANSCRIPT_DIR } from '../transcribe/transcribe-run.ts';
import type { ClassifyStageOptions } from './classify-stage.ts';
import { glossarySpellings, type GlossarySpellings } from './corrections.ts';
import {
  coverageProblems,
  finalizeWindow,
  type FinishedWindow,
  type RunIdentity,
} from './finalize.ts';
import {
  DEFAULT_WINDOW_PARAMS,
  planWindows,
  windowData,
  windowSpeakers,
  type ClassificationWindow,
  type WindowParams,
} from './windows.ts';

export const CLASSIFY_DIR = 'classify';
const STAGE = 'classify';
/** Bump when the code that turns model output into records changes what it writes. */
export const CLASSIFIER_VERSION = 1;
const WINDOW_PROMPT = 'classification.window';

/**
 * Failures of this window's content. The next window may well succeed, so the run moves on. Every
 * other code (login, usage limit, missing binary, consent) would fail the rest the same way.
 */
const WINDOW_FAULTS: ReadonlySet<LlmErrorCode> = new Set([
  'llm-schema-invalid',
  'llm-non-json',
  'llm-refusal',
  'llm-max-tokens',
  'llm-output-too-large',
]);

/** Fields the stage logs. Counts only, never content. */
const LOG_FIELDS = ['windowIndex', 'windows', 'resumedWindows', 'failedWindows', 'segments'];

function requireSessionDir(ctx: Pick<InputContext, 'sessionDir'>): string {
  if (ctx.sessionDir === undefined) {
    throw new JobError('JOB_INVALID_INPUT', `stage ${STAGE} needs a session package directory`);
  }
  return ctx.sessionDir;
}

interface LoadedTranscript {
  readonly runId: string;
  readonly hash: string;
  readonly segments: readonly TranscriptionSegment[];
}

function parseSegments(text: string): TranscriptionSegment[] {
  const segments: TranscriptionSegment[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new StageError('transcript-invalid', `segments line ${String(index + 1)}: bad JSON`);
    }
    const result = validateContract('transcription-segment', value);
    if (!result.ok) {
      throw new StageError(
        'transcript-invalid',
        `segments line ${String(index + 1)} does not fit the contract`,
      );
    }
    segments.push(result.value);
  }
  return segments;
}

/** The current transcription run, proved unchanged against the hash its job recorded. */
async function loadTranscript(ctx: InputContext): Promise<LoadedTranscript> {
  const root = await realPackageRoot(requireSessionDir(ctx));
  const upstream = ctx.upstream.get('transcribe');
  const output = upstream?.outputs.find((o) => o.path.startsWith(`${TRANSCRIPT_DIR}/`));
  if (upstream?.outputRunId === undefined || output === undefined) {
    throw new JobError('JOB_INVALID_INPUT', `stage ${STAGE} needs a finished transcription`, {
      hint: 'run `recap run transcribe` first',
    });
  }
  const { absolute } = await resolveInsidePackage(root, output.path);
  const { hash } = await sha256File(absolute);
  if (hash !== output.hash) {
    throw new StageError(
      'transcript-changed',
      `${output.path} differs from what its transcription job recorded; runs are immutable (ADR-004)`,
    );
  }
  const segments = parseSegments(await readFile(absolute, 'utf8'));
  if (segments.length === 0) {
    throw new JobError('JOB_INVALID_INPUT', 'the transcription has no segments to classify');
  }
  return { runId: upstream.outputRunId, hash, segments };
}

/** Everyone whose words the run can send. Each window is then checked for its own speakers. */
export async function transcriptSpeakers(ctx: InputContext): Promise<string[]> {
  const { segments } = await loadTranscript(ctx);
  return [...new Set(segments.map((segment) => segment.speaker_id))];
}

function modelOf(ctx: InputContext): string {
  const { campaign } = requireConfig(ctx, STAGE);
  const model = campaign.llm_model?.classification;
  if (model === undefined) {
    throw new JobError('JOB_INVALID_INPUT', 'campaign.yaml has no llm_model.classification', {
      hint: 'set the explicit model ID to use',
    });
  }
  return model;
}

interface StagePrompts {
  readonly registry: PromptRegistry;
  readonly window: PromptAsset;
  readonly system: PromptAsset;
}

function loadPrompts(options: ClassifyStageOptions): StagePrompts {
  const registry = options.prompts ?? loadPromptRegistry();
  return {
    registry,
    window: registry.latest(WINDOW_PROMPT),
    system: llmSystemPrompt(registry, 'classification'),
  };
}

const paramsOf = (options: ClassifyStageOptions): WindowParams =>
  options.windowParams ?? DEFAULT_WINDOW_PARAMS;

function paramsHash(options: ClassifyStageOptions): string {
  return contentHash({ classifier_version: CLASSIFIER_VERSION, windows: paramsOf(options) });
}

export function classifyInputs(ctx: InputContext, options: ClassifyStageOptions): JobInput[] {
  const config = requireConfig(ctx, STAGE);
  const prompts = loadPrompts(options);
  const model = modelOf(ctx);
  return [
    promptJobInput(prompts.window),
    promptJobInput(prompts.system),
    configInput(config, 'classification'),
    modelInput(model, contentHash({ model })),
    { kind: 'config', ref: 'classify-params', hash: paramsHash(options) },
  ];
}

interface WindowFile {
  readonly finished: FinishedWindow;
  readonly usage: JobUsage;
}

const windowFile = (dir: string, index: number): string =>
  path.join(dir, `window-${String(index)}.json`);

/** A window finished by an earlier attempt, or undefined when it has to be (re)done. */
async function readFinished(
  file: string,
  window: ClassificationWindow,
  identity: RunIdentity,
): Promise<WindowFile | undefined> {
  let parsed: Partial<WindowFile> | null;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<WindowFile> | null;
  } catch {
    return undefined;
  }
  const raw: unknown = parsed?.finished?.records;
  const usage = parsed?.usage;
  if (parsed?.finished === undefined || usage === undefined || !Array.isArray(raw)) {
    return undefined;
  }
  const records: ClassificationResult[] = [];
  for (const item of raw as unknown[]) {
    const result = validateContract('classification-result', item);
    if (!result.ok) return undefined;
    records.push(result.value);
  }
  const expected = window.core.map((segment) => segment.segment_id).join('\n');
  const usable =
    records.map((record) => record.segment_id).join('\n') === expected &&
    records.every(
      (record) =>
        record.classification_run_id === identity.classificationRunId &&
        record.window_index === window.index,
    );
  return usable ? { finished: parsed.finished, usage } : undefined;
}

interface WindowRun {
  readonly ctx: StageContext;
  readonly window: ClassificationWindow;
  readonly file: string;
  readonly identity: RunIdentity;
  readonly spellings: GlossarySpellings;
  readonly prompt: PromptAsset;
  readonly campaignData: string;
  readonly backend: ReturnType<typeof createLlmBackend>;
}

async function classifyWindow(run: WindowRun): Promise<WindowFile> {
  const { ctx, window, identity, spellings } = run;
  const finalized: { value?: FinishedWindow } = {};
  const result = await run.backend.classify({
    prompt: run.prompt,
    data: { campaign: run.campaignData, ...windowData(window) },
    speakerIds: windowSpeakers(window),
    signal: ctx.signal,
    validate: (output) => {
      const outcome = finalizeWindow(window, output, identity, spellings);
      if (!outcome.ok) return outcome.problems;
      finalized.value = outcome.window;
      return [];
    },
  });
  if (finalized.value === undefined) {
    throw new StageError('classification-incomplete', 'a window finished with no records');
  }
  const done: WindowFile = { finished: finalized.value, usage: result.usage };
  await writeFileAtomic(run.file, `${JSON.stringify(done)}\n`);
  return done;
}

function assertComplete(
  segments: readonly TranscriptionSegment[],
  records: readonly ClassificationResult[],
): void {
  const problems = coverageProblems(segments, records);
  if (problems.length > 0) {
    throw new StageError(
      'classification-incomplete',
      `the finished windows do not cover the transcript (${String(problems.length)} problems)`,
    );
  }
}

export async function runClassify(
  ctx: StageContext,
  options: ClassifyStageOptions,
): Promise<StageResult> {
  const root = requireSessionDir(ctx);
  const config = requireConfig(ctx, STAGE);
  const { campaign, glossary } = config;
  const transcript = await loadTranscript(ctx);
  const prompts = loadPrompts(options);
  const windows = planWindows(transcript.segments, paramsOf(options));
  const key = contentHash({
    transcript: transcript.hash,
    window_prompt: prompts.window.hash,
    system_prompt: prompts.system.hash,
    model: modelOf(ctx),
    config: config.version.stage_hashes.classification,
    params: paramsHash(options),
  })
    .slice('sha256:'.length)
    .slice(0, 16);

  const realRoot = await realPackageRoot(root);
  const classifyDir = (await resolveInsidePackage(realRoot, CLASSIFY_DIR)).absolute;
  await mkdir(classifyDir, { recursive: true });
  const partial = await openPartialRun(classifyDir, key, (options.now ?? (() => new Date()))());
  const windowsDir = path.join(partial.dir, 'windows');
  await mkdir(windowsDir, { recursive: true });
  const identity: RunIdentity = {
    classificationRunId: partial.runId,
    transcriptionRunId: transcript.runId,
  };

  const backend = createLlmBackend({
    campaign,
    prompts: prompts.registry,
    logger: ctx.logger,
    retry: { maxAttempts: ctx.maxAttempts },
    ...options.llm,
  });
  const spellings = glossarySpellings(glossary);
  const { language, system, speakers, entries } = stageDependencies(
    'classification',
    campaign,
    glossary,
  );
  // Exactly what the classification config hash covers, so a change to it reruns this stage.
  const campaignData = JSON.stringify({ language, system, speakers, glossary: entries });
  const logger = ctx.logger.child(LOG_FIELDS);

  const finished = new Map<number, WindowFile>();
  const failed: number[] = [];
  let resumed = 0;
  for (const window of windows) {
    const file = windowFile(windowsDir, window.index);
    const existing = await readFinished(file, window, identity);
    if (existing !== undefined) {
      finished.set(window.index, existing);
      resumed += 1;
      continue;
    }
    try {
      finished.set(
        window.index,
        await classifyWindow({
          ctx,
          window,
          file,
          identity,
          spellings,
          prompt: prompts.window,
          campaignData,
          backend,
        }),
      );
    } catch (error) {
      if (!isLlmError(error) || !WINDOW_FAULTS.has(error.code)) throw error;
      failed.push(window.index);
      logger.warn('classify.window-failed', {
        stage: STAGE,
        windowIndex: window.index,
        errorCode: error.code,
      });
    }
  }
  if (failed.length > 0) {
    throw new StageError(
      'classification-windows-failed',
      `${String(failed.length)} of ${String(windows.length)} windows failed validation (window ${failed.join(', ')}); the others are kept, and running classify again redoes only these`,
    );
  }

  const inOrder = windows.map((window) => {
    const done = finished.get(window.index);
    if (done === undefined) throw new Error('a window has no result');
    return done;
  });
  const records = inOrder.flatMap(({ finished: f }) => f.records);
  assertComplete(transcript.segments, records);

  const report: ClassificationCorrectionsReport = {
    schema_version: 1,
    classification_run_id: partial.runId,
    transcription_run_id: transcript.runId,
    fixed: inOrder.flatMap(({ finished: f }) => f.fixed),
    unmatched: inOrder.flatMap(({ finished: f }) => f.unmatched),
    rejected: inOrder.flatMap(({ finished: f }) => f.rejected),
  };
  if (!validateContract('classification-corrections-report', report).ok) {
    throw new StageError('classification-incomplete', 'the corrections report is not valid');
  }
  await writeFileAtomic(
    path.join(partial.dir, 'results.jsonl'),
    records.map((record) => `${JSON.stringify(record)}\n`).join(''),
  );
  await writeFileAtomic(
    path.join(partial.dir, 'corrections-report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );

  const finalDir = path.join(classifyDir, partial.runId);
  await finalizeDirectory(partial.dir, finalDir);
  const resultsHash = (await sha256File(path.join(finalDir, 'results.jsonl'))).hash;
  const reportHash = (await sha256File(path.join(finalDir, 'corrections-report.json'))).hash;
  logger.info('classify.finished', {
    stage: STAGE,
    runId: partial.runId,
    windows: windows.length,
    resumedWindows: resumed,
    failedWindows: 0,
    segments: records.length,
    count: report.fixed.length,
  });
  return {
    outputRunId: partial.runId,
    outputs: [
      { path: `${CLASSIFY_DIR}/${partial.runId}/results.jsonl`, hash: resultsHash },
      { path: `${CLASSIFY_DIR}/${partial.runId}/corrections-report.json`, hash: reportHash },
    ],
    usage: inOrder.reduce<JobUsage>((sum, { usage }) => addUsage(sum, usage), {
      input_tokens: 0,
      output_tokens: 0,
    }),
  };
}
