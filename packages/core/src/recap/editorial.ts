/**
 * Recap editing, editorial state, approval and export (T15, ADR-007, ADR-010).
 *
 * A generated draft is never written again: edits go to an append-only log and the effective
 * content is derived from the two on demand. Approval is one immutable row bound to one
 * `(revision, content_hash)`, in force only while the latest transition says so, so any content
 * edit ends it. Export and Copy Markdown serve only an approved, hash-matching revision; GM notes
 * and excluded text cannot reach them. No error or log here carries recap or transcript text.
 */
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  canonicalContentHash,
  recapContentFromPackage,
  validateContract,
  type EditorialState,
  type EffectiveTranscriptReview,
  type Recap,
  type RecapApproval,
  type RecapCitations,
  type RecapEditorialTransition,
  type RecapExportManifest,
  type RecapSentenceEdit,
} from '@sargas-recap/contracts';
import { ulid } from '../ids/ulid.ts';
import { listJobs, type Job } from '../jobs/store.ts';
import {
  finalizeDirectory,
  realPackageRoot,
  resolveInsidePackage,
  sha256Bytes,
  sha256File,
  tempDirFor,
  writeFileAtomic,
} from '../package/index.ts';
import { unreconciledExclusions } from '../review/project.ts';
import {
  findJobOutput,
  loadSessionReview,
  readJobOutput,
  type SessionRef,
} from '../review/session.ts';
import { ReviewError } from '../review/errors.ts';
import { RecapEditorialError } from './errors.ts';
import {
  assertRecord,
  currentState,
  getApproval,
  getRevisionRow,
  insertApproval,
  insertEdit,
  insertExport,
  insertTransition,
  latestCompleteFork,
  listEdits,
  listExports,
  listTransitions,
  recordForkDraftHash,
  type RevisionKey,
} from './editorial-store.ts';
import { buildRecapPackage, EXPORT_GENERATOR_VERSION } from './export-package.ts';
import { renderRecapMarkdown, type SegmentSources } from './render.ts';
import { allocateForkRevision } from './revisions.ts';

export type EffectiveSentence = Recap['sentences'][number] & { readonly edited: boolean };
export type EffectiveNote = Recap['gm_notes'][number] & { readonly edited: boolean };

/** Draft + edits (ADR-010, section 2). `removed*` are for the GM's screen only. */
export interface EffectiveRecap {
  readonly language: string;
  readonly title: string;
  readonly titleEdited: boolean;
  readonly sentences: readonly EffectiveSentence[];
  readonly removedSentences: readonly EffectiveSentence[];
  readonly gmNotes: readonly EffectiveNote[];
  readonly removedNotes: readonly EffectiveNote[];
}

export type ReleaseBlockerCode =
  | 'unreconciled-exclusions'
  | 'cites-excluded'
  | 'cites-unresolved'
  | 'cites-missing'
  | 'no-sentences';

/** Why a revision may not be approved, exported or copied. Holds IDs only. */
export interface ReleaseBlocker {
  readonly code: ReleaseBlockerCode;
  readonly message: string;
  readonly sentenceId?: string | undefined;
  readonly segmentId?: string | undefined;
}

export interface RecapEditorialView {
  readonly revision: number;
  readonly origin: 'generated' | 'fork';
  readonly parentRevision: number | undefined;
  readonly draft: Recap;
  readonly effective: EffectiveRecap;
  readonly contentHash: string;
  readonly state: EditorialState;
  /** What a form must send back as its expected edit count. */
  readonly editCount: number;
  /** The approval in force, or `null`. */
  readonly approval: RecapApproval | null;
  readonly exports: readonly RecapExportManifest[];
  readonly blockers: readonly ReleaseBlocker[];
  /** Possible-spoiler lines still included in the recap; the GM must acknowledge them. */
  readonly spoilersIncluded: readonly string[];
  /** Copy Markdown text, present only when this revision may be copied. */
  readonly markdown: string | null;
}

const clock = (ref: SessionRef): Date => (ref.now ?? (() => new Date()))();

function keyOf(ref: SessionRef, revision: number): RevisionKey {
  return { db: ref.db, campaignId: ref.campaignId, sessionId: ref.sessionId, revision };
}

/** Line endings and NFC are normalized on the way in, so the editor makes no spurious changes. */
export function normalizeEditText(text: string): string {
  return text.replace(/\r\n?/g, '\n').normalize('NFC');
}

function latestEdits(edits: readonly RecapSentenceEdit[]): Map<string, RecapSentenceEdit> {
  const latest = new Map<string, RecapSentenceEdit>();
  for (const edit of edits) latest.set(`${edit.target_kind}\u0000${edit.target_id}`, edit);
  return latest;
}

