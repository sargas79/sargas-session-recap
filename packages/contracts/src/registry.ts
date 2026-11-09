import type { TSchema } from '@sinclair/typebox';
import { CampaignConfigSchema } from './schemas/campaign-config.ts';
import { ChunkPlanSchema } from './schemas/chunk-plan.ts';
import { ClassificationCorrectionsReportSchema } from './schemas/classification-corrections-report.ts';
import { ClassificationResultSchema } from './schemas/classification-result.ts';
import { ClassificationWindowOutputSchema } from './schemas/classification-window-output.ts';
import { EffectiveTranscriptReviewSchema } from './schemas/effective-transcript-review.ts';
import { EffectiveTranscriptSchema } from './schemas/effective-transcript.ts';
import { FoundryEventSchema } from './schemas/foundry-event.ts';
import { FragmentSchema } from './schemas/fragment.ts';
import { GlossarySchema } from './schemas/glossary.ts';
import { ImportMappingSchema } from './schemas/import-mapping.ts';
import { JobRecordSchema } from './schemas/job-record.ts';
import { ManifestSchema } from './schemas/manifest.ts';
import { RecapApprovalSchema } from './schemas/recap-approval.ts';
import { RecapEditorialTransitionSchema } from './schemas/recap-editorial-transition.ts';
import { RecapExportManifestSchema } from './schemas/recap-export-manifest.ts';
import { RecapModelOutputSchema } from './schemas/recap-model-output.ts';
import { RecapPackageSchema } from './schemas/recap-package.ts';
import { RecapSentenceEditSchema } from './schemas/recap-sentence-edit.ts';
import { RecapSchema } from './schemas/recap.ts';
import { ReviewOverrideSchema } from './schemas/review-override.ts';
import { ToolsLockSchema, WhisperOverridesSchema } from './schemas/tools-lock.ts';
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
  'chunk-plan': {
    schema: ChunkPlanSchema,
    title: 'Per-speaker chunk plan',
    where: 'chunk-plans/<plan hash>.json',
  },
  'classification-result': {
    schema: ClassificationResultSchema,
    title: 'Classification result',
    where: 'classify/<classification_run_id>/results.jsonl (one record per line)',
  },
  'classification-window-output': {
    schema: ClassificationWindowOutputSchema,
    title: 'Classification model output for one window',
    where: 'the response of one LLM call (T11); core turns it into classification-result records',
  },
  'classification-corrections-report': {
    schema: ClassificationCorrectionsReportSchema,
    title: 'Classification corrections report',
    where: 'classify/<classification_run_id>/corrections-report.json',
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
  'effective-transcript-review': {
    schema: EffectiveTranscriptReviewSchema,
    title: 'Effective transcript with provenance, for GM review (derived)',
    where: 'computed on demand (T12); never authoritative',
  },
  recap: {
    schema: RecapSchema,
    title: 'Generated recap draft',
    where: 'recap/<revision>/recap.json',
  },
  'recap-model-output': {
    schema: RecapModelOutputSchema,
    title: 'Recap model output',
    where: 'the response of one LLM call (T13); core turns it into a recap record',
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
  'campaign-config': {
    schema: CampaignConfigSchema,
    title: 'Campaign config',
    where: 'campaign.yaml in the data root, outside git (T04)',
  },
  glossary: {
    schema: GlossarySchema,
    title: 'Campaign glossary',
    where: 'glossary.yaml in the data root, outside git (T04)',
  },
  'import-mapping': {
    schema: ImportMappingSchema,
    title: 'Multitrack import mapping',
    where: 'recap-tracks.yaml next to the imported tracks, or --mapping (T05)',
  },
  'recap-sentence-edit': {
    schema: RecapSentenceEditSchema,
    title: 'Recap edit (title, sentence or GM note)',
    where: 'SQLite recap_edits row (T15, ADR-010)',
  },
  'recap-editorial-transition': {
    schema: RecapEditorialTransitionSchema,
    title: 'Recap editorial state transition',
    where: 'SQLite recap_editorial_transitions row (T15, ADR-010)',
  },
  'recap-approval': {
    schema: RecapApprovalSchema,
    title: 'Recap approval record',
    where: 'SQLite recap_approvals row (T15, ADR-010)',
  },
  'recap-export-manifest': {
    schema: RecapExportManifestSchema,
    title: 'Recap export manifest',
    where: 'SQLite recap_exports row (T15, ADR-010)',
  },
  'tools-lock': {
    schema: ToolsLockSchema,
    title: 'Pinned whisper.cpp binary and models',
    where: 'packages/core/tools.lock.json (T23)',
  },
  'whisper-overrides': {
    schema: WhisperOverridesSchema,
    title: 'Operator-supplied whisper.cpp paths',
    where: '<data-root>/tools/whisper/overrides.yaml, outside git (T23)',
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
