/**
 * The GM's actions from the screen and the API (T14). Each one validates its request and then calls
 * the same service as the matching CLI command (`recap overrides set`, `reconcile --segment`,
 * `reconcile --discard`, `recap run recap`). No review or recap logic lives here.
 */
import { LABELS, type ClassificationLabel } from '@sargas-recap/contracts';
import type { EditRequest, SpoilerAcknowledgement } from '../recap/editorial.ts';
import { unreconciledExclusions } from '../review/project.ts';
import {
  discardUnreconciled,
  loadSessionReview,
  reconcileToSegment,
  setSegmentOverride,
  type SessionRef,
} from '../review/session.ts';
import {
  listOverrides,
  type ExclusionReason,
  type OverrideChanges,
  type RecapInclusion,
  type ReviewStatus,
  type StoredOverride,
} from '../review/store.ts';
import { ReviewUiError } from './errors.ts';

export const INCLUSION_CHOICES = ['default', 'include', 'unresolved', 'exclude'] as const;
export const STATUS_CHOICES = ['pending', 'reviewed'] as const;
export const EXCLUSION_CHOICES = ['spoiler', 'privacy', 'off-topic'] as const;

export interface OverrideRequest {
  readonly changes: OverrideChanges;
  /** The revision the GM was looking at; 0 means no override existed yet. */
  readonly expectedRevision: number | undefined;
}

function bad(message: string): ReviewUiError {
  return new ReviewUiError(400, 'REVIEW_UI_BAD_REQUEST', message);
}

