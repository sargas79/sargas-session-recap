/**
 * Versioned prompt assets (T26).
 *
 * Layout: `packages/core/prompts/<stage>/<name>.v<N>.md`, one file per prompt version. Each file
 * starts with YAML front matter:
 *
 * ```yaml
 * ---
 * id: classification.window   # always `<stage>.<name>`
 * version: 1                  # always the `v<N>` of the file name
 * stage: classification       # always the directory name
 * output_schema: classification-result   # a contract name (packages/contracts registry)
 * data_slots: [transcript]    # the untrusted-data slots the body declares (template.ts)
 * ---
 * ```
 *
 * The content hash covers the whole file (front matter and body) after normalization: a leading
 * BOM is dropped, CRLF and lone CR become LF, and the text is put in Unicode NFC. So a Windows
 * checkout with `core.autocrlf` hashes the same as a Linux one. The hash is the pure-JS SHA-256 of
 * the UTF-8 bytes (`sha256Utf8`, ADR-010), formatted `sha256:<hex>`.
 *
 * Rule: a prompt file is immutable once committed. Any edit is a new file with the next version;
 * test/prompts/prompt-hashes.json freezes every committed version's hash and a test fails when one
 * changes. Stages record the prompt they used as a job input (`promptJobInput`), so a new version
 * reruns exactly the stages that use it (T07 selective invalidation).
 *
 * The prompt files ship with the package (`files: ["prompts"]`) and are read relative to this module,
 * which resolves to the same directory from `src/prompts/` (tests) and `dist/prompts/` (build).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACTS, sha256Utf8 } from '@sargas-recap/contracts';
import { parseYaml } from '../config/yaml.ts';
import { promptInput } from '../jobs/stage.ts';
import type { JobStage } from '../jobs/state.ts';
import type { JobInput } from '../jobs/store.ts';
import { PromptError } from './errors.ts';
import {
  isSlotName,
  parseTemplate,
  renderTemplate,
  type ParsedTemplate,
  type RenderTemplateOptions,
} from './template.ts';

/** Prompt directory shipped with the package. */
export const PROMPTS_DIR = fileURLToPath(new URL('../../prompts/', import.meta.url));

export const PROMPT_STAGES = ['classification', 'recap'] as const;
export type PromptStage = (typeof PROMPT_STAGES)[number];

/** The job stage that runs prompts of each prompt stage. */
export const PROMPT_JOB_STAGE: Readonly<Record<PromptStage, JobStage>> = Object.freeze({
  classification: 'classify',
  recap: 'recap',
});

export type ContractName = keyof typeof CONTRACTS;

/** What a run records about the prompt it used. */
export interface PromptRef {
  readonly id: string;
  readonly version: number;
  readonly hash: string;
}

export interface PromptAsset extends PromptRef {
  readonly stage: PromptStage;
  readonly outputSchema: ContractName;
  readonly dataSlots: readonly string[];
  /** File path relative to the prompts directory, POSIX separators. */
  readonly file: string;
  /** Normalized (LF, NFC) body after the front matter. Trusted instruction text. */
  readonly body: string;
  readonly template: ParsedTemplate;
}

const FILE_RE = /^([a-z0-9][a-z0-9-]{0,62})\.v([1-9][0-9]{0,5})\.md$/;
const FRONT_MATTER_KEYS = ['id', 'version', 'stage', 'output_schema', 'data_slots'] as const;
const MAX_PROMPT_BYTES = 256 * 1024;

/** BOM dropped, CRLF / CR -> LF, Unicode NFC. What the hash covers. */
export function normalizePromptText(text: string): string {
  const noBom = text.startsWith('﻿') ? text.slice(1) : text;
  return noBom.replace(/\r\n?/g, '\n').normalize('NFC');
}

/** `sha256:<hex>` of the normalized prompt file text. */
export function promptHash(text: string): string {
  return sha256Utf8(normalizePromptText(text));
}

function isPromptStage(value: unknown): value is PromptStage {
  return typeof value === 'string' && (PROMPT_STAGES as readonly string[]).includes(value);
}

function isContractName(value: unknown): value is ContractName {
  return typeof value === 'string' && Object.hasOwn(CONTRACTS, value);
}

function invalid(file: string, message: string): never {
  throw new PromptError('PROMPT_INVALID', `prompt ${file}: ${message}`);
}

/**
 * Parses one prompt file. `file` is `<stage>/<name>.v<N>.md` (POSIX); the front matter must agree
 * with it. Throws `PROMPT_INVALID`.
 */
