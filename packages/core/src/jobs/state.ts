/**
 * Execution state machine of one job (ADR-001: execution state only; editorial state is ADR-010):
 *
 * ```text
 * pending ──► running ──► succeeded
 *    │           ├──────► failed
 *    └───────────┴──────► cancelled
 * ```
 *
 * Terminal states never change again; a re-run is a new job. A retry inside one job increments
 * `attempt` while the job stays `running`.
 */
import type { JobRecord } from '@sargas-recap/contracts';
import { JobError } from './errors.ts';

export type JobStatus = JobRecord['status'];
export type JobStage = JobRecord['stage'];
export type JobInputKind = JobRecord['inputs'][number]['kind'];

// Runtime copies of the contract enums (kept free of a runtime contracts import so the runner
// loads without a contracts build). test/jobs/contract.test.ts asserts they match the contract.
export const JOB_STATUS_VALUES: readonly JobStatus[] = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
];
export const JOB_STAGE_VALUES: readonly JobStage[] = [
  'import',
  'seal',
  'chunk-plan',
  'transcribe',
  'classify',
  'recap',
  'export',
];
export const JOB_INPUT_KIND_VALUES: readonly JobInputKind[] = [
  'artifact',
  'config',
  'glossary',
  'prompt',
  'model',
  'chunk-plan',
  'overrides',
];

export const JOB_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = Object.freeze({
  pending: ['running', 'cancelled'],
  running: ['succeeded', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
});

export const TERMINAL_STATUSES: readonly JobStatus[] = ['succeeded', 'failed', 'cancelled'];

export function isJobStatus(value: string): value is JobStatus {
  return (JOB_STATUS_VALUES as readonly string[]).includes(value);
}

export function isJobStage(value: string): value is JobStage {
  return (JOB_STAGE_VALUES as readonly string[]).includes(value);
}

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) {
    throw new JobError('JOB_INVALID_TRANSITION', `a ${from} job cannot become ${to}`);
  }
}
