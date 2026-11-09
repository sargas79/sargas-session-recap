/**
 * The body of the `recap` stage (T13). Loaded on first use by recap-stage.ts.
 *
 * Refuses before any provider call while a spoiler or privacy exclusion is unreconciled (ADR-005,
 * point 7). Only segments whose effective `recap_inclusion` is `include` reach the prompt. The
 * revision is allocated after the model's output has passed validation, so a failed attempt costs
 * no number, and the directory is built beside `recap/<revision>/` and renamed into place.
 */
import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { EffectiveTranscriptReview } from '@sargas-recap/contracts';
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
import type { JobInput } from '../jobs/store.ts';
import { createLlmBackend, llmSystemPrompt } from '../llm/index.ts';
import {
  finalizeDirectory,
  isAtomicTempName,
  realPackageRoot,
  resolveInsidePackage,
  sha256File,
  tempDirFor,
  writeFileAtomic,
} from '../package/index.ts';
import {
  loadPromptRegistry,
  promptJobInput,
  type PromptAsset,
  type PromptRegistry,
} from '../prompts/index.ts';
import {
  isReviewError,
  loadSessionReview,
  unreconciledExclusions,
  type SessionRef,
} from '../review/index.ts';
import {
  buildRecap,
  finalizeRecapOutput,
  finishedRecapProblems,
  type RecapDraft,
  type RecapIdentity,
} from './citations.ts';
import {
  evidenceOf,
  segmentsData,
  selectRecapInput,
  speakersOf,
  type RecapInput,
} from './evidence.ts';
import { loadPreviousRecaps, previousRecapsData, type PreviousRecap } from './previous.ts';
import type { RecapStageOptions } from './recap-stage.ts';
import { renderGmNotesMarkdown, renderRecapMarkdown, type SegmentSources } from './render.ts';
import { allocateRecapRevision } from './revisions.ts';

export const RECAP_DIR = 'recap';
const STAGE = 'recap';
/** Bump when the code that turns model output into records changes what it writes. */
export const RECAP_GENERATOR_VERSION = 1;
const TASK_PROMPT = 'recap.draft';
/** Prompt v2 asks for Portuguese. Another language needs its own prompt version. */
const PORTUGUESE = /^pt(?:-[A-Z]{2})?$/;

/** Fields the stage logs. Counts only, never content. */
const LOG_FIELDS = ['recapRevision', 'sentences', 'gmNotes', 'segments', 'unresolved', 'previous'];

function sessionRef(ctx: InputContext, options: RecapStageOptions): SessionRef {
  if (ctx.paths === undefined) {
    throw new JobError('JOB_INVALID_INPUT', `stage ${STAGE} needs a data root`);
  }
  return {
    db: ctx.db,
    paths: ctx.paths,
    campaignId: ctx.campaignId,
    sessionId: ctx.sessionId,
    now: options.now,
  };
}

/** The effective transcript. A broken run is a job error: its message names IDs and paths only. */
async function loadView(
  ctx: InputContext,
  options: RecapStageOptions,
): Promise<EffectiveTranscriptReview> {
  try {
    return (await loadSessionReview(sessionRef(ctx, options))).view;
  } catch (error) {
    if (!isReviewError(error)) throw error;
    throw new JobError('JOB_INVALID_INPUT', error.message, {
      ...(error.hint === undefined ? {} : { hint: error.hint }),
    });
  }
}

/** Everything that stops a recap before the provider is involved. */
function assertGeneratable(ctx: InputContext, view: EffectiveTranscriptReview): RecapInput {
  const lost = unreconciledExclusions(view);
  if (lost.length > 0) {
    throw new StageError(
      'recap-unreconciled-exclusions',
      `${String(lost.length)} spoiler or privacy exclusion(s) no longer apply to any segment; reconcile or discard them first (\`recap overrides list\`)`,
    );
  }
  if (view.classification_run_id === null) {
    throw new StageError(
      'recap-no-classification',
      'the active transcription has no classification; run `recap run classify` first',
    );
  }
  const { language } = requireConfig(ctx, STAGE).campaign;
  if (!PORTUGUESE.test(language)) {
    throw new StageError(
      'recap-language-unsupported',
      `the recap prompt writes Portuguese, but campaign.yaml says language ${language}`,
    );
  }
  const input = selectRecapInput(view);
  if (input.included.length === 0) {
    throw new StageError(
      'recap-no-eligible-segments',
      'no segment is included in the recap; review the session with `recap overrides effective`',
    );
  }
  return input;
}