/** The effective content of a revision from its immutable draft and its edits. */
export function effectiveRecap(draft: Recap, edits: readonly RecapSentenceEdit[]): EffectiveRecap {
  const latest = latestEdits(edits);
  const titleEdit = latest.get('title\u0000title');
  const titleReplaced = titleEdit?.action === 'replace';
  const sentences: EffectiveSentence[] = [];
  const removedSentences: EffectiveSentence[] = [];
  for (const sentence of draft.sentences) {
    const edit = latest.get(`sentence\u0000${sentence.sentence_id}`);
    if (edit?.action === 'remove') {
      removedSentences.push({ ...sentence, edited: false });
    } else if (edit?.action === 'replace') {
      sentences.push({
        ...sentence,
        text: edit.text ?? sentence.text,
        citations: edit.citations ?? sentence.citations,
        edited: true,
      });
    } else {
      sentences.push({ ...sentence, edited: false });
    }
  }
  const gmNotes: EffectiveNote[] = [];
  const removedNotes: EffectiveNote[] = [];
  for (const note of draft.gm_notes) {
    const edit = latest.get(`gm_note\u0000${note.note_id}`);
    if (edit?.action === 'remove') removedNotes.push({ ...note, edited: false });
    else if (edit?.action === 'replace') {
      gmNotes.push({ ...note, text: edit.text ?? note.text, edited: true });
    } else gmNotes.push({ ...note, edited: false });
  }
  return {
    language: draft.language,
    title: titleReplaced ? (titleEdit.text ?? draft.title) : draft.title,
    titleEdited: titleReplaced,
    sentences,
    removedSentences,
    gmNotes,
    removedNotes,
  };
}

function findGeneratedJob(ref: SessionRef, revision: number): Job | undefined {
  return listJobs(ref.db, ref.campaignId, ref.sessionId).find(
    (job) =>
      job.stage === 'recap' && job.status === 'succeeded' && job.outputRecapRevision === revision,
  );
}

/** The job behind a revision, walking up a fork's parents. */
export function generationJob(ref: SessionRef, revision: number): Job | undefined {
  let current: number | undefined = revision;
  while (current !== undefined) {
    const job = findGeneratedJob(ref, current);
    if (job !== undefined) return job;
    current = getRevisionRow(keyOf(ref, current))?.parentRevision;
  }
  return undefined;
}

/** The revision the GM works on: the highest finished one, generated or forked. */
export function latestRecapRevision(ref: SessionRef): number | undefined {
  const generated = listJobs(ref.db, ref.campaignId, ref.sessionId).flatMap((job) =>
    job.stage === 'recap' && job.status === 'succeeded' && job.outputRecapRevision !== undefined
      ? [job.outputRecapRevision]
      : [],
  );
  const fork = latestCompleteFork(ref.db, ref.campaignId, ref.sessionId);
  const all = fork === undefined ? generated : [...generated, fork];
  return all.length === 0 ? undefined : Math.max(...all);
}

function notFound(revision: number): RecapEditorialError {
  return new RecapEditorialError(
    'RECAP_REVISION_NOT_FOUND',
    `no recap revision ${String(revision)}`,
  );
}

/** Reads a revision's draft and proves it is the file that was recorded. */
export async function loadRecapDraft(ref: SessionRef, revision: number): Promise<Recap> {
  const job = findGeneratedJob(ref, revision);
  const row = getRevisionRow(keyOf(ref, revision));
  if (job === undefined && (row?.origin !== 'fork' || row.draftSha256 === undefined)) {
    throw notFound(revision);
  }
  const root = await realPackageRoot(ref.paths.sessionDir(ref.campaignId, ref.sessionId));
  const rel = `recap/${String(revision)}/recap.json`;
  let text: string;
  if (job !== undefined) {
    text = await readJobOutput(
      root,
      findJobOutput(job, `recap/${String(revision)}/`, 'recap.json'),
    );
  } else {
    const { absolute } = await resolveInsidePackage(root, rel);
    const { hash } = await sha256File(absolute);
    if (hash !== row?.draftSha256) {
      throw new ReviewError('REVIEW_RUN_INVALID', `${rel} differs from what was recorded`);
    }
    text = await readFile(absolute, 'utf8');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ReviewError('REVIEW_RUN_INVALID', `${rel}: bad JSON`);
  }
  const checked = validateContract('recap', parsed);
  if (!checked.ok || checked.value.recap_revision !== revision) {
    throw new ReviewError('REVIEW_RUN_INVALID', `${rel} does not fit the recap contract`);
  }
  return checked.value;
}

