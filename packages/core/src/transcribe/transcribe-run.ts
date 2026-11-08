/**
 * The body of the `transcribe` stage (T09). Loaded on first use by transcribe-stage.ts.
 *
 * A run is built in a temporary directory beside `transcript/<run>/` and renamed into place when
 * complete (ADR-006), so a run that exists under its final name is finished and never changes.
 * Each chunk's raw whisper JSON is moved into `raw/` atomically after whisper succeeds, so a file
 * there means that chunk is done. The temporary name embeds a hash of everything that shapes the
 * output, so a crashed run resumes only with the same inputs; with others it starts over.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  sha256Utf8,
  validateContract,
  type AsrParams,
  type ChunkPlan,
  type ChunkPlanChunk,
  type Fragment,
  type TranscriptionSegment,
} from '@sargas-recap/contracts';
import {
  decodeToPcm16kMono,
  isAudioToolError,
  resolveTool,
  type ResolvedTool,
} from '../audio/index.ts';
import { asrPromptTerms, assertConsent, contentHash } from '../config/index.ts';
import { JobError, StageError } from '../jobs/errors.ts';
import {
  artifactInput,
  requireConfig,
  type InputContext,
  type StageContext,
  type StageResult,
} from '../jobs/stage.ts';
import type { JobInput } from '../jobs/store.ts';
import { ulid } from '../ids/ulid.ts';
import {
  commitFileAtomic,
  finalizeDirectory,
  formatIssue,
  isAtomicTempName,
  realPackageRoot,
  resolveInsidePackage,
  sha256File,
  validatePackage,
  writeFileAtomic,
} from '../package/index.ts';
import {
  isToolsError,
  resolveWhisperTools,
  whisperJobInputs,
  type WhisperTools,
} from '../tools/index.ts';
import {
  ASR_RUNNER_VERSION,
  asrOutputParams,
  resolveAsrParams,
  whisperLanguage,
} from './asr-params.ts';
import { writeChunkWav } from './chunk-audio.ts';
import {
  CHUNK_PLAN_DIR,
  chunkPlanJobInput,
  readFragments,
  readSealedManifest,
} from './chunk-plan-stage.ts';
import { parseChunkPlan } from './chunk-plan.ts';
import { isChunkPlanError } from './errors.ts';
import { buildChunkSegments, flagRepetitionLoops, SegmentTooLongError } from './segments.ts';
import type { TranscribeStageOptions } from './transcribe-stage.ts';
import { parseWhisperJson, WhisperOutputError, type WhisperOutput } from './whisper-json.ts';
import { runWhisper, whisperArgs, whisperPath } from './whisper-process.ts';
import { buildWhisperPrompt, planPromptDelivery, type PromptDelivery } from './whisper-prompt.ts';

export const TRANSCRIPT_DIR = 'transcript';
const STAGE = 'transcribe';
const UNFINISHED_RUN = /^\.([0-9a-f]{16})-([0-9A-HJKMNP-TV-Z]{26})\.0\.[0-9a-f]{8}\.tmp$/;

/** Fields the run summary logs. Counts only, never content. */
const LOG_FIELDS = [
  'chunks',
  'resumedChunks',
  'segments',
  'emptySegments',
  'shortSegments',
  'lowConfidenceSegments',
  'clampedSegments',
  'repetitionSegments',
  'repetitionLoops',
  'promptTerms',
  'promptTermsDropped',
  'promptFolded',
  'toolWarnings',
];

function requireSessionDir(ctx: Pick<InputContext, 'sessionDir'>): string {
  if (ctx.sessionDir === undefined) {
    throw new JobError('JOB_INVALID_INPUT', `stage ${STAGE} needs a session package directory`);
  }
  return ctx.sessionDir;
}