/** Everyone whose words the provider call carries, including those behind earlier recaps. */
export async function recapSpeakers(
  ctx: InputContext,
  options: RecapStageOptions,
): Promise<string[]> {
  const input = assertGeneratable(ctx, await loadView(ctx, options));
  const previous = await loadPreviousRecaps(sessionRef(ctx, options));
  return callSpeakers(input, previous);
}

function callSpeakers(input: RecapInput, previous: readonly PreviousRecap[]): string[] {
  return [
    ...new Set([...speakersOf(input.included), ...previous.flatMap((p) => p.speakerIds)]),
  ].sort();
}

function modelOf(ctx: InputContext): string {
  const model = requireConfig(ctx, STAGE).campaign.llm_model?.recap;
  if (model === undefined) {
    throw new JobError('JOB_INVALID_INPUT', 'campaign.yaml has no llm_model.recap', {
      hint: 'set the explicit model ID to use',
    });
  }
  return model;
}

interface StagePrompts {
  readonly registry: PromptRegistry;
  readonly task: PromptAsset;
  readonly system: PromptAsset;
}

function loadPrompts(options: RecapStageOptions): StagePrompts {
  const registry = options.prompts ?? loadPromptRegistry();
  return {
    registry,
    task: registry.latest(TASK_PROMPT),
    system: llmSystemPrompt(registry, 'recap'),
  };
}

/** Exactly what the prompt can show of the GM's decisions, so a change to it reruns the stage. */
function overridesHash(view: EffectiveTranscriptReview): string {
  const { included, unresolved } = selectRecapInput(view);
  return contentHash({
    included: included.map((s) => ({ id: s.segment_id, text: s.text, label: s.label })),
    unresolved: unresolved.map((s) => s.segment_id),
  });
}

export async function recapInputs(
  ctx: InputContext,
  options: RecapStageOptions,
): Promise<JobInput[]> {
  const config = requireConfig(ctx, STAGE);
  const prompts = loadPrompts(options);
  const model = modelOf(ctx);
  const view = await loadView(ctx, options);
  return [
    promptJobInput(prompts.task),
    promptJobInput(prompts.system),
    configInput(config, 'recap'),
    modelInput(model, contentHash({ model })),
    { kind: 'overrides', ref: 'effective-transcript', hash: overridesHash(view) },
    {
      kind: 'config',
      ref: 'recap-params',
      hash: contentHash({ recap_generator_version: RECAP_GENERATOR_VERSION }),
    },
  ];
}

/** The earlier recaps used: recorded, but regenerating one must not rerun every later session. */
export async function recapReceipts(
  ctx: InputContext,
  options: RecapStageOptions,
): Promise<JobInput[]> {
  const previous = await loadPreviousRecaps(sessionRef(ctx, options));
  return previous.map((recap) => ({
    kind: 'artifact',
    ref: `previous-recap/${recap.sessionId}/${String(recap.revision)}`,
    hash: recap.hash,
  }));
}

/** Exactly what the recap config hash covers, minus the provider. */
function campaignData(ctx: InputContext): string {
  const { campaign, glossary } = requireConfig(ctx, STAGE);
  const { language, system, background, speakers, entries } = stageDependencies(
    'recap',
    campaign,
    glossary,
  );
  return JSON.stringify({ language, system, background, speakers, glossary: entries });
}

function identityOf(
  ctx: InputContext,
  view: EffectiveTranscriptReview,
  classificationRunId: string,
  now: Date,
): RecapIdentity {
  return {
    campaignId: ctx.campaignId,
    sessionId: ctx.sessionId,
    transcriptionRunId: view.transcription_run_id,
    classificationRunId,
    language: requireConfig(ctx, STAGE).campaign.language,
    generatedAt: now.toISOString(),
  };
}

function sourcesOf(view: EffectiveTranscriptReview): SegmentSources {
  return new Map(
    view.segments.map((s) => [
      s.segment_id,
      { speakerId: s.speaker_id, startOffsetMs: s.start_offset_ms },
    ]),
  );
}

