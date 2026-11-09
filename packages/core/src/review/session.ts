/**
 * Ties the projection and the override store to a session on disk (T12): which runs are active,
 * reading them (proved unchanged against the hashes their jobs recorded) and the GM's actions.
 */
import { readFile } from 'node:fs/promises';
import {
  validateContract,
  type ClassificationResult,
  type ContractName,
  type ContractTypes,
  type EffectiveTranscriptReview,
  type TranscriptionSegment,
} from '@sargas-recap/contracts';
import type { SqliteDatabase } from '../db/index.ts';
import { latestJob, listJobs, type Job, type JobOutput } from '../jobs/store.ts';
import { realPackageRoot, resolveInsidePackage, sha256File } from '../package/index.ts';
import type { DataPaths } from '../paths/index.ts';
import { isReviewError, ReviewError } from './errors.ts';
import { projectEffectiveTranscript, unattachedReason, type ProjectionInput } from './project.ts';
import {
  dismissOverride,
  getOverride,
  isDismissed,
  listOverrides,
  recordReconciliation,
  setOverride,
  supersedeOverride,
  type OverrideChanges,
  type StoredOverride,
} from './store.ts';

export interface SessionRef {
  readonly db: SqliteDatabase;
  readonly paths: DataPaths;
  readonly campaignId: string;
  readonly sessionId: string;
  readonly now?: (() => Date) | undefined;
}

export interface ActiveRuns {
  readonly transcriptionRunId: string;
  readonly segments: readonly TranscriptionSegment[];
  readonly classification: ProjectionInput['classification'];
}

export interface SessionReview {
  readonly view: EffectiveTranscriptReview;
  readonly overrides: readonly StoredOverride[];
}

const clock = (ref: SessionRef): Date => (ref.now ?? (() => new Date()))();

export async function readJobOutput(root: string, output: JobOutput): Promise<string> {
  try {
    const { absolute } = await resolveInsidePackage(root, output.path);
    const { hash } = await sha256File(absolute);
    if (hash !== output.hash) {
      throw new ReviewError(
        'REVIEW_RUN_INVALID',
        `${output.path} differs from what its job recorded; runs are immutable (ADR-004)`,
      );
    }
    return await readFile(absolute, 'utf8');
  } catch (error) {
    if (isReviewError(error)) throw error;
    throw new ReviewError('REVIEW_RUN_INVALID', `cannot read ${output.path}`, { cause: error });
  }
}

function parseLines<N extends ContractName>(
  name: N,
  ref: string,
  text: string,
): ContractTypes[N][] {
  const records: ContractTypes[N][] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new ReviewError('REVIEW_RUN_INVALID', `${ref} line ${String(index + 1)}: bad JSON`);
    }
    const result = validateContract(name, value);
    if (!result.ok) {
      throw new ReviewError(
        'REVIEW_RUN_INVALID',
        `${ref} line ${String(index + 1)} does not fit the ${name} contract`,
      );
    }
    records.push(result.value);
  }
  return records;
}

export function findJobOutput(job: Job, prefix: string, file: string): JobOutput {
  const output = job.outputs.find((o) => o.path.startsWith(prefix) && o.path.endsWith(file));
  if (output === undefined) {
    throw new ReviewError(
      'REVIEW_RUN_INVALID',
      `job ${job.jobId} recorded no ${prefix}.../${file} output`,
    );
  }
  return output;
}

function checkSegments(
  runId: string,
  ref: string,
  segments: readonly TranscriptionSegment[],
): void {
  const seen = new Set<string>();
  for (const segment of segments) {
    if (segment.transcription_run_id !== runId || seen.has(segment.segment_id)) {
      throw new ReviewError(
        'REVIEW_RUN_INVALID',
        `${ref}: segment ${segment.segment_id} is duplicated or belongs to another run`,
      );
    }
    seen.add(segment.segment_id);
  }
}

function checkResults(
  runId: string,
  transcriptionRunId: string,
  ref: string,
  results: readonly ClassificationResult[],
  segments: readonly TranscriptionSegment[],
): void {
  const ids = new Set(segments.map((segment) => segment.segment_id));
  const seen = new Set<string>();
  for (const result of results) {
    if (
      result.classification_run_id !== runId ||
      result.transcription_run_id !== transcriptionRunId ||
      !ids.has(result.segment_id) ||
      seen.has(result.segment_id)
    ) {
      throw new ReviewError(
        'REVIEW_RUN_INVALID',
        `${ref}: the result for ${result.segment_id} does not belong to this run`,
      );
    }
    seen.add(result.segment_id);
  }
}

/**
 * The latest finished transcription, and the latest finished classification of exactly that run.
 * After a retranscription the old classification no longer applies: its segments are other ones.
 */