function includedSpoilers(view: EffectiveTranscriptReview): string[] {
  return view.segments
    .filter(
      (segment) =>
        segment.classification_flags.includes('possible_spoiler') &&
        segment.recap_inclusion === 'include',
    )
    .map((segment) => segment.segment_id);
}

/** Everything that stops approval, export and copy. A later exclusion reaches them all. */
export function releaseBlockers(
  effective: EffectiveRecap,
  view: EffectiveTranscriptReview,
): ReleaseBlocker[] {
  const blockers: ReleaseBlocker[] = [];
  const lost = unreconciledExclusions(view).length;
  if (lost > 0) {
    blockers.push({
      code: 'unreconciled-exclusions',
      message: `${String(lost)} spoiler or privacy exclusion(s) no longer apply to any segment; reconcile or discard them first`,
    });
  }
  if (effective.sentences.length === 0) {
    blockers.push({ code: 'no-sentences', message: 'the recap has no sentences left' });
  }
  const inclusion = new Map(view.segments.map((s) => [s.segment_id, s.recap_inclusion]));
  for (const sentence of effective.sentences) {
    for (const segmentId of sentence.citations.segment_ids) {
      const state = inclusion.get(segmentId);
      const base = { sentenceId: sentence.sentence_id, segmentId };
      if (state === undefined) {
        blockers.push({
          code: 'cites-missing',
          message: `${sentence.sentence_id} cites ${segmentId}, which is not in the active transcription`,
          ...base,
        });
      } else if (state === 'exclude') {
        blockers.push({
          code: 'cites-excluded',
          message: `${sentence.sentence_id} cites ${segmentId}, which you excluded; change its citations or remove the sentence`,
          ...base,
        });
      } else if (state === 'unresolved') {
        blockers.push({
          code: 'cites-unresolved',
          message: `${sentence.sentence_id} cites ${segmentId}, which is waiting for your decision`,
          ...base,
        });
      }
    }
  }
  return blockers;
}

interface RevisionContext {
  readonly key: RevisionKey;
  readonly draft: Recap;
  readonly edits: readonly RecapSentenceEdit[];
  readonly transitions: readonly RecapEditorialTransition[];
  readonly state: EditorialState;
  readonly effective: EffectiveRecap;
  readonly hash: string;
}

async function loadContext(ref: SessionRef, revision: number): Promise<RevisionContext> {
  const key = keyOf(ref, revision);
  const draft = await loadRecapDraft(ref, revision);
  const edits = listEdits(key);
  const transitions = listTransitions(key);
  const effective = effectiveRecap(draft, edits);
  return {
    key,
    draft,
    edits,
    transitions,
    state: currentState(transitions),
    effective,
    hash: canonicalContentHash(effective),
  };
}

/** The approval in force: only the latest transition can carry one (ADR-010). */
function approvalInForce(context: RevisionContext): RecapApproval | null {
  const last = context.transitions[context.transitions.length - 1];
  if (last?.approval_id === undefined) return null;
  if (last.trigger !== 'approve' && last.trigger !== 'export') return null;
  return getApproval(context.key, last.approval_id) ?? null;
}

function sourcesOf(view: EffectiveTranscriptReview): SegmentSources {
  return new Map(
    view.segments.map((s) => [
      s.segment_id,
      { speakerId: s.speaker_id, startOffsetMs: s.start_offset_ms },
    ]),
  );
}

function markdownOf(context: RevisionContext, view: EffectiveTranscriptReview): string {
  const { draft, effective } = context;
  return renderRecapMarkdown(
    { ...draft, title: effective.title, sentences: [...effective.sentences], gm_notes: [] },
    sourcesOf(view),
  );
}

function mayCopy(
  context: RevisionContext,
  approval: RecapApproval | null,
  blockers: readonly ReleaseBlocker[],
): boolean {
  return (
    (context.state === 'approved' || context.state === 'exported') &&
    approval !== null &&
    approval.content_hash === context.hash &&
    blockers.length === 0
  );
}

export async function loadEditorialView(
  ref: SessionRef,
  revision: number,
  view: EffectiveTranscriptReview,
): Promise<RecapEditorialView> {
  const context = await loadContext(ref, revision);
  const row = getRevisionRow(context.key);
  const approval = approvalInForce(context);
  const blockers = releaseBlockers(context.effective, view);
  return {
    revision,
    origin: row?.origin ?? 'generated',
    parentRevision: row?.parentRevision,
    draft: context.draft,
    effective: context.effective,
    contentHash: context.hash,
    state: context.state,
    editCount: context.edits.length,
    approval,
    exports: listExports(context.key),
    blockers,
    spoilersIncluded: includedSpoilers(view),
    markdown: mayCopy(context, approval, blockers) ? markdownOf(context, view) : null,
  };
}

