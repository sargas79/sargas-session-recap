import type { TSchema } from '@sinclair/typebox';
import { ClassificationResultSchema } from './schemas/classification-result.ts';
import { EffectiveTranscriptSchema } from './schemas/effective-transcript.ts';
import { FoundryEventSchema } from './schemas/foundry-event.ts';
import { FragmentSchema } from './schemas/fragment.ts';
import { JobRecordSchema } from './schemas/job-record.ts';
import { ManifestSchema } from './schemas/manifest.ts';
import { RecapPackageSchema } from './schemas/recap-package.ts';
import { RecapSchema } from './schemas/recap.ts';
import { ReviewOverrideSchema } from './schemas/review-override.ts';
import { TranscriptionSegmentSchema } from './schemas/transcription-segment.ts';

export const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

/**
 * Every contract, keyed by its file name (`schemas/<name>.schema.json`,
 * `fixtures/contracts/<name>/`). `title` and `where` document the artifact it describes.
 */
export const CONTRACTS = {
  manifest: {
    schema: ManifestSchema,
    title: 'Session package manifest',
    where: 'manifest.json',
  },
  fragment: {
    schema: FragmentSchema,
    title: 'Audio fragment record',
    where: 'fragments.jsonl (one record per line)',
  },
  'foundry-event': {
    schema: FoundryEventSchema,
    title: 'Foundry event envelope',
    where: 'foundry.jsonl (one record per line)',
  },
  'transcription-segment': {
    schema: TranscriptionSegmentSchema,
    title: 'Transcription segment (immutable)',
    where: 'transcript/<transcription_run_id>/segments.jsonl (one record per line)',
  },
  'classification-result': {
    schema: ClassificationResultSchema,
    title: 'Classification result',
    where: 'classify/<classification_run_id>/results.jsonl (one record per line)',
  },
  'review-override': {
    schema: ReviewOverrideSchema,
    title: 'GM review override',
    where: 'SQLite review_overrides row (T12)',
  },
  'effective-transcript': {
    schema: EffectiveTranscriptSchema,
    title: 'Effective transcript projection (derived)',
    where: 'computed on demand; never authoritative',
  },
  recap: {
    schema: RecapSchema,
    title: 'Generated recap draft',
    where: 'recap/<revision>/recap.json',
  },
  'recap-package': {
    schema: RecapPackageSchema,
    title: 'Exported recap package',
    where: 'export file imported by the Foundry module (T15/T19)',
  },
  'job-record': {
    schema: JobRecordSchema,
    title: 'Job record',
    where: 'SQLite jobs row (T07)',
  },
} as const satisfies Record<string, { schema: TSchema; title: string; where: string }>;

export type ContractName = keyof typeof CONTRACTS;

export const CONTRACT_NAMES = Object.keys(CONTRACTS) as ContractName[];

export function schemaId(name: ContractName): string {
  return `urn:sargas-recap:schema:${name}:v1`;
}

/** Plain JSON Schema 2020-12 document for a contract (what `schemas/<name>.schema.json` holds). */
export function toJsonSchema(name: ContractName): Record<string, unknown> {
  const { schema, title, where } = CONTRACTS[name];
  // Round-trip through JSON: drops TypeBox's symbol keys and yields a plain, ordered document.
  const plain = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  return {
    $schema: JSON_SCHEMA_DIALECT,
    $id: schemaId(name),
    title,
    $comment: `Generated from packages/contracts/src by npm run schemas. Do not edit. Stored as: ${where}.`,
    ...plain,
  };
}

/** Exact file content of `schemas/<name>.schema.json`. */
export function serializeJsonSchema(name: ContractName): string {
  return `${JSON.stringify(toJsonSchema(name), null, 2)}\n`;
}
