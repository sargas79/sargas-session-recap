/**
 * Canonical contracts shared by core and the Foundry module: TypeBox schemas, their static types,
 * JSON Schema 2020-12 emission and Ajv validators. See docs/adr/ for the decisions behind them.
 *
 * Browser-safe: no Node built-ins anywhere under src/ (checked by test/no-node-imports.test.ts).
 */
export * from './common.ts';
export * from './content-hash.ts';
export * from './registry.ts';
export * from './validate.ts';
export * from './schemas/asr-config.ts';
export * from './schemas/campaign-config.ts';
export * from './schemas/chunk-plan.ts';
export * from './schemas/classification-corrections-report.ts';
export * from './schemas/classification-result.ts';
export * from './schemas/classification-window-output.ts';
export * from './schemas/effective-transcript.ts';
export * from './schemas/effective-transcript-review.ts';
export * from './schemas/foundry-event.ts';
export * from './schemas/fragment.ts';
export * from './schemas/glossary.ts';
export * from './schemas/import-mapping.ts';
export * from './schemas/job-record.ts';
export * from './schemas/manifest.ts';
export * from './schemas/recap-approval.ts';
export * from './schemas/recap-editorial-transition.ts';
export * from './schemas/recap-export-manifest.ts';
export * from './schemas/recap-model-output.ts';
export * from './schemas/recap-package.ts';
export * from './schemas/recap-sentence-edit.ts';
export * from './schemas/recap.ts';
export * from './schemas/review-override.ts';
export * from './schemas/tools-lock.ts';
export * from './schemas/transcription-segment.ts';
export * from './sha256.ts';