function stale(what: string): RecapEditorialError {
  return new RecapEditorialError(
    'RECAP_STALE',
    `${what} changed after this page was loaded`,
    'reload the page and try again',
  );
}

/** A transaction re-reads the logs and refuses if anything moved since the guards ran. */
function assertUnmoved(context: RevisionContext): void {
  if (
    listEdits(context.key).length !== context.edits.length ||
    listTransitions(context.key).length !== context.transitions.length
  ) {
    throw stale(`revision ${String(context.key.revision)}`);
  }
}

export interface EditRequest {
  readonly targetKind: RecapSentenceEdit['target_kind'];
  readonly targetId: string;
  readonly action: RecapSentenceEdit['action'];
  readonly text?: string | undefined;
  /** Sentence replace only. Segment IDs in full or as `<chunk>:<seq>`; events default to current. */
  readonly citations?:
    | {
        readonly segment_ids: readonly string[];
        readonly event_ids?: readonly string[] | undefined;
      }
    | undefined;
  /** How many edits the GM's page knew about; a mismatch is a stale form. */
  readonly expectedEditCount: number;
}

export interface EditOutcome {
  readonly changed: boolean;
  readonly forked: boolean;
  readonly revision: number;
  readonly state: EditorialState;
  readonly contentHash: string;
}

interface TargetState {
  readonly text: string;
  readonly citations: RecapCitations;
  readonly edited: boolean;
  readonly removed: boolean;
}

const NO_CITATIONS: RecapCitations = { segment_ids: [], event_ids: [] };

function targetState(draft: Recap, effective: EffectiveRecap, request: EditRequest): TargetState {
  const missing = (): RecapEditorialError =>
    new RecapEditorialError(
      'RECAP_TARGET_NOT_FOUND',
      `revision ${String(draft.recap_revision)} has no ${request.targetKind} ${request.targetId}`,
    );
  if (request.targetKind === 'title') {
    if (request.targetId !== 'title') throw missing();
    return {
      text: effective.title,
      citations: NO_CITATIONS,
      edited: effective.titleEdited,
      removed: false,
    };
  }
  if (request.targetKind === 'sentence') {
    if (!draft.sentences.some((s) => s.sentence_id === request.targetId)) throw missing();
    const live = effective.sentences.find((s) => s.sentence_id === request.targetId);
    const removed = effective.removedSentences.find((s) => s.sentence_id === request.targetId);
    const current = live ?? removed;
    if (current === undefined) throw missing();
    return {
      text: current.text,
      citations: current.citations,
      edited: current.edited,
      removed: live === undefined,
    };
  }
  if (!draft.gm_notes.some((n) => n.note_id === request.targetId)) throw missing();
  const live = effective.gmNotes.find((n) => n.note_id === request.targetId);
  const removed = effective.removedNotes.find((n) => n.note_id === request.targetId);
  const current = live ?? removed;
  if (current === undefined) throw missing();
  return {
    text: current.text,
    citations: current.citations,
    edited: current.edited,
    removed: live === undefined,
  };
}

function sameCitations(a: RecapCitations, b: RecapCitations): boolean {
  const sorted = (ids: readonly string[]): string => [...new Set(ids)].sort().join('\n');
  return (
    sorted(a.segment_ids) === sorted(b.segment_ids) && sorted(a.event_ids) === sorted(b.event_ids)
  );
}

/** A sentence may cite only lines the recap can stand on: included lines of the active run. */
async function resolveCitations(
  ref: SessionRef,
  current: RecapCitations,
  wanted: NonNullable<EditRequest['citations']>,
): Promise<RecapCitations> {
  const { view } = await loadSessionReview(ref);
  const bySegment = new Map(view.segments.map((s) => [s.segment_id, s]));
  const segmentIds = [
    ...new Set(
      wanted.segment_ids.map((id) =>
        /^\d+:\d+$/.test(id) ? `${view.transcription_run_id}:${id}` : id,
      ),
    ),
  ];
  for (const id of segmentIds) {
    const segment = bySegment.get(id);
    if (segment === undefined) {
      throw new RecapEditorialError(
        'RECAP_EDIT_INVALID',
        `citation ${id} is not a line of the active transcription`,
      );
    }
    if (segment.recap_inclusion !== 'include') {
      throw new RecapEditorialError(
        'RECAP_EDIT_INVALID',
        `citation ${id} is ${segment.recap_inclusion === 'exclude' ? 'excluded' : 'waiting for your decision'}; a sentence may cite only included lines`,
      );
    }
  }
  const eventIds =
    wanted.event_ids === undefined ? [...current.event_ids] : [...new Set(wanted.event_ids)];
  for (const id of eventIds) {
    if (!current.event_ids.includes(id)) {
      throw new RecapEditorialError(
        'RECAP_EDIT_INVALID',
        `citation ${id}: Foundry events cannot be added until they are aligned (T17, T18)`,
      );
    }
  }
  return { segment_ids: segmentIds, event_ids: eventIds };
}

