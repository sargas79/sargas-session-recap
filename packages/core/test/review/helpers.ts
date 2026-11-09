/**
 * Synthetic world for the review tests: invented segments and results written where real runs
 * write them, and job rows that record them. No real transcripts, no network.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  sha256Utf8,
  type ClassificationResult,
  type TranscriptionSegment,
} from '@sargas-recap/contracts';
import { openStateDatabase, type SqliteDatabase } from '../../src/db/index.ts';
import { ulid } from '../../src/ids/ulid.ts';
import { sha256File } from '../../src/package/index.ts';
import { openDataRoot, type DataPaths } from '../../src/paths/index.ts';
import type { SessionRef } from '../../src/review/index.ts';

export const CAMPAIGN = 'synthetic-vaults';
export const SESSION = 's01';
export const RUN_A = '01JBX7Q8M2N4P6R8S0T2V4W6XY';
export const RUN_B = '01JBX7Q8M2N4P6R8S0T2V4W6XZ';
export const CLASS_1 = '01JBX7RA3C5E7G9J1K3M5N7P9Q';
export const CLASS_2 = '01JBX7RA3C5E7G9J1K3M5N7P9R';

export function seg(
  run: string,
  chunk: number,
  n: number,
  startMs: number,
  text: string,
  extra: Partial<TranscriptionSegment> = {},
): TranscriptionSegment {
  return {
    schema_version: 1,
    transcription_run_id: run,
    segment_id: `${run}:${String(chunk)}:${String(n)}`,
    chunk_index: chunk,
    seq: n,
    speaker_id: 'gm',
    language: 'pt',
    text_original: text,
    text_hash: sha256Utf8(text.normalize('NFC')),
    start_offset_ms: startMs,
    end_offset_ms: startMs + 4_000,
    timing_uncertainty_ms: 0,
    chunk_start_ms: 0,
    chunk_end_ms: 4_000,
    source_spans: [{ fragment_id: 'gm:0', start_sample: 0, end_sample: 1 }],
    flags: [],
    ...extra,
  };
}

export function result(
  classificationRun: string,
  segment: TranscriptionSegment,
  label: ClassificationResult['label'],
  extra: Partial<ClassificationResult> = {},
): ClassificationResult {
  return {
    schema_version: 1,
    classification_run_id: classificationRun,
    transcription_run_id: segment.transcription_run_id,
    segment_id: segment.segment_id,
    window_index: 0,
    label,
    review_required: label === 'mixed' || label === 'uncertain',
    corrections: [],
    event_ids: [],
    flags: [],
    ...extra,
  };
}

export interface World {
  readonly dir: string;
  readonly paths: DataPaths;
  readonly db: SqliteDatabase;
  readonly ref: SessionRef;
  readonly sessionDir: string;
  /** Writes a run's segments and records a succeeded transcribe job. */
  transcribe(run: string, segments: readonly TranscriptionSegment[]): Promise<void>;
  /** Writes a run's results and records a succeeded classify job for `run`. */
  classify(
    classificationRun: string,
    run: string,
    results: readonly ClassificationResult[],
  ): Promise<void>;
  close(): void;
}

function jsonl(records: readonly unknown[]): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join('');
}

export async function newWorld(): Promise<World> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'recap-review-'));
  const { paths } = openDataRoot({ flag: path.join(dir, 'data') });
  const { db } = await openStateDatabase(paths);
  const sessionDir = paths.sessionDir(CAMPAIGN, SESSION);
  mkdirSync(sessionDir, { recursive: true });
  let tick = Date.parse('2026-11-02T20:00:00.000Z');
  const next = (): Date => new Date((tick += 1_000));

  const recordJob = (
    stage: string,
    run: string,
    output: { path: string; hash: string },
    input: { ref: string; hash: string } | undefined,
  ): void => {
    const at = next().toISOString();
    const jobId = ulid();
    db.prepare(
      `INSERT INTO jobs (job_id, campaign_id, session_id, stage, status, max_attempts, output_run_id,
         created_at, started_at, finished_at) VALUES (?, ?, ?, ?, 'succeeded', 1, ?, ?, ?, ?)`,
    ).run(jobId, CAMPAIGN, SESSION, stage, run, at, at, at);
    db.prepare('INSERT INTO job_outputs (job_id, path, hash) VALUES (?, ?, ?)').run(
      jobId,
      output.path,
      output.hash,
    );
    if (input !== undefined) {
      db.prepare(
        "INSERT INTO job_inputs (job_id, kind, ref, hash) VALUES (?, 'artifact', ?, ?)",
      ).run(jobId, input.ref, input.hash);
    }
  };

  const write = async (rel: string, content: string): Promise<string> => {
    const file = path.join(sessionDir, ...rel.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
    return (await sha256File(file)).hash;
  };

  const hashes = new Map<string, string>();
  return {
    dir,
    paths,
    db,
    sessionDir,
    ref: { db, paths, campaignId: CAMPAIGN, sessionId: SESSION, now: next },
    transcribe: async (run, segments) => {
      const rel = `transcript/${run}/segments.jsonl`;
      const hash = await write(rel, jsonl(segments));
      hashes.set(run, hash);
      recordJob('transcribe', run, { path: rel, hash }, undefined);
    },
    classify: async (classificationRun, run, results) => {
      const rel = `classify/${classificationRun}/results.jsonl`;
      const hash = await write(rel, jsonl(results));
      recordJob(
        'classify',
        classificationRun,
        { path: rel, hash },
        { ref: `transcript/${run}/segments.jsonl`, hash: hashes.get(run) ?? '' },
      );
    },
    close: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}
