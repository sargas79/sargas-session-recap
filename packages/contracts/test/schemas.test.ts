import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Static } from '@sinclair/typebox';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  CONTRACT_NAMES,
  JSON_SCHEMA_DIALECT,
  LABELS,
  schemaId,
  serializeJsonSchema,
  validateTranscriptionSegment,
  type CONTRACTS,
  type ContractName,
  type ContractTypes,
} from '../src/index.ts';
import { FIXTURES_DIR, SCHEMAS_DIR, readJson, readText } from './helpers.ts';

// Compile-time check: every exported type is exactly the Static<> of its TypeBox schema.
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type TypesMatch = {
  [K in ContractName]: Equals<ContractTypes[K], Static<(typeof CONTRACTS)[K]['schema']>>;
};
type AssertTrue<T extends true> = T;
export type AllTypesMatchSchemas = AssertTrue<TypesMatch[ContractName] extends true ? true : false>;

describe('emitted JSON Schemas', () => {
  it('has exactly one committed file per contract', () => {
    const files = readdirSync(SCHEMAS_DIR).sort();
    expect(files).toEqual(CONTRACT_NAMES.map((n) => `${n}.schema.json`).sort());
  });

  it.each(CONTRACT_NAMES)(
    '%s.schema.json equals the TypeBox output (run `npm run schemas -w @sargas-recap/contracts`)',
    (name) => {
      expect(readText(join(SCHEMAS_DIR, `${name}.schema.json`))).toBe(serializeJsonSchema(name));
    },
  );

  it.each(CONTRACT_NAMES)('%s.schema.json is a valid 2020-12 schema with a stable $id', (name) => {
    const doc = readJson(join(SCHEMAS_DIR, `${name}.schema.json`)) as Record<string, unknown>;
    expect(doc['$schema']).toBe(JSON_SCHEMA_DIALECT);
    expect(doc['$id']).toBe(schemaId(name));
    const ajv = new Ajv2020({ strict: false });
    expect(ajv.validateSchema(doc)).toBe(true);
  });

  it.each(CONTRACT_NAMES)('%s pins schema_version 1 (ADR-002)', (name) => {
    const doc = readJson(join(SCHEMAS_DIR, `${name}.schema.json`)) as {
      required: string[];
      properties: Record<string, { const?: unknown }>;
    };
    expect(doc.required).toContain('schema_version');
    expect(doc.properties['schema_version']?.const).toBe(1);
  });

  it('defines exactly the six classification labels', () => {
    expect([...LABELS]).toEqual(['ic', 'narration', 'rules', 'ooc', 'mixed', 'uncertain']);
  });
});

describe('validation errors', () => {
  it('report paths and keywords but never echo field values or unsafe keys', () => {
    const base = readJson(join(FIXTURES_DIR, 'transcription-segment', 'valid.json')) as Record<
      string,
      unknown
    >;
    const secret = 'SECRET-transcript words that must stay private';
    const doc = {
      ...base,
      segment_id: secret,
      language: secret,
      text_original: 42,
      start_offset_ms: secret,
      [secret]: secret,
      source_spans: [{ fragment_id: secret, start_sample: 0.5, end_sample: 1 }],
    };
    const result = validateTranscriptionSegment(doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const dumped = JSON.stringify(result.errors);
    expect(dumped).not.toContain('SECRET');
    expect(result.errors).toContainEqual({
      path: '/<key>',
      keyword: 'additionalProperties',
      message: 'is not an allowed property',
    });
    expect(result.errors.map((e) => e.path)).toEqual(
      expect.arrayContaining(['/segment_id', '/source_spans/0/start_sample', '/text_original']),
    );
  });

  it('returns the typed value on success', () => {
    const result = validateTranscriptionSegment(
      readJson(join(FIXTURES_DIR, 'transcription-segment', 'valid.json')),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.schema_version).toBe(1);
  });
});