function revisionPrefixed(id: string, revision: number): string {
  return id.replace(/^r\d+:/, `r${String(revision)}:`);
}

function renumberDraft(draft: Recap, revision: number): Recap {
  return {
    ...draft,
    recap_revision: revision,
    sentences: draft.sentences.map((sentence) => ({
      ...sentence,
      sentence_id: revisionPrefixed(sentence.sentence_id, revision),
    })),
    gm_notes: draft.gm_notes.map((note) => ({
      ...note,
      note_id: revisionPrefixed(note.note_id, revision),
    })),
  };
}

/**
 * Forks an exported revision (ADR-010, section 3): allocates the next number, writes the renumbered
 * draft and copies every effective edit over. The row's hash is set last: until then the fork is a
 * burned number, not a revision.
 */
async function forkRevision(ref: SessionRef, context: RevisionContext): Promise<number> {
  const { draft, edits } = context;
  const now = clock(ref);
  const revision = allocateForkRevision(
    ref.db,
    ref.campaignId,
    ref.sessionId,
    draft.recap_revision,
    now,
  );
  const renumbered = assertRecord('recap', renumberDraft(draft, revision));
  const body = `${JSON.stringify(renumbered, null, 2)}\n`;
  const root = await realPackageRoot(ref.paths.sessionDir(ref.campaignId, ref.sessionId));
  const recapDir = (await resolveInsidePackage(root, 'recap')).absolute;
  const finalDir = path.join(recapDir, String(revision));
  const temp = tempDirFor(finalDir);
  await mkdir(temp);
  await writeFileAtomic(path.join(temp, 'recap.json'), body);
  await finalizeDirectory(temp, finalDir);
  const key = keyOf(ref, revision);
  const effective = [...latestEdits(edits).values()]
    .filter((edit) => edit.action !== 'revert')
    .sort((a, b) => a.sequence - b.sequence);
  ref.db
    .transaction(() => {
      effective.forEach((edit, sequence) => {
        insertEdit(ref.db, {
          ...edit,
          edit_id: ulid(),
          recap_revision: revision,
          sequence,
          target_id:
            edit.target_kind === 'title'
              ? edit.target_id
              : revisionPrefixed(edit.target_id, revision),
          created_at: now.toISOString(),
        });
      });
      recordForkDraftHash(key, sha256Bytes(body));
    })
    .immediate();
  return revision;
}

function commitEdit(
  ref: SessionRef,
  context: RevisionContext,
  edit: RecapSentenceEdit,
): { state: EditorialState; hash: string } {
  const run = ref.db.transaction((): { state: EditorialState; hash: string } => {
    assertUnmoved(context);
    insertEdit(ref.db, edit);
    const after = canonicalContentHash(effectiveRecap(context.draft, [...context.edits, edit]));
    if (after === context.hash) return { state: context.state, hash: after };
    if (context.state === 'exported') {
      throw new RecapEditorialError(
        'RECAP_BAD_STATE',
        `revision ${String(context.key.revision)} is exported and frozen for content`,
      );
    }
    insertTransition(ref.db, {
      schema_version: 1,
      transition_id: ulid(),
      campaign_id: ref.campaignId,
      session_id: ref.sessionId,
      recap_revision: context.key.revision,
      sequence: context.transitions.length,
      trigger: 'content_edit',
      from_state: context.state,
      to_state: 'draft',
      content_hash: after,
      edit_id: edit.edit_id,
      reviewer_id: edit.reviewer_id,
      created_at: edit.created_at,
    });
    return { state: 'draft', hash: after };
  });
  return run.immediate();
}

/**
 * Applies one GM edit. A content edit that changes the hash invalidates any approval through a
 * `content_edit` transition; on an exported revision it forks a new revision instead (ADR-010).
 * An edit that changes nothing writes nothing.
 */