/** A crash can leave a temporary directory behind; none of them is ever resumed. */
async function removeLeftovers(recapDir: string): Promise<void> {
  for (const name of await readdir(recapDir)) {
    if (isAtomicTempName(name)) {
      await rm(path.join(recapDir, name), {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    }
  }
}

const OUTPUT_FILES = ['recap.json', 'recap.md', 'gm-notes.md'] as const;

async function writeRevision(
  recapDir: string,
  revision: number,
  contents: Readonly<Record<(typeof OUTPUT_FILES)[number], string>>,
): Promise<StageResult['outputs']> {
  const finalDir = path.join(recapDir, String(revision));
  const temp = tempDirFor(finalDir);
  await mkdir(temp);
  for (const file of OUTPUT_FILES) await writeFileAtomic(path.join(temp, file), contents[file]);
  await finalizeDirectory(temp, finalDir);
  const outputs = [];
  for (const file of OUTPUT_FILES) {
    outputs.push({
      path: `${RECAP_DIR}/${String(revision)}/${file}`,
      hash: (await sha256File(path.join(finalDir, file))).hash,
    });
  }
  return outputs;
}

export async function runRecap(
  ctx: StageContext,
  options: RecapStageOptions,
): Promise<StageResult> {
  const { campaign } = requireConfig(ctx, STAGE);
  const view = await loadView(ctx, options);
  const input = assertGeneratable(ctx, view);
  const classificationRunId = view.classification_run_id;
  if (classificationRunId === null) throw new Error('classification checked above');
  const ref = sessionRef(ctx, options);
  const previous = await loadPreviousRecaps(ref);
  const prompts = loadPrompts(options);
  const evidence = evidenceOf(input.included);
  const unresolvedIds = input.unresolved.map((segment) => segment.segment_id);
  const now = (options.now ?? (() => new Date()))();
  const identity = identityOf(ctx, view, classificationRunId, now);

  const backend = createLlmBackend({
    campaign,
    prompts: prompts.registry,
    logger: ctx.logger,
    retry: { maxAttempts: ctx.maxAttempts },
    ...options.llm,
  });
  const finalized: { value?: RecapDraft } = {};
  const result = await backend.writeRecap({
    prompt: prompts.task,
    data: {
      campaign: campaignData(ctx),
      previous_recaps: previousRecapsData(previous),
      segments: segmentsData(input.included),
    },
    speakerIds: callSpeakers(input, previous),
    signal: ctx.signal,
    validate: (output) => {
      const outcome = finalizeRecapOutput(output, evidence);
      if (!outcome.ok) return outcome.problems;
      // Revision 1 stands in: the real one is allocated only once this attempt has passed.
      const problems = finishedRecapProblems(
        buildRecap(outcome.draft, identity, 1, unresolvedIds),
        view,
        evidence.eventIds,
      );
      if (problems.length > 0) return problems;
      finalized.value = outcome.draft;
      return [];
    },
  });
  if (finalized.value === undefined) {
    throw new StageError('recap-incomplete', 'the model call finished with no recap');
  }

  const root = await realPackageRoot(ref.paths.sessionDir(ctx.campaignId, ctx.sessionId));
  const recapDir = (await resolveInsidePackage(root, RECAP_DIR)).absolute;
  await mkdir(recapDir, { recursive: true });
  await removeLeftovers(recapDir);
  const revision = allocateRecapRevision(ctx.db, ctx.campaignId, ctx.sessionId, now);
  const recap = buildRecap(finalized.value, identity, revision, unresolvedIds);
  const problems = finishedRecapProblems(recap, view, evidence.eventIds);
  if (problems.length > 0) {
    throw new StageError(
      'recap-invalid',
      `the finished recap failed validation (${String(problems.length)} problems)`,
    );
  }
  const sources = sourcesOf(view);
  const outputs = await writeRevision(recapDir, revision, {
    'recap.json': `${JSON.stringify(recap, null, 2)}\n`,
    'recap.md': renderRecapMarkdown(recap, sources),
    'gm-notes.md': renderGmNotesMarkdown(recap, sources),
  });
  ctx.logger.child(LOG_FIELDS).info('recap.finished', {
    stage: STAGE,
    recapRevision: revision,
    sentences: recap.sentences.length,
    gmNotes: recap.gm_notes.length,
    segments: input.included.length,
    unresolved: unresolvedIds.length,
    previous: previous.length,
  });
  return { outputRecapRevision: revision, outputs, usage: result.usage };
}