export function parsePromptAsset(file: string, raw: string): PromptAsset {
  const [dir, base, ...rest] = file.split('/');
  const match = base === undefined ? null : FILE_RE.exec(base);
  if (dir === undefined || rest.length > 0 || match === null) {
    invalid(file, 'path must be <stage>/<name>.v<N>.md (lowercase name, N >= 1)');
  }
  if (!isPromptStage(dir))
    invalid(file, `unknown stage directory; use ${PROMPT_STAGES.join(', ')}`);
  const name = match[1] ?? '';
  const fileVersion = Number(match[2]);

  const text = normalizePromptText(raw);
  if (!text.startsWith('---\n')) invalid(file, 'must start with a --- front matter line');
  const end = text.indexOf('\n---\n', 3);
  if (end < 0) invalid(file, 'front matter is not closed by a --- line');
  const parsed = parseYaml(text.slice(4, end + 1));
  if (!parsed.ok) invalid(file, 'front matter is not valid YAML (plain scalars and lists only)');
  const fm = parsed.parsed.value;
  if (fm === null || typeof fm !== 'object' || Array.isArray(fm)) {
    invalid(file, 'front matter must be a mapping');
  }
  const meta = fm as Record<string, unknown>;
  for (const key of Object.keys(meta)) {
    if (!(FRONT_MATTER_KEYS as readonly string[]).includes(key)) {
      invalid(file, `unknown front matter key ${JSON.stringify(key)}`);
    }
  }
  const id = `${dir}.${name}`;
  if (meta['id'] !== id) invalid(file, `front matter id must be ${id}`);
  if (meta['version'] !== fileVersion) {
    invalid(
      file,
      `front matter version must be ${String(fileVersion)} (the v<N> of the file name)`,
    );
  }
  if (meta['stage'] !== dir) invalid(file, `front matter stage must be ${dir}`);
  const outputSchema = meta['output_schema'];
  if (!isContractName(outputSchema)) {
    invalid(file, 'output_schema must name a contract in @sargas-recap/contracts CONTRACTS');
  }
  const rawSlots: unknown = meta['data_slots'];
  const slotsMessage = 'data_slots must be a list of distinct slot names ([a-z][a-z0-9_]*)';
  if (!Array.isArray(rawSlots)) invalid(file, slotsMessage);
  const slotList = rawSlots as unknown[];
  if (!slotList.every((s): s is string => typeof s === 'string' && isSlotName(s))) {
    invalid(file, slotsMessage);
  }
  const slots: string[] = slotList;
  if (new Set(slots).size !== slots.length) invalid(file, slotsMessage);

  const body = text.slice(end + 5);
  const template = parseTemplate(body, `prompt ${file}`);
  const declared = [...slots].sort();
  const used = [...template.slots].sort();
  if (declared.join(',') !== used.join(',')) {
    invalid(
      file,
      `data_slots [${declared.join(', ')}] do not match the body's slots [${used.join(', ')}]`,
    );
  }
  return {
    id,
    version: fileVersion,
    hash: sha256Utf8(text),
    stage: dir,
    outputSchema,
    dataSlots: slots,
    file,
    body,
    template,
  };
}

export interface PromptRegistry {
  /** Every prompt version, sorted by id then version. */
  list(): readonly PromptAsset[];
  /** One version. Throws `PROMPT_NOT_FOUND`. */
  get(id: string, version: number): PromptAsset;
  /** The highest version of `id`. Throws `PROMPT_NOT_FOUND`. */
  latest(id: string): PromptAsset;
}

export interface LoadPromptOptions {
  /** Prompts directory; defaults to the one shipped with the package. */
  readonly dir?: string | undefined;
}

/** Loads and validates every prompt under the prompts directory. Throws `PROMPT_INVALID`. */
export function loadPromptRegistry(options: LoadPromptOptions = {}): PromptRegistry {
  const dir = options.dir ?? PROMPTS_DIR;
  const assets: PromptAsset[] = [];
  for (const stageDir of readdirSync(dir, { withFileTypes: true })) {
    if (!stageDir.isDirectory()) continue;
    for (const entry of readdirSync(path.join(dir, stageDir.name), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const full = path.join(dir, stageDir.name, entry.name);
      const file = `${stageDir.name}/${entry.name}`;
      if (statSync(full).size > MAX_PROMPT_BYTES) invalid(file, 'file is larger than 256 KiB');
      assets.push(parsePromptAsset(file, readFileSync(full, 'utf8')));
    }
  }
  return createPromptRegistry(assets);
}

/** A registry over already-parsed assets. Throws `PROMPT_INVALID` on a duplicate id+version. */
export function createPromptRegistry(assets: readonly PromptAsset[]): PromptRegistry {
  const sorted = [...assets].sort((a, b) =>
    a.id === b.id ? a.version - b.version : a.id < b.id ? -1 : 1,
  );
  const byKey = new Map<string, PromptAsset>();
  const latest = new Map<string, PromptAsset>();
  for (const asset of sorted) {
    const key = promptKey(asset);
    if (byKey.has(key)) invalid(asset.file, `${key} is defined twice`);
    byKey.set(key, asset);
    latest.set(asset.id, asset);
  }
  const notFound = (what: string): never => {
    throw new PromptError('PROMPT_NOT_FOUND', `no prompt ${what}`);
  };
  return {
    list: () => sorted,
    get: (id, version) =>
      byKey.get(`${id}@v${String(version)}`) ?? notFound(`${id}@v${String(version)}`),
    latest: (id) => latest.get(id) ?? notFound(id),
  };
}

/** `<id>@v<version>`: the prompt's name in job inputs and in the hash snapshot. */
export function promptKey(ref: Pick<PromptRef, 'id' | 'version'>): string {
  return `${ref.id}@v${String(ref.version)}`;
}

/**
 * The prompt as a T07 dependency input (`kind: prompt`, `ref: <id>@v<version>`, normalized content
 * hash). A classify or recap job records it, so its run record names the exact prompt it used, and a
 * new prompt version reruns only the stages that declare it.
 */
export function promptJobInput(asset: PromptRef): JobInput {
  return promptInput(asset.id, asset.version, asset.hash);
}

export interface RenderedPrompt {
  readonly prompt: PromptRef;
  readonly text: string;
  /** This render's data tag (`untrusted-data-<nonce>`). */
  readonly tag: string;
}

/**
 * Renders `asset` with untrusted `data` in its declared slots (see template.ts). Throws
 * `PROMPT_DATA_INVALID` when the slots do not match.
 */
export function renderPrompt(
  asset: PromptAsset,
  data: Readonly<Record<string, string>>,
  options: RenderTemplateOptions = {},
): RenderedPrompt {
  const rendered = renderTemplate(asset.template, data, `prompt ${promptKey(asset)}`, options);
  return {
    prompt: { id: asset.id, version: asset.version, hash: asset.hash },
    text: rendered.text,
    tag: rendered.tag,
  };
}