export async function loadActiveRuns(ref: SessionRef): Promise<ActiveRuns> {
  const { db, paths, campaignId, sessionId } = ref;
  const transcribe = latestJob(db, campaignId, sessionId, 'transcribe', 'succeeded');
  if (transcribe?.outputRunId === undefined) {
    throw new ReviewError(
      'REVIEW_NO_TRANSCRIPT',
      `${campaignId}/${sessionId} has no finished transcription`,
      { hint: 'run `recap run transcribe` first' },
    );
  }
  const transcriptionRunId = transcribe.outputRunId;
  let root: string;
  try {
    root = await realPackageRoot(paths.sessionDir(campaignId, sessionId));
  } catch (error) {
    throw new ReviewError('REVIEW_RUN_INVALID', `cannot open the package of ${sessionId}`, {
      cause: error,
    });
  }
  const output = findJobOutput(transcribe, 'transcript/', 'segments.jsonl');
  const segments = parseLines(
    'transcription-segment',
    output.path,
    await readJobOutput(root, output),
  );
  checkSegments(transcriptionRunId, output.path, segments);

  const classify = listJobs(db, campaignId, sessionId)
    .filter(
      (job) =>
        job.stage === 'classify' &&
        job.status === 'succeeded' &&
        job.inputs.some((input) => input.kind === 'artifact' && input.ref === output.path),
    )
    .at(-1);
  if (classify?.outputRunId === undefined) {
    return { transcriptionRunId, segments, classification: null };
  }
  const resultsOutput = findJobOutput(classify, 'classify/', 'results.jsonl');
  const results = parseLines(
    'classification-result',
    resultsOutput.path,
    await readJobOutput(root, resultsOutput),
  );
  checkResults(classify.outputRunId, transcriptionRunId, resultsOutput.path, results, segments);
  return {
    transcriptionRunId,
    segments,
    classification: { runId: classify.outputRunId, results },
  };
}

/** Builds the effective transcript and records each override's reconciliation state. */
export async function loadSessionReview(ref: SessionRef): Promise<SessionReview> {
  const runs = await loadActiveRuns(ref);
  const now = clock(ref);
  const overrides = listOverrides(ref.db, ref.campaignId, ref.sessionId);
  const view = projectEffectiveTranscript({
    campaignId: ref.campaignId,
    sessionId: ref.sessionId,
    ...runs,
    overrides,
    generatedAt: now.toISOString(),
  });
  const checked = validateContract('effective-transcript-review', view);
  if (!checked.ok) {
    const where = checked.errors.map((issue) => `${issue.path} ${issue.keyword}`).join(', ');
    throw new ReviewError('REVIEW_RUN_INVALID', `the projection is not valid: ${where}`);
  }
  const unattached = new Set(view.needs_reconciliation.map((entry) => entry.override_id));
  return { view, overrides: recordReconciliation(ref.db, overrides, unattached, now) };
}

function requireSegment(runs: ActiveRuns, segmentId: string): TranscriptionSegment {
  const segment = runs.segments.find((candidate) => candidate.segment_id === segmentId);
  if (segment === undefined) {
    throw new ReviewError(
      'REVIEW_SEGMENT_NOT_FOUND',
      `segment ${segmentId} is not in the active transcription run ${runs.transcriptionRunId}`,
      { hint: 'list the segments with `recap overrides effective`' },
    );
  }
  return segment;
}

/** Sets the override of one segment of the active run, keyed on its current text hash. */
export async function setSegmentOverride(
  ref: SessionRef,
  segmentId: string,
  changes: OverrideChanges,
): Promise<StoredOverride> {
  const runs = await loadActiveRuns(ref);
  const segment = requireSegment(runs, segmentId);
  return setOverride(
    ref.db,
    {
      campaign_id: ref.campaignId,
      session_id: ref.sessionId,
      transcription_run_id: runs.transcriptionRunId,
      segment_id: segmentId,
      base_text_hash: segment.text_hash,
    },
    changes,
    clock(ref),
  );
}

function requireReconcilable(
  ref: SessionRef,
  runs: ActiveRuns,
  overrideId: string,
): StoredOverride {
  const override = getOverride(ref.db, overrideId);
  if (override?.campaign_id !== ref.campaignId || override.session_id !== ref.sessionId) {
    throw new ReviewError(
      'REVIEW_OVERRIDE_NOT_FOUND',
      `override ${overrideId} is not in ${ref.campaignId}/${ref.sessionId}`,
      { hint: 'list them with `recap overrides list`' },
    );
  }
  if (isDismissed(ref.db, overrideId)) {
    throw new ReviewError('REVIEW_NOT_RECONCILABLE', `override ${overrideId} was discarded`);
  }
  const byId = new Map(runs.segments.map((segment) => [segment.segment_id, segment]));
  if (unattachedReason(override, runs.transcriptionRunId, byId) === undefined) {
    throw new ReviewError(
      'REVIEW_NOT_RECONCILABLE',
      `override ${overrideId} still applies to its segment; there is nothing to reconcile`,
      { hint: 'change it with `recap overrides set`' },
    );
  }
  return override;
}

/** Applies an unreconciled override to a segment the GM chose in the active run (ADR-005). */
export async function reconcileToSegment(
  ref: SessionRef,
  overrideId: string,
  segmentId: string,
): Promise<StoredOverride> {
  const runs = await loadActiveRuns(ref);
  const old = requireReconcilable(ref, runs, overrideId);
  const segment = requireSegment(runs, segmentId);
  return supersedeOverride(
    ref.db,
    old,
    {
      transcription_run_id: runs.transcriptionRunId,
      segment_id: segmentId,
      text_hash: segment.text_hash,
    },
    clock(ref),
  );
}

/** Retires an unreconciled override, for example one whose segment no longer exists. */
export async function discardUnreconciled(ref: SessionRef, overrideId: string): Promise<void> {
  const runs = await loadActiveRuns(ref);
  dismissOverride(ref.db, requireReconcilable(ref, runs, overrideId), clock(ref));
}
