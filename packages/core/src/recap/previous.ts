/**
 * Recaps of earlier sessions, as labelled background for the prompt (T13). Background is never
 * evidence: only its text goes to the model, without citations, so nothing in it can be cited.
 *
 * GM-only notes never go in. A sentence goes in only while every segment it cites is still included
 * in that session's effective transcript, so a later exclusion also reaches the background. A recap
 * whose transcription run is no longer the active one is skipped: its citations cannot be checked.
 * The speakers of the cited segments are returned, because the consent check covers them too.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  validateContract,
  type Manifest,
  type Recap,
  type EffectiveTranscriptReview,
} from '@sargas-recap/contracts';
import { latestJob, type JobOutput } from '../jobs/store.ts';
import { realPackageRoot, resolveInsidePackage, sha256File } from '../package/index.ts';
import { listOverrides, loadActiveRuns, projectEffectiveTranscript } from '../review/index.ts';
import type { SessionRef } from '../review/index.ts';

/** How many earlier sessions go along as background. */
export const MAX_PREVIOUS_RECAPS = 3;

export interface PreviousRecap {
  readonly sessionId: string;
  readonly revision: number;
  /** Hash of its `recap.json`, recorded as a job receipt. */
  readonly hash: string;
  readonly title: string;
  readonly sentences: readonly string[];
  readonly speakerIds: readonly string[];
}

async function readManifest(ref: SessionRef, sessionId: string): Promise<Manifest | undefined> {
  try {
    const file = path.join(ref.paths.sessionDir(ref.campaignId, sessionId), 'manifest.json');
    const result = validateContract('manifest', JSON.parse(await readFile(file, 'utf8')));
    return result.ok ? result.value : undefined;
  } catch {
    return undefined;
  }
}

async function earlierSessions(ref: SessionRef): Promise<string[]> {
  const current = await readManifest(ref, ref.sessionId);
  if (current === undefined) return [];
  const rows = ref.db
    .prepare(
      `SELECT DISTINCT session_id AS id FROM jobs
       WHERE campaign_id = ? AND session_id <> ? AND stage = 'recap' AND status = 'succeeded'`,
    )
    .all(ref.campaignId, ref.sessionId) as { id: string }[];
  const dated: { id: string; created: string }[] = [];
  for (const { id } of rows) {
    const manifest = await readManifest(ref, id);
    if (manifest !== undefined && manifest.created_at < current.created_at) {
      dated.push({ id, created: manifest.created_at });
    }
  }
  dated.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0));
  return dated.slice(0, MAX_PREVIOUS_RECAPS).map(({ id }) => id);
}

async function readRecap(
  ref: SessionRef,
  sessionId: string,
  output: JobOutput,
): Promise<Recap | undefined> {
  const root = await realPackageRoot(ref.paths.sessionDir(ref.campaignId, sessionId));
  const { absolute } = await resolveInsidePackage(root, output.path);
  if ((await sha256File(absolute)).hash !== output.hash) return undefined;
  const result = validateContract('recap', JSON.parse(await readFile(absolute, 'utf8')));
  return result.ok ? result.value : undefined;
}

async function projectionOf(
  ref: SessionRef,
  sessionId: string,
): Promise<EffectiveTranscriptReview> {
  const runs = await loadActiveRuns({ ...ref, sessionId });
  return projectEffectiveTranscript({
    campaignId: ref.campaignId,
    sessionId,
    ...runs,
    overrides: listOverrides(ref.db, ref.campaignId, sessionId),
    generatedAt: new Date(0).toISOString(),
  });
}

async function previousRecap(
  ref: SessionRef,
  sessionId: string,
): Promise<PreviousRecap | undefined> {
  const job = latestJob(ref.db, ref.campaignId, sessionId, 'recap', 'succeeded');
  const output = job?.outputs.find((o) => o.path.endsWith('/recap.json'));
  if (job?.outputRecapRevision === undefined || output === undefined) return undefined;
  const recap = await readRecap(ref, sessionId, output);
  if (recap === undefined) return undefined;
  const view = await projectionOf(ref, sessionId);
  if (view.transcription_run_id !== recap.transcription_run_id) return undefined;

  const byId = new Map(view.segments.map((segment) => [segment.segment_id, segment]));
  const speakers = new Set<string>();
  const sentences: string[] = [];
  for (const sentence of recap.sentences) {
    const cited = sentence.citations.segment_ids.map((id) => byId.get(id));
    const stillIncluded =
      cited.length > 0 && cited.every((segment) => segment?.recap_inclusion === 'include');
    if (!stillIncluded) continue;
    sentences.push(sentence.text);
    for (const segment of cited) if (segment !== undefined) speakers.add(segment.speaker_id);
  }
  if (sentences.length === 0) return undefined;
  return {
    sessionId,
    revision: job.outputRecapRevision,
    hash: output.hash,
    title: recap.title,
    sentences,
    speakerIds: [...speakers].sort(),
  };
}

/** The latest recap of each of the nearest earlier sessions, newest first. */
export async function loadPreviousRecaps(ref: SessionRef): Promise<PreviousRecap[]> {
  const previous: PreviousRecap[] = [];
  for (const sessionId of await earlierSessions(ref)) {
    try {
      const recap = await previousRecap(ref, sessionId);
      if (recap !== undefined) previous.push(recap);
    } catch {
      // A damaged earlier session only costs this recap some background.
      continue;
    }
  }
  return previous;
}

/** One JSON object per line, like the segments. */
export function previousRecapsData(previous: readonly PreviousRecap[]): string {
  return previous
    .map((recap) =>
      JSON.stringify({ session: recap.sessionId, title: recap.title, sentences: recap.sentences }),
    )
    .join('\n');
}
