import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadPromptRegistry,
  normalizePromptText,
  parsePromptAsset,
  PROMPT_JOB_STAGE,
  PROMPTS_DIR,
  promptHash,
  promptJobInput,
  type PromptError,
} from '../../src/prompts/index.ts';
import { promptText, tempPromptDir, type PromptDir } from './helpers.ts';

let tmp: PromptDir;

beforeEach(() => {
  tmp = tempPromptDir();
});

afterEach(() => {
  tmp.cleanup();
});

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return (error as PromptError).code;
  }
  return undefined;
}

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  return '';
}

describe('prompt registry: shipped prompts', () => {
  it('loads a task and a system prompt per stage with front matter matching the file name', () => {
    const registry = loadPromptRegistry();
    const summary = registry.list().map((p) => ({
      id: p.id,
      version: p.version,
      stage: p.stage,
      outputSchema: p.outputSchema,
      dataSlots: p.dataSlots,
      file: p.file,
    }));
    expect(summary).toEqual([
      {
        id: 'classification.system',
        version: 1,
        stage: 'classification',
        outputSchema: 'classification-result',
        dataSlots: [],
        file: 'classification/system.v1.md',
      },
      {
        id: 'classification.window',
        version: 1,
        stage: 'classification',
        outputSchema: 'classification-result',
        dataSlots: ['transcript'],
        file: 'classification/window.v1.md',
      },
      {
        id: 'recap.draft',
        version: 1,
        stage: 'recap',
        outputSchema: 'recap',
        dataSlots: ['transcript'],
        file: 'recap/draft.v1.md',
      },
      {
        id: 'recap.system',
        version: 1,
        stage: 'recap',
        outputSchema: 'recap',
        dataSlots: [],
        file: 'recap/system.v1.md',
      },
    ]);
    expect(new Set(registry.list().map((p) => p.stage))).toEqual(
      new Set(Object.keys(PROMPT_JOB_STAGE)),
    );
  });

  it('get / latest / not found', () => {
    tmp.write('recap/draft.v2.md', promptText('recap', 'draft', 2));
    const registry = loadPromptRegistry({ dir: tmp.dir });
    expect(registry.get('recap.draft', 1).version).toBe(1);
    expect(registry.latest('recap.draft').version).toBe(2);
    expect(codeOf(() => registry.get('recap.draft', 3))).toBe('PROMPT_NOT_FOUND');
    expect(codeOf(() => registry.latest('recap.nope'))).toBe('PROMPT_NOT_FOUND');
  });

  it('exposes the prompt as a T07 dependency input: kind prompt, ref <id>@v<N>, content hash', () => {
    const asset = loadPromptRegistry().get('classification.window', 1);
    expect(promptJobInput(asset)).toEqual({
      kind: 'prompt',
      ref: 'classification.window@v1',
      hash: asset.hash,
    });
    expect(asset.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('prompt hash', () => {
  it('is the sha256 of the normalized file text (pure-JS sha256 equals node:crypto)', () => {
    const raw = readFileSync(`${PROMPTS_DIR}/recap/draft.v1.md`, 'utf8');
    const expected = createHash('sha256').update(normalizePromptText(raw), 'utf8').digest('hex');
    expect(loadPromptRegistry().get('recap.draft', 1).hash).toBe(`sha256:${expected}`);
    expect(promptHash(raw)).toBe(`sha256:${expected}`);
  });

  it('CRLF, lone CR, LF and a leading BOM hash the same', () => {
    const lf = tmp.read('classification/window.v1.md').replace(/\r\n/g, '\n');
    const variants = [
      lf,
      lf.replace(/\n/g, '\r\n'),
      lf.replace(/\n/g, '\r'),
      '﻿' + lf.replace(/\n/g, '\r\n'),
    ];
    const hashes = variants.map((text) => {
      tmp.write('classification/window.v1.md', text);
      return loadPromptRegistry({ dir: tmp.dir }).get('classification.window', 1).hash;
    });
    expect(new Set(hashes).size).toBe(1);
    expect(hashes[0]).toBe(loadPromptRegistry().get('classification.window', 1).hash);
    // The body the template renders from is normalized too.
    tmp.write('classification/window.v1.md', lf.replace(/\n/g, '\r\n'));
    expect(loadPromptRegistry({ dir: tmp.dir }).get('classification.window', 1).body).not.toContain(
      '\r',
    );
  });

  it('NFC and NFD spellings hash the same; any real edit changes the hash', () => {
    const nfc = promptText('recap', 'draft', 1, 'Resumo da sessão.\n\n{{data:transcript}}\n');
    const nfd = nfc.normalize('NFD');
    expect(nfd).not.toBe(nfc);
    expect(promptHash(nfd)).toBe(promptHash(nfc));
    expect(promptHash(nfc.replace('Resumo', 'Resumo.'))).not.toBe(promptHash(nfc));
    expect(promptHash(`${nfc}\n`)).not.toBe(promptHash(nfc));
    expect(
      promptHash(nfc.replace('output_schema: recap', 'output_schema: recap-package')),
    ).not.toBe(promptHash(nfc));
  });
});

describe('prompt registry: validation', () => {
  const cases: [string, string, string, RegExp][] = [
    ['bad file name', 'recap/Draft.v1.md', promptText('recap', 'Draft', 1), /path must be/],
    ['version 0', 'recap/draft.v0.md', promptText('recap', 'draft', 0), /path must be/],
    ['unknown stage', 'asr/x.v1.md', promptText('asr', 'x', 1), /unknown stage/],
    [
      'id mismatch',
      'recap/other.v1.md',
      promptText('recap', 'draft', 1),
      /id must be recap\.other/,
    ],
    ['version mismatch', 'recap/draft.v2.md', promptText('recap', 'draft', 1), /version must be 2/],
    [
      'stage mismatch',
      'recap/draft.v2.md',
      promptText('recap', 'draft', 2).replace('stage: recap', 'stage: classification'),
      /stage must be recap/,
    ],
    [
      'unknown output schema',
      'recap/draft.v2.md',
      promptText('recap', 'draft', 2).replace('output_schema: recap', 'output_schema: nope'),
      /output_schema/,
    ],
    [
      'unknown front matter key',
      'recap/draft.v2.md',
      promptText('recap', 'draft', 2, undefined, 'temperature: 0'),
      /unknown front matter key "temperature"/,
    ],
    ['no front matter', 'recap/draft.v2.md', 'Just text.\n', /front matter/],
    [
      'unclosed front matter',
      'recap/draft.v2.md',
      '---\nid: recap.draft\nversion: 2\n',
      /not closed/,
    ],
    [
      'YAML anchors',
      'recap/draft.v2.md',
      promptText('recap', 'draft', 2).replace('stage: recap', 'stage: &s recap'),
      /not valid YAML/,
    ],
    [
      'slot not declared',
      'recap/draft.v2.md',
      promptText('recap', 'draft', 2, 'X\n{{data:transcript}}\n{{data:events}}\n'),
      /do not match/,
    ],
    [
      'declared slot missing from body',
      'recap/draft.v2.md',
      promptText('recap', 'draft', 2, 'No slot here.\n'),
      /do not match/,
    ],
    [
      'slot not alone on its line',
      'recap/draft.v2.md',
      promptText('recap', 'draft', 2, 'Data: {{data:transcript}}\n'),
      /alone on its line/,
    ],
    [
      'unknown placeholder',
      'recap/draft.v2.md',
      promptText('recap', 'draft', 2, 'Hello {{name}}\n{{data:transcript}}\n'),
      /only \{\{data_tag\}\}/,
    ],
    [
      'repeated slot',
      'recap/draft.v2.md',
      promptText('recap', 'draft', 2, '{{data:transcript}}\n{{data:transcript}}\n'),
      /more than once/,
    ],
  ];
  it.each(cases)('rejects %s', (_name, file, text, message) => {
    expect(codeOf(() => parsePromptAsset(file, text))).toBe('PROMPT_INVALID');
    expect(messageOf(() => parsePromptAsset(file, text))).toMatch(message);
  });

  it('error messages name the file, never prompt text', () => {
    const text = promptText(
      'recap',
      'draft',
      2,
      'SECRET-INSTRUCTION {{oops}}\n{{data:transcript}}\n',
    );
    const message = messageOf(() => parsePromptAsset('recap/draft.v2.md', text));
    expect(message).toContain('recap/draft.v2.md');
    expect(message).not.toContain('SECRET-INSTRUCTION');
  });

  it('a malformed file anywhere fails the whole load', () => {
    tmp.write('recap/draft.v2.md', 'no front matter\n');
    expect(codeOf(() => loadPromptRegistry({ dir: tmp.dir }))).toBe('PROMPT_INVALID');
  });
});

describe('prompt assets ship with the package', () => {
  const coreDir = fileURLToPath(new URL('../../', import.meta.url));

  it('package.json `files` includes the prompts directory', () => {
    const pkg = JSON.parse(readFileSync(`${coreDir}package.json`, 'utf8')) as { files: string[] };
    expect(pkg.files).toContain('prompts');
  });

  const distIndex = `${coreDir}dist/prompts/index.js`;
  it.skipIf(!existsSync(distIndex))('load from dist/ after `npm run build`', () => {
    const script = [
      `const m = await import(${JSON.stringify(pathToFileURL(distIndex).href)});`,
      'const r = m.loadPromptRegistry();',
      'process.stdout.write(JSON.stringify(r.list().map((p) => [p.id, p.version, p.hash])));',
    ].join('\n');
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
    });
    const fromSrc = loadPromptRegistry()
      .list()
      .map((p) => [p.id, p.version, p.hash]);
    expect(JSON.parse(out)).toEqual(fromSrc);
  });
});
