/**
 * Citation validation and record building (T13). A security boundary (plan section 5): the model's
 * citations are claims, and core decides what they prove.
 *
 * - A citation of anything that was not sent fails the attempt, costing one of its retries. That
 *   covers invented refs, refs from other sessions, and excluded or unresolved segments, which are
 *   never sent.
 * - A sentence with no citation, or one marked `background`, is not evidence of this session. It
 *   does not fail the attempt: it becomes a GM note (`unsupported`).
 *
 * Problem texts name refs and paths only, never transcript or recap words.
 */
import {
  validateContract,
  type EffectiveTranscriptReview,
  type Recap,
  type RecapCitations,
  type RecapModelCitations,
  type RecapModelOutput,
} from '@sargas-recap/contracts';
import type { RecapEvidence } from './evidence.ts';

type Sentence = Recap['sentences'][number];
type GmNote = Recap['gm_notes'][number];

/** A validated sentence or note, before IDs: its revision is allocated after the model succeeds. */
export type DraftSentence = Omit<Sentence, 'sentence_id'>;
export type DraftNote = Omit<GmNote, 'note_id'>;

export interface RecapDraft {
  readonly title: string;
  readonly sentences: readonly DraftSentence[];
  readonly gmNotes: readonly DraftNote[];
}

export type FinalizeOutcome =
  | { readonly ok: true; readonly draft: RecapDraft }
  | { readonly ok: false; readonly problems: readonly string[] };

export interface RecapIdentity {
  readonly campaignId: string;
  readonly sessionId: string;
  readonly transcriptionRunId: string;
  readonly classificationRunId: string;
  readonly language: string;
  readonly generatedAt: string;
}

function resolve(
  where: string,
  citations: RecapModelCitations,
  evidence: RecapEvidence,
  problems: string[],
): RecapCitations {
  const segmentIds: string[] = [];
  for (const ref of new Set(citations.segment_refs)) {
    const id = evidence.segmentIdByRef.get(ref);
    if (id === undefined) problems.push(`${where}: segment_ref ${ref} was not sent to the model`);
    else segmentIds.push(id);
  }
  const eventIds: string[] = [];
  for (const id of new Set(citations.event_ids)) {
    if (evidence.eventIds.has(id)) eventIds.push(id);
    else problems.push(`${where}: event ${id} was not sent to the model`);
  }
  return { segment_ids: segmentIds, event_ids: eventIds };
}

const uncited = (citations: RecapCitations): boolean =>
  citations.segment_ids.length === 0 && citations.event_ids.length === 0;

/** Checks the model's output against what it was sent, and sorts its claims. */
export function finalizeRecapOutput(
  output: RecapModelOutput,
  evidence: RecapEvidence,
): FinalizeOutcome {
  const problems: string[] = [];
  const sentences: DraftSentence[] = [];
  const demoted: DraftNote[] = [];

  output.sentences.forEach((sentence, index) => {
    const where = `sentences[${String(index)}]`;
    const citations = resolve(where, sentence.citations, evidence, problems);
    if (uncited(citations) || sentence.assertion === 'background') {
      // Background is never evidence of this session, whatever it cites.
      demoted.push({ reason: 'unsupported', text: sentence.text, citations });
      return;
    }
    if (sentence.outcome_basis !== undefined && sentence.assertion !== 'completed') {
      problems.push(`${where}: outcome_basis is only valid on a completed sentence`);
    }
    sentences.push({
      text: sentence.text,
      assertion: sentence.assertion,
      ...(sentence.outcome_basis === undefined ? {} : { outcome_basis: sentence.outcome_basis }),
      citations,
    });
  });

  const notes: DraftNote[] = output.gm_notes.map((note, index) => ({
    reason: note.reason,
    text: note.text,
    citations: resolve(`gm_notes[${String(index)}]`, note.citations, evidence, problems),
  }));

  if (sentences.length === 0 && problems.length === 0) {
    problems.push('no sentence has evidence from this session');
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, draft: { title: output.title, sentences, gmNotes: [...notes, ...demoted] } };
}

const waitingText = (count: number): string =>
  count === 1
    ? '1 trecho aguarda decisão do GM e ficou fora deste recap.'
    : `${String(count)} trechos aguardam decisão do GM e ficaram fora deste recap.`;

/** Core's own note: which segments wait for a GM decision. It carries IDs and a count, no words. */
export function unresolvedNote(unresolvedIds: readonly string[]): DraftNote | undefined {
  if (unresolvedIds.length === 0) return undefined;
  return {
    reason: 'unresolved',
    text: waitingText(unresolvedIds.length),
    citations: { segment_ids: [...unresolvedIds], event_ids: [] },
  };
}

/** The finished record, with IDs from the allocated revision. */
export function buildRecap(
  draft: RecapDraft,
  identity: RecapIdentity,
  revision: number,
  unresolvedIds: readonly string[],
): Recap {
  const core = unresolvedNote(unresolvedIds);
  const notes = core === undefined ? draft.gmNotes : [...draft.gmNotes, core];
  return {
    schema_version: 1,
    campaign_id: identity.campaignId,
    session_id: identity.sessionId,
    recap_revision: revision,
    transcription_run_id: identity.transcriptionRunId,
    classification_run_id: identity.classificationRunId,
    language: identity.language,
    generated_at: identity.generatedAt,
    title: draft.title,
    sentences: draft.sentences.map((sentence, n) => ({
      sentence_id: `r${String(revision)}:s${String(n)}`,
      ...sentence,
    })),
    gm_notes: notes.map((note, n) => ({
      note_id: `r${String(revision)}:g${String(n)}`,
      ...note,
    })),
  };
}

/**
 * Checks a finished record against the effective transcript: every player-facing citation is an
 * included segment of this run, a GM note may also point at a segment waiting for a decision, and
 * nothing ever cites an excluded segment. Independent of the refs the model saw.
 */
export function recapCitationProblems(
  recap: Recap,
  view: EffectiveTranscriptReview,
  eventIds: ReadonlySet<string>,
): string[] {
  const inclusion = new Map(view.segments.map((s) => [s.segment_id, s.recap_inclusion]));
  const problems: string[] = [];
  const check = (where: string, citations: RecapCitations, allowUnresolved: boolean): void => {
    for (const id of citations.segment_ids) {
      const state = inclusion.get(id);
      if (state === undefined) problems.push(`${where}: ${id} is not in this session's run`);
      else if (state === 'exclude') problems.push(`${where}: ${id} is excluded`);
      else if (state === 'unresolved' && !allowUnresolved) {
        problems.push(`${where}: ${id} is waiting for a GM decision`);
      }
    }
    for (const id of citations.event_ids) {
      if (!eventIds.has(id)) problems.push(`${where}: event ${id} was not sent to the model`);
    }
  };
  for (const sentence of recap.sentences) {
    const where = sentence.sentence_id;
    check(where, sentence.citations, false);
    if (uncited(sentence.citations)) problems.push(`${where}: has no citation`);
    if (sentence.assertion === 'background') problems.push(`${where}: background is not evidence`);
  }
  for (const note of recap.gm_notes) check(note.note_id, note.citations, true);
  return problems;
}

/** Every check on a finished record: the contract, then the citations. */
export function finishedRecapProblems(
  recap: Recap,
  view: EffectiveTranscriptReview,
  eventIds: ReadonlySet<string>,
): string[] {
  const contract = validateContract('recap', recap);
  if (!contract.ok) return contract.errors.map((issue) => `${issue.path} ${issue.keyword}`);
  return recapCitationProblems(recap, view, eventIds);
}
