/**
 * Synthetic world for the classify stage: invented segments, a stand-in for the transcribe stage
 * and a fake `claude` CLI. No real transcripts, no network.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Utf8, type TranscriptionSegment } from '@sargas-recap/contracts';
import type { StageDefinition } from '../../src/jobs/index.ts';
import { sha256File } from '../../src/package/index.ts';
import type { ClassifyStageOptions } from '../../src/classify/index.ts';

export const FAKE_CLAUDE_CLASSIFY = fileURLToPath(
  new URL('./fake-claude-classify.mjs', import.meta.url),
);
export const RUN_ID = '01JBX7Q8M2N4P6R8S0T2V4W6XY';

export const MINUTE = 60_000;

export function segment(
  chunk: number,
  seq: number,
  speaker: string,
  startMs: number,
  text: string,
  overrides: Partial<TranscriptionSegment> = {},
): TranscriptionSegment {
  const end = overrides.end_offset_ms ?? startMs + 4_000;
  return {
    schema_version: 1,
    transcription_run_id: RUN_ID,
    segment_id: `${RUN_ID}:${String(chunk)}:${String(seq)}`,
    chunk_index: chunk,
    seq,
    speaker_id: speaker,
    language: 'pt',
    text_original: text,
    text_hash: sha256Utf8(text.normalize('NFC')),
    start_offset_ms: startMs,
    end_offset_ms: end,
    timing_uncertainty_ms: 0,
    chunk_start_ms: 0,
    chunk_end_ms: end - startMs,
    source_spans: [{ fragment_id: `${speaker}:0`, start_sample: 0, end_sample: 1 }],
    flags: [],
    ...overrides,
  };
}

/** One synthetic transcribe run: writes `segments` once and records them as its output. */
export function fakeTranscribe(
  segments: readonly TranscriptionSegment[],
  counter: { runs: number } = { runs: 0 },
): StageDefinition {
  return {
    name: 'transcribe',
    run: async (ctx) => {
      counter.runs += 1;
      if (ctx.sessionDir === undefined) throw new Error('no session dir');
      const rel = `transcript/${RUN_ID}/segments.jsonl`;
      const file = path.join(ctx.sessionDir, ...rel.split('/'));
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, segments.map((s) => `${JSON.stringify(s)}\n`).join(''));
      return { outputRunId: RUN_ID, outputs: [{ path: rel, hash: (await sha256File(file)).hash }] };
    },
  };
}

export interface LoggedCall {
  readonly first: string;
  readonly mode: string;
  readonly refs: string[];
  readonly before: string[];
  readonly after: string[];
  readonly prompt: string;
}

export interface FakeClassifier {
  readonly options: ClassifyStageOptions;
  script(windows?: Record<string, string[]>): void;
  calls(): LoggedCall[];
  clearCalls(): void;
}

export function fakeClassifier(dir: string): FakeClassifier {
  const controlFile = path.join(dir, 'classify-control.json');
  const logFile = path.join(dir, 'classify-calls.log');
  const write = (windows: Record<string, string[]>): void => {
    writeFileSync(controlFile, JSON.stringify({ log: logFile, windows }));
    rmSync(`${controlFile}.state`, { force: true });
  };
  write({});
  appendFileSync(logFile, '');
  return {
    options: {
      llm: {
        retry: { baseDelayMs: 1, maxDelayMs: 1 },
        claudeCode: {
          command: process.execPath,
          prefixArgs: [FAKE_CLAUDE_CLASSIFY],
          extraEnv: { FAKE_CLASSIFY_CONTROL: controlFile },
        },
      },
    },
    script: (windows = {}) => {
      write(windows);
    },
    calls: () =>
      existsSync(logFile)
        ? readFileSync(logFile, 'utf8')
            .split('\n')
            .filter((line) => line !== '')
            .map((line) => JSON.parse(line) as LoggedCall)
        : [],
    clearCalls: () => {
      writeFileSync(logFile, '');
    },
  };
}