export async function applyRecapEdit(
  ref: SessionRef,
  revision: number,
  request: EditRequest,
  reviewerId: string,
): Promise<EditOutcome> {
  const context = await loadContext(ref, revision);
  if (context.edits.length !== request.expectedEditCount)
    throw stale(`revision ${String(revision)}`);
  const target = targetState(context.draft, context.effective, request);
  const text = request.text === undefined ? undefined : normalizeEditText(request.text);
  if (request.action === 'replace' && (text === undefined || text.trim() === '')) {
    throw new RecapEditorialError('RECAP_EDIT_INVALID', 'a replacement text is required');
  }
  let citations: RecapCitations | undefined;
  if (request.targetKind === 'sentence' && request.action === 'replace') {
    citations = await resolveCitations(
      ref,
      target.citations,
      request.citations ?? target.citations,
    );
  }
  const unchanged =
    request.action === 'replace'
      ? !target.removed &&
        target.text === text &&
        (citations === undefined || sameCitations(target.citations, citations))
      : request.action === 'remove'
        ? target.removed
        : !target.edited && !target.removed;
  if (unchanged) {
    return {
      changed: false,
      forked: false,
      revision,
      state: context.state,
      contentHash: context.hash,
    };
  }
  const now = clock(ref);
  const edit = assertRecord('recap-sentence-edit', {
    schema_version: 1,
    edit_id: ulid(),
    campaign_id: ref.campaignId,
    session_id: ref.sessionId,
    recap_revision: revision,
    sequence: context.edits.length,
    target_kind: request.targetKind,
    target_id: request.targetId,
    action: request.action,
    ...(request.action === 'replace' ? { text } : {}),
    ...(citations === undefined ? {} : { citations }),
    reviewer_id: reviewerId,
    created_at: now.toISOString(),
  });
  const next = effectiveRecap(context.draft, [...context.edits, edit]);
  if (next.sentences.length === 0) {
    throw new RecapEditorialError(
      'RECAP_EDIT_INVALID',
      'the last sentence cannot be removed; generate a new revision instead',
    );
  }
  if (context.state === 'exported' && canonicalContentHash(next) !== context.hash) {
    const fork = await forkRevision(ref, context);
    const forked = await applyRecapEdit(
      ref,
      fork,
      {
        ...request,
        targetId:
          request.targetKind === 'title'
            ? request.targetId
            : revisionPrefixed(request.targetId, fork),
        expectedEditCount: listEdits(keyOf(ref, fork)).length,
      },
      reviewerId,
    );
    return { ...forked, forked: true };
  }
  const { state, hash } = commitEdit(ref, context, edit);
  return { changed: true, forked: false, revision, state, contentHash: hash };
}

function assertExpectedHash(context: RevisionContext, expected: string): void {
  if (context.hash !== expected)
    throw stale(`the content of revision ${String(context.key.revision)}`);
}

function appendTransition(
  ref: SessionRef,
  context: RevisionContext,
  trigger: RecapEditorialTransition['trigger'],
  toState: EditorialState,
  reviewerId: string,
  now: Date,
  extra: { approval_id?: string; export_id?: string } = {},
): void {
  insertTransition(ref.db, {
    schema_version: 1,
    transition_id: ulid(),
    campaign_id: ref.campaignId,
    session_id: ref.sessionId,
    recap_revision: context.key.revision,
    sequence: context.transitions.length,
    trigger,
    from_state: context.state,
    to_state: toState,
    content_hash: context.hash,
    ...extra,
    reviewer_id: reviewerId,
    created_at: now.toISOString(),
  });
}

/** Marks a draft reviewed. Reviewing does not approve anything (ADR-010). */
export async function markRecapReviewed(
  ref: SessionRef,
  revision: number,
  expectedHash: string,
  reviewerId: string,
): Promise<EditorialState> {
  const context = await loadContext(ref, revision);
  if (context.state !== 'draft') {
    throw new RecapEditorialError(
      'RECAP_BAD_STATE',
      `revision ${String(revision)} is ${context.state}; only a draft can be marked reviewed`,
    );
  }
  assertExpectedHash(context, expectedHash);
  const now = clock(ref);
  ref.db
    .transaction(() => {
      assertUnmoved(context);
      appendTransition(ref, context, 'review', 'reviewed', reviewerId, now);
    })
    .immediate();
  return 'reviewed';
}