async function loadPlan(ctx: InputContext): Promise<ChunkPlan> {
  const root = await realPackageRoot(requireSessionDir(ctx));
  const output = ctx.upstream
    .get('chunk-plan')
    ?.outputs.find((o) => o.path.startsWith(`${CHUNK_PLAN_DIR}/`));
  if (output === undefined) {
    throw new JobError('JOB_INVALID_INPUT', `stage ${STAGE} needs a finished chunk plan`, {
      hint: 'run `recap run chunk-plan` first',
    });
  }
  const { absolute } = await resolveInsidePackage(root, output.path);
  try {
    return parseChunkPlan(await readFile(absolute, 'utf8'));
  } catch (error) {
    if (isChunkPlanError(error)) throw new JobError('JOB_INVALID_INPUT', error.message);
    throw error;
  }
}

/** Exactly the speakers whose audio goes to whisper in this run. */
export async function planSpeakers(ctx: InputContext): Promise<string[]> {
  const plan = await loadPlan(ctx);
  return [...new Set(plan.chunks.map((chunk) => chunk.speaker_id))];
}

async function resolveTools(
  ctx: InputContext,
  options: TranscribeStageOptions,
): Promise<WhisperTools> {
  const { paths } = ctx;
  if (paths === undefined) {
    throw new JobError('JOB_INVALID_INPUT', `stage ${STAGE} needs a data root`);
  }
  try {
    return await (
      options.resolveTools ?? ((): Promise<WhisperTools> => resolveWhisperTools({ paths }))
    )();
  } catch (error) {
    if (isToolsError(error)) {
      throw new JobError('JOB_INVALID_INPUT', error.message, {
        ...(error.hint === undefined ? {} : { hint: error.hint }),
      });
    }
    throw error;
  }
}

async function resolveFfmpeg(options: TranscribeStageOptions): Promise<ResolvedTool> {
  try {
    return await (options.resolveFfmpeg ?? ((): Promise<ResolvedTool> => resolveTool('ffmpeg')))();
  } catch (error) {
    if (isAudioToolError(error)) {
      throw new JobError('JOB_INVALID_INPUT', error.message, {
        ...(error.hint === undefined ? {} : { hint: error.hint }),
      });
    }
    throw error;
  }
}

function paramsInput(language: string, params: AsrParams): JobInput {
  return {
    kind: 'config',
    ref: 'transcribe-params',
    hash: contentHash({
      runner_version: ASR_RUNNER_VERSION,
      language,
      params: asrOutputParams(params),
    }),
  };
}

function ffmpegInput(ffmpeg: ResolvedTool): JobInput {
  return { kind: 'config', ref: 'tool:ffmpeg', hash: contentHash({ version: ffmpeg.version.raw }) };
}

/**
 * Everything but the glossary, which is a receipt: a glossary edit must not start a new run on its
 * own, because new segment IDs send the GM's overrides to reconciliation (ADR-005).
 */
