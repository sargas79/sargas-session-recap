/** Helpers for the prompt tests (T26): temporary prompt directories built from the shipped ones. */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROMPTS_DIR } from '../../src/prompts/index.ts';

export interface PromptDir {
  readonly dir: string;
  /** Writes `<rel>` (e.g. `recap/draft.v2.md`) with `text`, exactly as given (no normalization). */
  write(rel: string, text: string): void;
  read(rel: string): string;
  cleanup(): void;
}

/** A temp copy of the shipped prompts directory, or an empty one. */
export function tempPromptDir(copyShipped = true): PromptDir {
  const root = mkdtempSync(path.join(os.tmpdir(), 'recap-prompts-'));
  const dir = path.join(root, 'prompts');
  if (copyShipped) cpSync(PROMPTS_DIR, dir, { recursive: true });
  else mkdirSync(dir);
  return {
    dir,
    write(rel, text) {
      const full = path.join(dir, ...rel.split('/'));
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, text, 'utf8');
    },
    read(rel) {
      return readFileSync(path.join(dir, ...rel.split('/')), 'utf8');
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

/** A minimal valid prompt file. */
export function promptText(
  stage: string,
  name: string,
  version: number,
  body = 'Instructions.\n\n{{data:transcript}}\n',
  extraFrontMatter = '',
): string {
  return [
    '---',
    `id: ${stage}.${name}`,
    `version: ${String(version)}`,
    `stage: ${stage}`,
    `output_schema: ${stage === 'recap' ? 'recap' : 'classification-result'}`,
    'data_slots: [transcript]',
    ...(extraFrontMatter === '' ? [] : [extraFrontMatter]),
    '---',
    body,
  ].join('\n');
}
