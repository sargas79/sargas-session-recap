/**
 * Synthetic world for the recap tests: invented model outputs and a fake `claude` CLI. No real
 * transcripts, no network, no model calls.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RecapModelOutput } from '@sargas-recap/contracts';
import type { RecapStageOptions } from '../../src/recap/index.ts';

export const FAKE_CLAUDE_RECAP = fileURLToPath(new URL('./fake-claude-recap.mjs', import.meta.url));

type ModelSentence = RecapModelOutput['sentences'][number];
type ModelNote = RecapModelOutput['gm_notes'][number];

export function sentence(
  refs: readonly string[],
  text = 'Kyra abriu a porta do farol.',
  extra: Partial<ModelSentence> = {},
): ModelSentence {
  return {
    text,
    assertion: 'completed',
    citations: { segment_refs: [...refs], event_ids: [] },
    ...extra,
  };
}

export function note(refs: readonly string[], text = 'Algo ficou claro.'): ModelNote {
  return {
    reason: 'unresolved',
    text,
    citations: { segment_refs: [...refs], event_ids: [] },
  };
}

export function output(
  sentences: readonly ModelSentence[],
  gmNotes: readonly ModelNote[] = [],
): RecapModelOutput {
  return {
    schema_version: 1,
    title: 'Sessão sintética',
    sentences: [...sentences],
    gm_notes: [...gmNotes],
  };
}

export type ScriptedOutput = RecapModelOutput | 'not-logged-in' | Record<string, unknown>;

export interface FakeRecapper {
  readonly options: RecapStageOptions;
  script(...outputs: readonly ScriptedOutput[]): void;
  prompts(): string[];
  clearCalls(): void;
}

export function fakeRecapper(dir: string): FakeRecapper {
  const controlFile = path.join(dir, 'recap-control.json');
  const logFile = path.join(dir, 'recap-calls.log');
  const write = (outputs: readonly ScriptedOutput[]): void => {
    writeFileSync(controlFile, JSON.stringify({ log: logFile, outputs }));
    rmSync(`${controlFile}.state`, { force: true });
  };
  write([output([sentence(['0:0'])])]);
  writeFileSync(logFile, '');
  return {
    options: {
      llm: {
        retry: { baseDelayMs: 1, maxDelayMs: 1 },
        claudeCode: {
          command: process.execPath,
          prefixArgs: [FAKE_CLAUDE_RECAP],
          extraEnv: { FAKE_RECAP_CONTROL: controlFile },
        },
      },
    },
    script: (...outputs) => {
      write(outputs);
    },
    prompts: () =>
      existsSync(logFile)
        ? readFileSync(logFile, 'utf8')
            .split('\n')
            .filter((line) => line !== '')
            .map((line) => (JSON.parse(line) as { prompt: string }).prompt)
        : [],
    clearCalls: () => {
      writeFileSync(logFile, '');
    },
  };
}