function asObject(value: unknown, what: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw bad(`${what} must be a JSON object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function onlyKeys(
  body: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  what: string,
): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw bad(`${what}: unknown field`);
  }
}

function oneOf<T extends string>(field: string, value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw bad(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

const OVERRIDE_FIELDS = ['label', 'inclusion', 'text', 'exclusions', 'status', 'expected_revision'];

/** Absent means "leave it alone" and `null` clears it, exactly like the CLI's flags. */
export function parseOverrideRequest(raw: unknown): OverrideRequest {
  const body = asObject(raw, 'the override');
  onlyKeys(body, OVERRIDE_FIELDS, 'the override');
  const { label, inclusion, text, exclusions, status, expected_revision: expected } = body;
  if (text !== undefined && text !== null && typeof text !== 'string') {
    throw bad('text must be a string or null');
  }
  if (exclusions !== undefined && !Array.isArray(exclusions)) {
    throw bad('exclusions must be a list');
  }
  if (
    expected !== undefined &&
    (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0)
  ) {
    throw bad('expected_revision must be a non-negative integer');
  }
  const changes: OverrideChanges = {
    ...(label === undefined
      ? {}
      : {
          labelOverride: label === null ? null : oneOf<ClassificationLabel>('label', label, LABELS),
        }),
    ...(inclusion === undefined
      ? {}
      : {
          recapInclusion:
            inclusion === 'default'
              ? null
              : (oneOf('inclusion', inclusion, INCLUSION_CHOICES) as RecapInclusion),
        }),
    ...(text === undefined ? {} : { textOverride: text }),
    ...(exclusions === undefined
      ? {}
      : {
          exclusionReasons: (exclusions as unknown[]).map((reason): ExclusionReason =>
            oneOf('exclusions', reason, EXCLUSION_CHOICES),
          ),
        }),
    ...(status === undefined
      ? {}
      : { reviewStatus: oneOf<ReviewStatus>('status', status, STATUS_CHOICES) }),
  };
  if (Object.keys(changes).length === 0) throw bad('nothing to set: pass at least one change');
  return { changes, expectedRevision: expected };
}

const FORM_FIELDS = [...OVERRIDE_FIELDS, 'exclusions_present'];

/**
 * A browser form as the JSON body of the API. An empty select or text box means "no value", and
 * unchecked boxes send nothing, so forms that show the exclusions also send `exclusions_present`.
 */
export function overrideBodyFromForm(form: URLSearchParams): Record<string, unknown> {
  for (const key of form.keys()) {
    if (!FORM_FIELDS.includes(key)) throw bad('the override: unknown field');
  }
  const body: Record<string, unknown> = {};
  const label = form.get('label');
  if (label !== null) body['label'] = label === '' ? null : label;
  const text = form.get('text');
  if (text !== null) body['text'] = text.trim() === '' ? null : text;
  const inclusion = form.get('inclusion');
  if (inclusion !== null) body['inclusion'] = inclusion;
  const status = form.get('status');
  if (status !== null) body['status'] = status;
  if (form.has('exclusions_present')) body['exclusions'] = form.getAll('exclusions');
  const expected = form.get('expected_revision');
  if (expected !== null) body['expected_revision'] = Number(expected);
  return body;
}

function isNoChange(changes: OverrideChanges): boolean {
  return (
    (changes.labelOverride ?? null) === null &&
    (changes.recapInclusion ?? null) === null &&
    (changes.textOverride ?? null) === null &&
    (changes.exclusionReasons ?? []).length === 0 &&
    (changes.reviewStatus ?? 'pending') === 'pending'
  );
}

/**
 * Applies an override through the T12 service. Refuses when the override changed after the GM
 * loaded the page (another tab or the CLI), so a stale form cannot undo a newer decision.
 */
export async function applyOverride(
  ref: SessionRef,
  segmentId: string,
  request: OverrideRequest,
): Promise<StoredOverride | null> {
  const current = listOverrides(ref.db, ref.campaignId, ref.sessionId).find(
    (override) => override.segment_id === segmentId,
  );
  if (
    request.expectedRevision !== undefined &&
    (current?.revision ?? 0) !== request.expectedRevision
  ) {
    throw new ReviewUiError(
      409,
      'REVIEW_UI_STALE',
      `the override of ${segmentId} changed after this page was loaded`,
      'reload the page and make the change again',
    );
  }
  // An untouched form on a line with no override must not create an empty one.
  if (current === undefined && isNoChange(request.changes)) return null;
  return setSegmentOverride(ref, segmentId, request.changes);
}

export function parseReconcileTarget(raw: unknown): string {
  const body = asObject(raw, 'the request');
  onlyKeys(body, ['segment_id'], 'the request');
  const target = body['segment_id'];
  if (typeof target !== 'string' || target.trim() === '') throw bad('segment_id is required');
  return target.trim();
}

export function applyReconcile(
  ref: SessionRef,
  overrideId: string,
  segmentId: string,
): Promise<StoredOverride> {
  return reconcileToSegment(ref, overrideId, segmentId);
}

export function applyDiscard(ref: SessionRef, overrideId: string): Promise<void> {
  return discardUnreconciled(ref, overrideId);
}

export function assertNoFields(raw: unknown): void {
  onlyKeys(asObject(raw, 'the request'), [], 'the request');
}

/** Generation sends text to the provider, so the screen asks and the server checks. */
export function assertRegenerationConfirmed(raw: unknown): void {
  const body = asObject(raw, 'the request');
  onlyKeys(body, ['confirm'], 'the request');
  if (body['confirm'] !== 'yes') {
    throw bad('regeneration needs confirm=yes: it sends the included lines to the provider');
  }
}

const EDIT_FIELDS = [
  'target_kind',
  'target_id',
  'action',
  'text',
  'citations',
  'expected_edit_count',
];

function stringOf(field: string, value: unknown): string {
  if (typeof value !== 'string') throw bad(`${field} must be a string`);
  return value;
}

function stringList(field: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw bad(`${field} must be a list of strings`);
  }
  return value as string[];
}

function countOf(field: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw bad(`${field} must be a non-negative integer`);
  }
  return value;
}

const EDIT_TARGETS = ['title', 'sentence', 'gm_note'] as const;
const EDIT_ACTIONS = ['replace', 'remove', 'revert'] as const;

function parseEditCitations(raw: unknown): NonNullable<EditRequest['citations']> | undefined {
  if (raw === undefined) return undefined;
  const citations = asObject(raw, 'citations');
  onlyKeys(citations, ['segment_ids', 'event_ids'], 'citations');
  return {
    segment_ids: stringList('citations.segment_ids', citations['segment_ids']),
    ...(citations['event_ids'] === undefined
      ? {}
      : { event_ids: stringList('citations.event_ids', citations['event_ids']) }),
  };
}

export function parseEditRequest(raw: unknown): EditRequest {
  const body = asObject(raw, 'the edit');
  onlyKeys(body, EDIT_FIELDS, 'the edit');
  return {
    targetKind: oneOf('target_kind', body['target_kind'], EDIT_TARGETS),
    targetId: stringOf('target_id', body['target_id']),
    action: oneOf('action', body['action'], EDIT_ACTIONS),
    ...(body['text'] === undefined ? {} : { text: stringOf('text', body['text']) }),
    citations: parseEditCitations(body['citations']),
    expectedEditCount: countOf('expected_edit_count', body['expected_edit_count']),
  };
}

/**
 * An edit form as the JSON body of the API. The citations box holds whitespace- or comma-separated
 * segment refs; it is sent only by a sentence's own form, and ignored unless replacing.
 */
export function editBodyFromForm(form: URLSearchParams): Record<string, unknown> {
  for (const key of form.keys()) {
    if (!EDIT_FIELDS.includes(key)) throw bad('the edit: unknown field');
  }
  const action = form.get('action');
  const text = form.get('text');
  const citations = form.get('citations');
  const body: Record<string, unknown> = {
    target_kind: form.get('target_kind'),
    target_id: form.get('target_id'),
    action,
    expected_edit_count: Number(form.get('expected_edit_count') ?? 'NaN'),
  };
  if (action === 'replace') {
    if (text !== null) body['text'] = text;
    if (citations !== null) {
      body['citations'] = {
        segment_ids: citations.split(/[\s,]+/).filter((id) => id !== ''),
      };
    }
  }
  return body;
}

export interface ReleaseRequest {
  readonly expectedHash: string;
  readonly spoilers: SpoilerAcknowledgement;
}

/** Review, approval and export must name the exact content hash the GM looked at. */
export function parseExpectedHash(raw: unknown): string {
  const body = asObject(raw, 'the request');
  onlyKeys(body, ['expected_hash'], 'the request');
  return stringOf('expected_hash', body['expected_hash']);
}

export function parseReleaseRequest(raw: unknown): ReleaseRequest {
  const body = asObject(raw, 'the request');
  onlyKeys(body, ['expected_hash', 'spoilers_ack', 'spoilers_confirm'], 'the request');
  return {
    expectedHash: stringOf('expected_hash', body['expected_hash']),
    spoilers: {
      segmentIds:
        body['spoilers_ack'] === undefined ? [] : stringList('spoilers_ack', body['spoilers_ack']),
      confirmed: body['spoilers_confirm'] === 'yes',
    },
  };
}

export function releaseBodyFromForm(form: URLSearchParams): Record<string, unknown> {
  for (const key of form.keys()) {
    if (!['expected_hash', 'spoilers_ack', 'spoilers_confirm'].includes(key)) {
      throw bad('the request: unknown field');
    }
  }
  const body: Record<string, unknown> = {
    expected_hash: form.get('expected_hash'),
    spoilers_ack: form.getAll('spoilers_ack'),
  };
  const confirm = form.get('spoilers_confirm');
  if (confirm !== null) body['spoilers_confirm'] = confirm;
  return body;
}

/** A revision number from a route. */
export function parseRevision(value: string | undefined): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) throw bad('the revision is not valid');
  return revision;
}

/** The check of ADR-005, point 7, in time to tell the GM. The stage enforces it again. */
export async function assertNoLostExclusions(ref: SessionRef): Promise<void> {
  const { view } = await loadSessionReview(ref);
  const lost = unreconciledExclusions(view);
  if (lost.length > 0) {
    throw new ReviewUiError(
      409,
      'REVIEW_UI_UNRECONCILED',
      `${String(lost.length)} spoiler or privacy exclusion(s) no longer apply to any segment`,
      'reconcile or discard them first',
    );
  }
}
