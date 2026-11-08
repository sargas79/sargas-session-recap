import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import type { CampaignConfig } from './schemas/campaign-config.ts';
import { CONTRACT_NAMES, schemaId, toJsonSchema, type ContractName } from './registry.ts';
import type { ClassificationResult } from './schemas/classification-result.ts';
import type { EffectiveTranscript } from './schemas/effective-transcript.ts';
import type { FoundryEvent } from './schemas/foundry-event.ts';
import type { Fragment } from './schemas/fragment.ts';
import type { Glossary } from './schemas/glossary.ts';
import type { JobRecord } from './schemas/job-record.ts';
import type { Manifest } from './schemas/manifest.ts';
import type { RecapPackage } from './schemas/recap-package.ts';
import type { Recap } from './schemas/recap.ts';
import type { ReviewOverride } from './schemas/review-override.ts';
import type { TranscriptionSegment } from './schemas/transcription-segment.ts';

/**
 * One actionable validation problem. Contains only the JSON Pointer of the offending location, the
 * failing keyword and a message derived from the schema. It never contains the offending VALUE:
 * values can be transcript text (AGENTS.md section 3).
 */
export interface ValidationIssue {
  /** JSON Pointer into the document, e.g. `/sentences/3/citations/segment_ids/0`. */
  path: string;
  /** JSON Schema keyword that failed, e.g. `pattern`, `required`, `additionalProperties`. */
  keyword: string;
  message: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: ValidationIssue[] };

export interface ContractTypes {
  manifest: Manifest;
  fragment: Fragment;
  'foundry-event': FoundryEvent;
  'transcription-segment': TranscriptionSegment;
  'classification-result': ClassificationResult;
  'review-override': ReviewOverride;
  'effective-transcript': EffectiveTranscript;
  recap: Recap;
  'recap-package': RecapPackage;
  'job-record': JobRecord;
  'campaign-config': CampaignConfig;
  glossary: Glossary;
}

const MAX_ISSUES = 50;
const ARRAY_INDEX = /^\d{1,9}$/;

let vocabulary: Set<string> | undefined;

/** Every property name declared anywhere in the contract schemas. */
function schemaVocabulary(): Set<string> {
  if (vocabulary === undefined) {
    const names = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      if (node === null || typeof node !== 'object') return;
      const obj = node as Record<string, unknown>;
      const props = obj['properties'];
      if (props !== null && typeof props === 'object') {
        for (const key of Object.keys(props)) names.add(key);
      }
      for (const value of Object.values(obj)) walk(value);
    };
    for (const name of CONTRACT_NAMES) walk(toJsonSchema(name));
    vocabulary = names;
  }
  return vocabulary;
}

/**
 * Path segments and property names are echoed only when they come from the schemas themselves
 * (a declared property name) or are array indices. Anything else came from the input document and
 * may be a player name or transcript fragment, so it is masked.
 */
function isSchemaToken(token: string): boolean {
  return ARRAY_INDEX.test(token) || schemaVocabulary().has(token);
}

// ajv-formats is CommonJS; depending on the loader (Node, Vitest, esbuild) and the TypeScript module
// resolution, the default import is the plugin itself or a namespace whose `default` is the plugin.
type AddFormats = (instance: Ajv2020, formats: string[]) => unknown;
const formatsModule = addFormatsModule as unknown as AddFormats & { default?: AddFormats };
const addFormats: AddFormats = formatsModule.default ?? formatsModule;

let ajv: Ajv2020 | undefined;
const compiled = new Map<ContractName, ValidateFunction>();

function getAjv(): Ajv2020 {
  if (ajv === undefined) {
    ajv = new Ajv2020({
      allErrors: true,
      strict: true,
      // Conditional `then: { required: [...] }` names properties declared on the parent object.
      strictRequired: false,
      verbose: false,
    });
    addFormats(ajv, ['date-time', 'date']);
    for (const name of CONTRACT_NAMES) ajv.addSchema(toJsonSchema(name));
  }
  return ajv;
}

