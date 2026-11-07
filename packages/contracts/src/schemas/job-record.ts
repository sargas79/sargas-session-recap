import { Type, type Static } from '@sinclair/typebox';
import {
  CampaignId,
  Count,
  Hash,
  RecapRevision,
  RelPath,
  SchemaVersion1,
  SessionId,
  Slug,
  StringEnum,
  Timestamp,
  Ulid,
  when,
} from '../common.ts';

export const JOB_STAGES = [
  'import',
  'seal',
  'chunk-plan',
  'transcribe',
  'classify',
  'recap',
  'export',
] as const;
export const JOB_STATUSES = ['pending', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export const JOB_INPUT_KINDS = [
  'artifact',
  'config',
  'glossary',
  'prompt',
  'model',
  'chunk-plan',
  'overrides',
] as const;

/**
 * One row of SQLite `jobs` (T07), authoritative there only (ADR-001). Execution state only:
 * editorial state is separate (ADR-010, reserved). Inputs and outputs are recorded by hash.
 */
export const JobRecordSchema = Type.Object(
  {
    schema_version: SchemaVersion1,
    job_id: Ulid(),
    campaign_id: CampaignId(),
    session_id: SessionId(),
    stage: StringEnum(JOB_STAGES),
    status: StringEnum(JOB_STATUSES),
    attempt: Type.Integer({ minimum: 1, maximum: 100 }),
    max_attempts: Type.Integer({ minimum: 1, maximum: 100 }),
    inputs: Type.Array(
      Type.Object(
        {
          kind: StringEnum(JOB_INPUT_KINDS),
          ref: Type.String({
            minLength: 1,
            maxLength: 240,
            description: 'Path, name or model ID.',
          }),
          hash: Hash(),
        },
        { additionalProperties: false },
      ),
    ),
    output_run_id: Type.Optional(
      Ulid({ description: 'transcription_run_id or classification_run_id this job produces.' }),
    ),
    output_recap_revision: Type.Optional(RecapRevision()),
    outputs: Type.Array(
      Type.Object({ path: RelPath(), hash: Hash() }, { additionalProperties: false }),
    ),
    usage: Type.Optional(
      Type.Object(
        {
          input_tokens: Count(),
          output_tokens: Count(),
          cost_micro_usd: Type.Optional(Count({ description: 'Integer micro-USD (no floats).' })),
        },
        { additionalProperties: false },
      ),
    ),
    error: Type.Optional(
      Type.Object(
        {
          code: Slug(),
          message: Type.String({
            minLength: 1,
            maxLength: 500,
            description: 'Actionable; never contains transcript, prompt or secret content.',
          }),
          retryable: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
    created_at: Timestamp(),
    started_at: Type.Optional(Timestamp()),
    finished_at: Type.Optional(Timestamp()),
  },
  {
    additionalProperties: false,
    allOf: [
      when('status', ['running', 'succeeded', 'failed'], {
        required: ['started_at'],
      }),
      when('status', ['succeeded', 'failed', 'cancelled'], { required: ['finished_at'] }),
      when('status', ['failed'], { required: ['error'] }),
      when('status', ['pending', 'running', 'succeeded'], { properties: { error: false } }),
    ],
  },
);
export type JobRecord = Static<typeof JobRecordSchema>;