function assertNoBlockers(blockers: readonly ReleaseBlocker[], what: string): void {
  if (blockers.length === 0) return;
  throw new RecapEditorialError(
    'RECAP_BLOCKED',
    `${what} refused: ${blockers
      .slice(0, 5)
      .map((blocker) => blocker.message)
      .join('; ')}`,
    'reconcile the exclusions and fix the listed sentences, then try again',
  );
}

export interface SpoilerAcknowledgement {
  readonly segmentIds: readonly string[];
  readonly confirmed: boolean;
}

/** Possible spoilers are not excluded automatically, so the GM must decide knowingly (T11). */
function assertSpoilersAcknowledged(
  view: EffectiveTranscriptReview,
  acknowledgement: SpoilerAcknowledgement,
): void {
  const flagged = includedSpoilers(view);
  if (flagged.length === 0) return;
  const same =
    flagged.length === acknowledgement.segmentIds.length &&
    flagged.every((id) => acknowledgement.segmentIds.includes(id));
  if (!acknowledgement.confirmed || !same) {
    throw new RecapEditorialError(
      'RECAP_SPOILERS_NOT_ACKNOWLEDGED',
      `${String(flagged.length)} line(s) flagged as possible spoilers are still included in the recap`,
      'review them, then confirm you want them included (or exclude them first)',
    );
  }
}

/**
 * Approves one exact `(revision, content_hash)`. Refuses while an exclusion is unreconciled or a
 * sentence cites something the GM has excluded, and requires the included possible spoilers to be
 * acknowledged.
 */
export async function approveRecap(
  ref: SessionRef,
  revision: number,
  request: { readonly expectedHash: string; readonly spoilers: SpoilerAcknowledgement },
  reviewerId: string,
): Promise<RecapApproval> {
  const context = await loadContext(ref, revision);
  if (context.state !== 'reviewed') {
    throw new RecapEditorialError(
      'RECAP_BAD_STATE',
      `revision ${String(revision)} is ${context.state}; approval needs a reviewed revision`,
      'mark it reviewed first',
    );
  }
  assertExpectedHash(context, request.expectedHash);
  const { view } = await loadSessionReview(ref);
  assertNoBlockers(releaseBlockers(context.effective, view), 'approval');
  assertSpoilersAcknowledged(view, request.spoilers);
  const now = clock(ref);
  const approval: RecapApproval = {
    schema_version: 1,
    approval_id: ulid(),
    campaign_id: ref.campaignId,
    session_id: ref.sessionId,
    recap_revision: revision,
    content_hash: context.hash,
    reviewer_id: reviewerId,
    approved_at: now.toISOString(),
  };
  ref.db
    .transaction(() => {
      assertUnmoved(context);
      insertApproval(ref.db, approval);
      appendTransition(ref, context, 'approve', 'approved', reviewerId, now, {
        approval_id: approval.approval_id,
      });
    })
    .immediate();
  return approval;
}

/** Back to `draft`; ends an approval in force. An exported revision is terminal (ADR-010). */
export async function reopenRecap(
  ref: SessionRef,
  revision: number,
  reviewerId: string,
): Promise<EditorialState> {
  const context = await loadContext(ref, revision);
  if (context.state !== 'reviewed' && context.state !== 'approved') {
    throw new RecapEditorialError(
      'RECAP_BAD_STATE',
      `revision ${String(revision)} is ${context.state} and cannot be reopened`,
      context.state === 'exported' ? 'edit it to fork a new revision' : undefined,
    );
  }
  const now = clock(ref);
  ref.db
    .transaction(() => {
      assertUnmoved(context);
      appendTransition(ref, context, 'reopen', 'draft', reviewerId, now);
    })
    .immediate();
  return 'draft';
}

export interface ExportOutcome {
  readonly manifest: RecapExportManifest;
  /** Package-relative path of the written file. */
  readonly file: string;
}

const EXPORTS_DIR = 'exports';

function exportFileName(revision: number, exportId: string): string {
  return `recap-r${String(revision)}-${exportId}.json`;
}

/**
 * Writes the recap package of an approved revision and records the export. Refused unless an
 * approval is in force whose hash equals the hash of the exact content going out.
 */