function getValidator(name: ContractName): ValidateFunction {
  let fn = compiled.get(name);
  if (fn === undefined) {
    fn = getAjv().getSchema(schemaId(name));
    if (fn === undefined) throw new Error(`contract schema not registered: ${name}`);
    compiled.set(name, fn);
  }
  return fn;
}

function safePath(pointer: string): string {
  if (pointer === '') return '';
  return pointer
    .split('/')
    .slice(1)
    .map((seg) => (isSchemaToken(seg) ? seg : '<key>'))
    .map((seg) => `/${seg}`)
    .join('');
}

function toIssue(err: ErrorObject): ValidationIssue | undefined {
  // `if` only says "must match then schema"; the real failure is reported separately.
  if (err.keyword === 'if') return undefined;
  const path = safePath(err.instancePath);
  const params = err.params as Record<string, unknown>;
  switch (err.keyword) {
    case 'required': {
      const prop = String(params['missingProperty']);
      return { path: `${path}/${prop}`, keyword: err.keyword, message: 'is required' };
    }
    case 'additionalProperties': {
      const prop = String(params['additionalProperty']);
      const shown = isSchemaToken(prop) ? `/${prop}` : '/<key>';
      return {
        path: `${path}${shown}`,
        keyword: err.keyword,
        message: 'is not an allowed property',
      };
    }
    case 'false schema':
      return { path, keyword: err.keyword, message: 'is not allowed in this state' };
    case 'enum': {
      const allowed = (params['allowedValues'] as unknown[]).map((v) => JSON.stringify(v));
      return { path, keyword: err.keyword, message: `must be one of ${allowed.join(', ')}` };
    }
    case 'const':
      return {
        path,
        keyword: err.keyword,
        message: `must be ${JSON.stringify(params['allowedValue'])}`,
      };
    default:
      // Ajv messages (verbose: false) are built from the schema, never from the data.
      return { path, keyword: err.keyword, message: err.message ?? 'is invalid' };
  }
}

/** Validate `data` against a named contract. Never throws on bad data; never echoes values. */
export function validateContract<N extends ContractName>(
  name: N,
  data: unknown,
): ValidationResult<ContractTypes[N]> {
  const fn = getValidator(name);
  if (fn(data)) return { ok: true, value: data as ContractTypes[N] };
  const seen = new Set<string>();
  const errors: ValidationIssue[] = [];
  for (const err of fn.errors ?? []) {
    const issue = toIssue(err);
    if (issue === undefined) continue;
    const key = `${issue.path}\u0000${issue.keyword}\u0000${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    errors.push(issue);
    if (errors.length >= MAX_ISSUES) break;
  }
  return { ok: false, errors };
}

/** Render issues as `<label>: <path>: <message>` lines (safe to log: no values). */
export function formatIssues(errors: readonly ValidationIssue[], label = 'document'): string {
  return errors.map((e) => `${label}: ${e.path === '' ? '/' : e.path}: ${e.message}`).join('\n');
}

export const validateManifest = (data: unknown) => validateContract('manifest', data);
export const validateFragment = (data: unknown) => validateContract('fragment', data);
export const validateFoundryEvent = (data: unknown) => validateContract('foundry-event', data);
export const validateTranscriptionSegment = (data: unknown) =>
  validateContract('transcription-segment', data);
export const validateClassificationResult = (data: unknown) =>
  validateContract('classification-result', data);
export const validateReviewOverride = (data: unknown) => validateContract('review-override', data);
export const validateEffectiveTranscript = (data: unknown) =>
  validateContract('effective-transcript', data);
export const validateRecap = (data: unknown) => validateContract('recap', data);
export const validateRecapPackage = (data: unknown) => validateContract('recap-package', data);
export const validateJobRecord = (data: unknown) => validateContract('job-record', data);
export const validateCampaignConfig = (data: unknown) => validateContract('campaign-config', data);
export const validateGlossary = (data: unknown) => validateContract('glossary', data);