export async function transcribeInputs(
  ctx: InputContext,
  options: TranscribeStageOptions,
): Promise<JobInput[]> {
  const root = requireSessionDir(ctx);
  const { campaign } = requireConfig(ctx, STAGE);
  const manifest = await readSealedManifest(root, STAGE);
  const audio = (manifest.seal?.artifacts ?? [])
    .filter((a) => a.kind === 'audio-fragment')
    .map((a) => ({ path: a.path, hash: a.hash }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const plan = await loadPlan(ctx);
  const tools = await resolveTools(ctx, options);
  return [
    chunkPlanJobInput(plan),
    artifactInput('audio', contentHash(audio)),
    ...whisperJobInputs(tools),
    paramsInput(whisperLanguage(campaign.language), resolveAsrParams(campaign.asr)),
    ffmpegInput(await resolveFfmpeg(options)),
  ];
}

async function assertAudioUntouched(root: string): Promise<void> {
  const report = await validatePackage(root);
  if (!report.ok || report.lifecycle === 'capturing' || report.lifecycle === 'audio-purged') {
    const first = report.issues.find((issue) => issue.severity === 'error');
    throw new StageError(
      'package-invalid',
      first === undefined
        ? `the package cannot be transcribed in lifecycle ${String(report.lifecycle)}`
        : `the package does not validate: ${formatIssue(first)}`,
    );
  }
}

interface PartialRun {
  readonly dir: string;
  readonly runId: string;
}

/** The unfinished run for `key`, or a new one. Unfinished runs for other inputs are removed. */
async function openPartialRun(transcriptDir: string, key: string, now: Date): Promise<PartialRun> {
  let found: PartialRun | undefined;
  for (const name of await readdir(transcriptDir)) {
    const match = UNFINISHED_RUN.exec(name);
    if (match?.[1] === key && match[2] !== undefined) {
      found = { dir: path.join(transcriptDir, name), runId: match[2] };
    } else if (isAtomicTempName(name)) {
      await rm(path.join(transcriptDir, name), {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    }
  }
  if (found !== undefined) return found;
  const runId = ulid(now.getTime());
  const dir = path.join(transcriptDir, `.${key}-${runId}.0.${key.slice(0, 8)}.tmp`);
  await mkdir(dir);
  return { dir, runId };
}

/** Removes everything in `raw/` that is not a finished chunk (a crash can leave whisper's files). */
async function removeRawLeftovers(rawDir: string): Promise<void> {
  for (const name of await readdir(rawDir)) {
    if (!/^chunk-\d+\.json$/.test(name)) {
      await rm(path.join(rawDir, name), { force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
}

type DecodeFragment = NonNullable<TranscribeStageOptions['decode']>;

/** Fragments decoded to 16 kHz PCM on demand. Each stays only while a pending chunk needs it. */
class DecodedFragments {
  private readonly decoded = new Map<string, string>();
  private counter = 0;
  private readonly workDir: string;
  private readonly realRoot: string;
  private readonly fragments: ReadonlyMap<string, Fragment>;
  private readonly decode: (source: string, target: string) => Promise<void>;

  constructor(
    workDir: string,
    realRoot: string,
    fragments: ReadonlyMap<string, Fragment>,
    decode: (source: string, target: string) => Promise<void>,
  ) {
    this.workDir = workDir;
    this.realRoot = realRoot;
    this.fragments = fragments;
    this.decode = decode;
  }

  async fileFor(fragmentId: string): Promise<string> {
    const existing = this.decoded.get(fragmentId);
    if (existing !== undefined) return existing;
    const fragment = this.fragments.get(fragmentId);
    if (fragment === undefined) {
      throw new StageError(
        'chunk-plan-mismatch',
        'the chunk plan names a fragment not in the package',
      );
    }
    const { absolute } = await resolveInsidePackage(this.realRoot, fragment.path);
    const file = path.join(this.workDir, `fragment-${String(this.counter)}.wav`);
    this.counter += 1;
    try {
      await this.decode(absolute, file);
    } catch (error) {
      if (isAudioToolError(error)) {
        throw new StageError('audio-decode-failed', error.message, { cause: error });
      }
      throw error;
    }
    this.decoded.set(fragmentId, file);
    return file;
  }

  async releaseExcept(needed: ReadonlySet<string>): Promise<void> {
    for (const [fragmentId, file] of this.decoded) {
      if (needed.has(fragmentId)) continue;
      await rm(file, { force: true, maxRetries: 3, retryDelay: 100 });
      this.decoded.delete(fragmentId);
    }
  }
}

async function readRawOutput(file: string): Promise<WhisperOutput | undefined> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    return parseWhisperJson(text);
  } catch (error) {
    if (error instanceof WhisperOutputError) return undefined;
    throw error;
  }
}

interface TranscribeChunkInput {
  readonly ctx: StageContext;
  readonly chunk: ChunkPlanChunk;
  readonly tools: WhisperTools;
  readonly options: TranscribeStageOptions;
  readonly params: AsrParams;
  readonly language: string;
  readonly prompt: PromptDelivery;
  readonly rawDir: string;
  readonly workDir: string;
  readonly target: string;
  readonly decoded: DecodedFragments;
}

async function transcribeChunk(input: TranscribeChunkInput): Promise<void> {
  const { ctx, chunk, tools, options, params, rawDir, workDir, target } = input;
  const { campaign } = requireConfig(ctx, STAGE);
  const index = String(chunk.chunk_index);
  const wav = path.join(workDir, `chunk-${index}.wav`);
  const pieces = [];
  for (const piece of chunk.pieces) {
    pieces.push({
      file: await input.decoded.fileFor(piece.fragment_id),
      startMs: piece.fragment_start_ms,
      durationMs: piece.duration_ms,
    });
  }
  await rm(wav, { force: true });
  await writeChunkWav(wav, pieces);

  // Every whisper call passes the consent check, with the one speaker in this chunk's audio.
  assertConsent({
    campaign,
    speakerIds: [chunk.speaker_id],
    provider: campaign.provider.asr,
    stage: 'asr',
    ...(options.now === undefined ? {} : { now: options.now() }),
  });

  const outputBase = path.join(rawDir, `.chunk-${index}.${randomBytes(4).toString('hex')}`);
  const produced = `${outputBase}.json`;
  try {
    const args = whisperArgs({
      model: tools.modelPath,
      wav: whisperPath(wav),
      outputBase: whisperPath(outputBase),
      language: input.language,
      prompt: input.prompt.text,
    });
    let commandLine = args;
    if (input.prompt.responseFile) {
      const file = path.join(workDir, `chunk-${index}.args`);
      await writeFile(file, `${args.join('\n')}\n`, 'utf8');
      commandLine = [`@${whisperPath(file)}`];
    }
    await runWhisper(tools.binaryPath, [...(options.whisperPrefixArgs ?? []), ...commandLine], {
      timeoutMs: params.timeout_base_ms + chunk.duration_ms * params.timeout_audio_multiplier,
      signal: ctx.signal,
    });
    const output = await readRawOutput(produced);
    if (output === undefined) {
      throw new StageError(
        'whisper-output-invalid',
        `whisper produced no readable JSON for chunk ${index}`,
        { retryable: true },
      );
    }
    await commitFileAtomic(produced, target);
  } finally {
    await rm(produced, { force: true, maxRetries: 3, retryDelay: 100 });
    await rm(wav, { force: true, maxRetries: 3, retryDelay: 100 });
  }
}

function assertSegmentsValid(segments: readonly TranscriptionSegment[]): void {
  for (const segment of segments) {
    const result = validateContract('transcription-segment', segment);
    if (!result.ok) {
      const fields = result.errors.map((issue) => issue.path).join(', ');
      throw new StageError(
        'segment-invalid',
        `chunk ${String(segment.chunk_index)} segment ${String(segment.seq)} does not fit the contract at ${fields}`,
      );
    }
  }
}

async function buildSegments(
  plan: ChunkPlan,
  rawFile: (chunkIndex: number) => string,
  runId: string,
  language: string,
  params: AsrParams,
): Promise<{ segments: TranscriptionSegment[]; empty: number; loops: number }> {
  const built: TranscriptionSegment[] = [];
  let reported = 0;
  for (const chunk of plan.chunks) {
    const output = await readRawOutput(rawFile(chunk.chunk_index));
    if (output === undefined) {
      throw new StageError(
        'whisper-output-invalid',
        `the raw output of chunk ${String(chunk.chunk_index)} is missing or unreadable`,
        { retryable: true },
      );
    }
    reported += output.segments.length;
    try {
      built.push(
        ...buildChunkSegments({
          transcriptionRunId: runId,
          chunk,
          segments: output.segments,
          language,
          params,
        }),
      );
    } catch (error) {
      if (error instanceof SegmentTooLongError) {
        throw new StageError('segment-invalid', error.message);
      }
      throw error;
    }
  }
  const { segments, loops } = flagRepetitionLoops(built, params);
  return { segments, empty: reported - segments.length, loops };
}

export async function runTranscribe(
  ctx: StageContext,
  options: TranscribeStageOptions,
): Promise<StageResult> {
  const root = requireSessionDir(ctx);
  const { campaign, glossary } = requireConfig(ctx, STAGE);
  await assertAudioUntouched(root);
  const plan = await loadPlan(ctx);
  const params = resolveAsrParams(campaign.asr);
  const language = whisperLanguage(campaign.language);
  const tools = await resolveTools(ctx, options);
  const ffmpeg = await resolveFfmpeg(options);
  const realRoot = await realPackageRoot(root);
  const prompt = buildWhisperPrompt(asrPromptTerms(glossary), params.prompt_max_chars);
  const delivery = planPromptDelivery(
    prompt.text,
    [tools.modelPath, realRoot],
    options.platform ?? process.platform,
  );
  const fragments = new Map((await readFragments(root)).map((f) => [f.fragment_id, f]));

  const key = contentHash({
    runner_version: ASR_RUNNER_VERSION,
    plan_hash: plan.plan_hash,
    model_hash: tools.modelHash,
    binary_hash: tools.binaryHash,
    language,
    prompt_hash: sha256Utf8(delivery.text),
    ffmpeg: ffmpeg.version.raw,
    params: asrOutputParams(params),
  })
    .slice('sha256:'.length)
    .slice(0, 16);

  const transcriptDir = (await resolveInsidePackage(realRoot, TRANSCRIPT_DIR)).absolute;
  await mkdir(transcriptDir, { recursive: true });
  const partial = await openPartialRun(transcriptDir, key, (options.now ?? (() => new Date()))());
  const rawDir = path.join(partial.dir, 'raw');
  const workDir = path.join(partial.dir, 'work');
  await rm(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  await mkdir(rawDir, { recursive: true });
  await mkdir(workDir);
  await removeRawLeftovers(rawDir);
  const rawFile = (chunkIndex: number): string =>
    path.join(rawDir, `chunk-${String(chunkIndex)}.json`);

  const decode: DecodeFragment =
    options.decode ?? ((src, dst, signal) => decodeToPcm16kMono(src, dst, { ffmpeg, signal }));
  const decoded = new DecodedFragments(workDir, realRoot, fragments, (src, dst) =>
    decode(src, dst, ctx.signal),
  );
  let resumed = 0;
  try {
    for (const [position, chunk] of plan.chunks.entries()) {
      if ((await readRawOutput(rawFile(chunk.chunk_index))) !== undefined) {
        resumed += 1;
        continue;
      }
      await transcribeChunk({
        ctx,
        chunk,
        tools,
        options,
        params,
        language,
        prompt: delivery,
        rawDir,
        workDir,
        target: rawFile(chunk.chunk_index),
        decoded,
      });
      await decoded.releaseExcept(
        new Set(plan.chunks.slice(position + 1).flatMap((c) => c.pieces.map((p) => p.fragment_id))),
      );
    }
  } finally {
    // Decoded audio never outlives the attempt, even when the run itself will resume.
    await rm(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }

  const { segments, empty, loops } = await buildSegments(
    plan,
    rawFile,
    partial.runId,
    language,
    params,
  );
  assertSegmentsValid(segments);
  await removeRawLeftovers(rawDir);
  await writeFileAtomic(
    path.join(partial.dir, 'segments.jsonl'),
    segments.map((segment) => `${JSON.stringify(segment)}\n`).join(''),
  );

  // Acceptance: the sealed audio is byte-identical after the run, proved against the seal hashes.
  await assertAudioUntouched(root);
  const finalDir = path.join(transcriptDir, partial.runId);
  await finalizeDirectory(partial.dir, finalDir);
  const { hash } = await sha256File(path.join(finalDir, 'segments.jsonl'));

  const count = (flag: TranscriptionSegment['flags'][number]): number =>
    segments.filter((segment) => segment.flags.includes(flag)).length;
  ctx.logger.child(LOG_FIELDS).info('transcribe.finished', {
    stage: STAGE,
    runId: partial.runId,
    chunks: plan.chunks.length,
    resumedChunks: resumed,
    segments: segments.length,
    emptySegments: empty,
    shortSegments: count('short'),
    lowConfidenceSegments: count('low_confidence'),
    clampedSegments: count('timestamp_clamped'),
    repetitionSegments: count('repetition_loop'),
    repetitionLoops: loops,
    promptTerms: prompt.termsUsed,
    promptTermsDropped: prompt.termsDropped,
    promptFolded: delivery.folded,
    toolWarnings: tools.warnings.length,
  });
  return {
    outputRunId: partial.runId,
    outputs: [{ path: `${TRANSCRIPT_DIR}/${partial.runId}/segments.jsonl`, hash }],
  };
}