export async function exportRecap(
  ref: SessionRef,
  revision: number,
  request: { readonly expectedHash: string; readonly spoilers: SpoilerAcknowledgement },
  reviewerId: string,
): Promise<ExportOutcome> {
  const context = await loadContext(ref, revision);
  const approval = approvalInForce(context);
  if ((context.state !== 'approved' && context.state !== 'exported') || approval === null) {
    throw new RecapEditorialError(
      'RECAP_NOT_APPROVED',
      `revision ${String(revision)} is ${context.state}; only an approved revision can be exported`,
      'review and approve it first',
    );
  }
  if (approval.content_hash !== context.hash) {
    throw new RecapEditorialError(
      'RECAP_HASH_MISMATCH',
      `the content of revision ${String(revision)} does not match its approval`,
      'approve the current content again',
    );
  }
  assertExpectedHash(context, request.expectedHash);
  const { view } = await loadSessionReview(ref);
  assertNoBlockers(releaseBlockers(context.effective, view), 'export');
  assertSpoilersAcknowledged(view, request.spoilers);
  const earlier = listExports(context.key);
  if (earlier.some((row) => row.content_hash !== context.hash)) {
    throw new RecapEditorialError(
      'RECAP_HASH_MISMATCH',
      `revision ${String(revision)} was exported with another content hash (ADR-007)`,
    );
  }
  const now = clock(ref);
  const exportId = ulid();
  const pkg = assertRecord(
    'recap-package',
    buildRecapPackage({
      effective: context.effective,
      view,
      campaignId: ref.campaignId,
      sessionId: ref.sessionId,
      revision,
      contentHash: context.hash,
      approval,
      exportedAt: now.toISOString(),
    }),
  );
  if (canonicalContentHash(recapContentFromPackage(pkg.content)) !== approval.content_hash) {
    throw new RecapEditorialError(
      'RECAP_HASH_MISMATCH',
      'the package does not hash to the approved content',
    );
  }
  const body = `${JSON.stringify(pkg, null, 2)}\n`;
  const root = await realPackageRoot(ref.paths.sessionDir(ref.campaignId, ref.sessionId));
  const dir = (await resolveInsidePackage(root, EXPORTS_DIR)).absolute;
  await mkdir(dir, { recursive: true });
  const name = exportFileName(revision, exportId);
  const absolute = path.join(dir, name);
  await writeFileAtomic(absolute, body);
  const manifest: RecapExportManifest = {
    schema_version: 1,
    export_id: exportId,
    campaign_id: ref.campaignId,
    session_id: ref.sessionId,
    recap_revision: revision,
    content_hash: context.hash,
    approval_id: approval.approval_id,
    package_schema_version: 1,
    package_sha256: sha256Bytes(body),
    package_bytes: Buffer.byteLength(body, 'utf8'),
    generator_version: EXPORT_GENERATOR_VERSION,
    reviewer_id: reviewerId,
    exported_at: now.toISOString(),
  };
  try {
    ref.db
      .transaction(() => {
        assertUnmoved(context);
        insertExport(ref.db, manifest);
        appendTransition(ref, context, 'export', 'exported', reviewerId, now, {
          approval_id: approval.approval_id,
          export_id: exportId,
        });
      })
      .immediate();
  } catch (error) {
    await rm(absolute, { force: true });
    throw error;
  }
  return { manifest, file: `${EXPORTS_DIR}/${name}` };
}

/** The Markdown of an approved revision: the same gates as export, GM notes never included. */
export async function approvedRecapMarkdown(ref: SessionRef, revision: number): Promise<string> {
  const context = await loadContext(ref, revision);
  const { view } = await loadSessionReview(ref);
  const approval = approvalInForce(context);
  const blockers = releaseBlockers(context.effective, view);
  if (!mayCopy(context, approval, blockers)) {
    assertNoBlockers(blockers, 'copy');
    throw new RecapEditorialError(
      'RECAP_NOT_APPROVED',
      `revision ${String(revision)} is ${context.state}; only approved text can be copied`,
      'review and approve it first',
    );
  }
  return markdownOf(context, view);
}

export interface ExportFile {
  readonly name: string;
  readonly text: string;
}

/** The latest package written for a revision, proved unchanged against its export record. */
export async function latestExportFile(ref: SessionRef, revision: number): Promise<ExportFile> {
  const key = keyOf(ref, revision);
  const exports = listExports(key);
  const latest = exports[exports.length - 1];
  if (latest === undefined) {
    throw new RecapEditorialError(
      'RECAP_NOT_APPROVED',
      `revision ${String(revision)} has not been exported`,
    );
  }
  const name = exportFileName(revision, latest.export_id);
  const root = await realPackageRoot(ref.paths.sessionDir(ref.campaignId, ref.sessionId));
  const { absolute } = await resolveInsidePackage(root, `${EXPORTS_DIR}/${name}`);
  const { hash } = await sha256File(absolute);
  if (hash !== latest.package_sha256) {
    throw new ReviewError('REVIEW_RUN_INVALID', `${name} differs from what its export recorded`);
  }
  return { name, text: await readFile(absolute, 'utf8') };
}
