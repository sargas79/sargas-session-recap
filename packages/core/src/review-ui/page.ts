/**
 * The server-rendered review screen (T14). Everything interpolated goes through the escaping `html`
 * template; the page carries no inline script and no inline style.
 *
 * It offers corrections, regeneration, and recap editing, approval and export (T15). Nothing here
 * reaches players: an export is a file the GM takes to Foundry (T19).
 */
import type { EditorialState, FoundryEvent, RecapCitations } from '@sargas-recap/contracts';
import { LABELS } from '@sargas-recap/contracts';
import type { EffectiveNote, EffectiveSentence, RecapEditorialView } from '../recap/editorial.ts';
import { clock } from '../recap/render.ts';
import { unreconciledExclusions } from '../review/project.ts';
import type { StoredOverride } from '../review/store.ts';
import { EXCLUSION_CHOICES, INCLUSION_CHOICES, STATUS_CHOICES } from './actions.ts';
import {
  attentionReasons,
  reviewQueue,
  type AttentionReason,
  type RecapDraftView,
  type ReviewScreen,
  type ReviewSegment,
} from './data.ts';
import { html, type HtmlValue, type SafeHtml } from './html.ts';
import type { RegenerationState } from './regenerate.ts';
import { TOKEN_FIELD } from './security.ts';

export interface PageContext {
  readonly screen: ReviewScreen;
  readonly token: string;
  readonly regeneration: RegenerationState;
  readonly canRegenerate: boolean;
  readonly hasClient: boolean;
}

const REASON_TEXT: Readonly<Record<AttentionReason, string>> = {
  possible_spoiler: 'possible spoiler',
  unresolved: 'unresolved',
  repetition_loop: 'repetition loop',
  low_confidence: 'low ASR confidence',
  spelling: 'spelling correction',
  review_required: 'review required',
};

const TIMELINE_STEP_MS = 10 * 60_000;
const EXCERPT_CHARS = 140;
const PAYLOAD_CHARS = 2_000;

function anchorOf(id: string): string {
  return `seg-${id.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

function shortRef(id: string): string {
  return id.split(':').slice(1).join(':');
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS)}...` : flat;
}

function tokenField(token: string): SafeHtml {
  return html`<input type="hidden" name="${TOKEN_FIELD}" value="${token}" />`;
}

function reasonChip(reason: AttentionReason): SafeHtml {
  const tone = reason === 'possible_spoiler' ? 'danger' : 'warn';
  return html`<span class="chip ${tone}">${REASON_TEXT[reason]}</span>`;
}

function labelChip(segment: ReviewSegment): SafeHtml {
  const name = segment.label ?? 'unclassified';
  const changed =
    segment.label_source === 'override' && segment.classification_label !== segment.label
      ? ` (classified ${segment.classification_label ?? 'none'})`
      : '';
  return html`<span class="chip label">${name}${changed}</span>`;
}

function inclusionChip(segment: ReviewSegment): SafeHtml {
  const tone = segment.recap_inclusion === 'unresolved' ? ' warn' : '';
  const why =
    segment.exclusion_reasons.length > 0 ? ` (${segment.exclusion_reasons.join(', ')})` : '';
  return html`<span class="chip${tone}">recap: ${segment.recap_inclusion}${why}</span>`;
}

function option(value: string, text: string, selected: boolean): SafeHtml {
  return html`<option value="${value}" ${selected ? 'selected' : ''}>${text}</option>`;
}

function overrideAction(segmentId: string): string {
  return `/api/segments/${encodeURIComponent(segmentId)}/override`;
}

function editForm(
  segment: ReviewSegment,
  override: StoredOverride | undefined,
  token: string,
): SafeHtml {
  const labelValue = override?.label_override ?? '';
  const inclusionValue = override?.recap_inclusion ?? 'default';
  return html`<details class="edit">
    <summary>Edit override</summary>
    <form class="grid" method="post" action="${overrideAction(segment.segment_id)}">
      ${tokenField(token)}
      <input type="hidden" name="expected_revision" value="${override?.revision ?? 0}" />
      <input type="hidden" name="exclusions_present" value="1" />
      <label>
        Label
        <select name="label">
          ${option('', `as classified (${segment.classification_label ?? 'none'})`, labelValue === '')}
          ${LABELS.map((label) => option(label, label, labelValue === label))}
        </select>
      </label>
      <label>
        Recap inclusion
        <select name="inclusion">
          ${INCLUSION_CHOICES.map((choice) =>
            option(
              choice,
              choice === 'default' ? 'no decision (follow label)' : choice,
              inclusionValue === choice,
            ),
          )}
        </select>
      </label>
      <label>
        Status
        <select name="status">
          ${STATUS_CHOICES.map((choice) =>
            option(choice, choice, segment.review_status === choice),
          )}
        </select>
      </label>
      <fieldset>
        <legend>Exclusions (always win)</legend>
        ${EXCLUSION_CHOICES.map(
          (reason) =>
            html`<label
              ><input
                type="checkbox"
                name="exclusions"
                value="${reason}"
                ${segment.exclusion_reasons.includes(reason) ? 'checked' : ''}
              />
              ${reason}</label
            > `,
        )}
      </fieldset>
      <label class="wide">
        Cleaned text (empty removes it)
        <textarea name="text">${segment.text_override ?? ''}</textarea>
      </label>
      <button type="submit">Save</button>
    </form>
  </details>`;
}

function quickActions(
  segment: ReviewSegment,
  override: StoredOverride | undefined,
  token: string,
): SafeHtml {
  const revision = override?.revision ?? 0;
  const action = overrideAction(segment.segment_id);
  const markReviewed =
    segment.review_status === 'pending'
      ? html`<form class="inline" method="post" action="${action}">
          ${tokenField(token)}
          <input type="hidden" name="expected_revision" value="${revision}" />
          <input type="hidden" name="status" value="reviewed" />
          <button type="submit">Mark reviewed</button>
        </form>`
      : null;
  const excludeSpoiler = !segment.exclusion_reasons.includes('spoiler')
    ? html`<form class="inline" method="post" action="${action}">
        ${tokenField(token)}
        <input type="hidden" name="expected_revision" value="${revision}" />
        <input type="hidden" name="exclusions_present" value="1" />
        <input type="hidden" name="exclusions" value="spoiler" />
        ${segment.exclusion_reasons.map(
          (reason) => html`<input type="hidden" name="exclusions" value="${reason}" />`,
        )}
        <input type="hidden" name="status" value="reviewed" />
        <button type="submit">Exclude as spoiler</button>
      </form>`
    : null;
  return html`<div class="actions">${markReviewed}${excludeSpoiler}</div>`;
}

function compareBlock(segment: ReviewSegment): SafeHtml | null {
  if (segment.text_source === 'original' && segment.corrections.length === 0) return null;
  return html`<div class="compare">
      <div>
        <h4>Original (ASR)</h4>
        ${segment.text_original}
      </div>
      ${
        segment.text_corrected === undefined
          ? null
          : html`<div>
              <h4>After corrections</h4>
              ${segment.text_corrected}
            </div>`
      }
      ${
        segment.text_override === undefined
          ? null
          : html`<div>
              <h4>Your cleaned text</h4>
              ${segment.text_override}
            </div>`
      }
    </div>
    ${
      segment.corrections.length === 0
        ? null
        : html`<table class="corrections">
            <tr>
              <th>Kind</th>
              <th>From</th>
              <th>To</th>
              <th>Backing</th>
            </tr>
            ${segment.corrections.map(
              (correction) =>
                html`<tr class="${correction.kind === 'spelling' ? 'spelling' : ''}">
                  <td>${correction.kind}</td>
                  <td>${correction.from}</td>
                  <td>${correction.to}</td>
                  <td>${correction.glossary_id ?? 'no glossary entry'}</td>
                </tr>`,
            )}
          </table>`
    }`;
}

function segmentCard(
  segment: ReviewSegment,
  override: StoredOverride | undefined,
  context: {
    readonly token: string;
    readonly citedBy: ReadonlyMap<string, readonly string[]>;
    readonly nextInQueue: ReadonlyMap<string, string>;
    readonly pending: ReadonlySet<string>;
  },
): SafeHtml {
  const reasons = attentionReasons(segment);
  const spoiler = reasons.includes('possible_spoiler');
  const excluded = segment.recap_inclusion === 'exclude';
  const labelClass = `label-${segment.label ?? 'none'}`;
  const classes = ['segment', labelClass, spoiler ? 'spoiler' : '', excluded ? 'excluded' : '']
    .filter((name) => name !== '')
    .join(' ');
  const cited = context.citedBy.get(segment.segment_id) ?? [];
  const next = context.nextInQueue.get(segment.segment_id);
  const extraFlags = [
    ...segment.segment_flags.filter((f) => f !== 'repetition_loop' && f !== 'low_confidence'),
    ...segment.classification_flags.filter((f) => f !== 'possible_spoiler'),
  ];
  return html`<article
    id="${anchorOf(segment.segment_id)}"
    class="${classes}"
    data-label="${segment.label ?? 'none'}"
    data-attention="${context.pending.has(segment.segment_id) ? '1' : '0'}"
  >
    <div class="meta">
      <strong>${clock(segment.start_offset_ms)}</strong>
      <span>${segment.speaker_id}</span>
      ${labelChip(segment)} ${inclusionChip(segment)}
      <span class="chip">${segment.review_status}</span>
      <span class="chip">text: ${segment.text_source}</span>
      ${reasons.map(reasonChip)}
      ${extraFlags.map((flag) => html`<span class="chip">${flag}</span>`)}
      ${
        segment.confidence_permille === undefined
          ? null
          : html`<span class="muted">conf ${segment.confidence_permille}/1000</span>`
      }
      <span class="muted mono">${shortRef(segment.segment_id)}</span>
    </div>
    ${
      spoiler
        ? html`<div class="alert danger">
            POSSIBLE SPOILER (classifier flag).
            ${
              segment.recap_inclusion === 'include'
                ? 'This line is INCLUDED in the recap: generation does not filter it out. Only your review keeps it from players.'
                : `Recap inclusion: ${segment.recap_inclusion}.`
            }
          </div>`
        : null
    }
    <p class="effective">${segment.text}</p>
    ${compareBlock(segment)}
    ${
      cited.length === 0
        ? null
        : html`<p class="muted">
            Cited by the recap:
            ${cited.map((sentence) => html`<a href="#${anchorOfSentence(sentence)}">${sentence}</a> `)}
          </p>`
    }
    ${quickActions(segment, override, context.token)}
    ${
      next === undefined
        ? null
        : html`<a class="muted" href="#${anchorOf(next)}">next to review</a>`
    }
    ${editForm(segment, override, context.token)}
  </article>`;
}

function anchorOfSentence(sentenceId: string): string {
  return `sent-${sentenceId.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

function foundryEvent(event: FoundryEvent, approxOffsetMs: number | null): SafeHtml {
  const payload = JSON.stringify(event.payload);
  const clipped =
    payload.length > PAYLOAD_CHARS ? `${payload.slice(0, PAYLOAD_CHARS)}...` : payload;
  return html`<aside class="foundry-event">
    <strong>Foundry</strong>
    ${approxOffsetMs === null ? null : html`<span>~${clock(approxOffsetMs)}</span>`}
    <span>${event.type}</span>
    <span class="mono">${event.event_id}</span>
    <details>
      <summary>payload (raw, GM only)</summary>
      <pre>${clipped}</pre>
    </details>
  </aside>`;
}

function transcriptItems(screen: ReviewScreen, card: (s: ReviewSegment) => SafeHtml): SafeHtml[] {
  const placed = screen.foundry.events.flatMap((e) =>
    e.approxOffsetMs === null ? [] : [{ event: e.event, offset: e.approxOffsetMs }],
  );
  const items: SafeHtml[] = [];
  let next = 0;
  for (const segment of screen.view.segments) {
    while ((placed[next]?.offset ?? Infinity) <= segment.start_offset_ms) {
      const entry = placed[next];
      if (entry !== undefined) items.push(foundryEvent(entry.event, entry.offset));
      next += 1;
    }
    items.push(card(segment));
  }
  for (const entry of placed.slice(next)) items.push(foundryEvent(entry.event, entry.offset));
  return items;
}

function timeline(segments: readonly ReviewSegment[]): SafeHtml {
  let bucket = -1;
  const links: SafeHtml[] = [];
  for (const segment of segments) {
    const current = Math.floor(segment.start_offset_ms / TIMELINE_STEP_MS);
    if (current > bucket) {
      bucket = current;
      links.push(
        html`<a href="#${anchorOf(segment.segment_id)}">${clock(current * TIMELINE_STEP_MS)}</a>`,
      );
    }
  }
  return html`<nav class="timeline" aria-label="Jump to time">${links}</nav>`;
}

function reconcilePanel(screen: ReviewScreen, token: string): SafeHtml | null {
  const { view, overrides } = screen;
  if (view.needs_reconciliation.length === 0) return null;
  const byId = new Map(overrides.map((override) => [override.override_id, override]));
  return html`<section class="panel" id="reconciliation">
    <h2>Needs reconciliation (${view.needs_reconciliation.length})</h2>
    <p class="muted">
      These overrides no longer apply: they are not used until you move or discard them. Nothing is
      moved for you (ADR-005).
    </p>
    ${view.needs_reconciliation.map((entry) => {
      const override = byId.get(entry.override_id);
      const blocks =
        entry.exclusion_reasons.includes('spoiler') || entry.exclusion_reasons.includes('privacy');
      const suggestions = view.segments.filter((s) => s.text_hash === override?.base_text_hash);
      return html`<div class="alert ${blocks ? 'danger' : 'warn'}">
        <div>
          <span class="mono">${entry.override_id}</span> on
          <span class="mono">${shortRef(entry.segment_id)}</span>: ${entry.reason.replace('_', ' ')}
          ${
            entry.exclusion_reasons.length === 0
              ? null
              : html` exclusions: ${entry.exclusion_reasons.join(', ')}`
          }
          ${blocks ? ' (blocks the recap)' : ''}
        </div>
        ${
          override?.label_override === undefined
            ? null
            : html`<div>label: ${override.label_override}</div>`
        }
        ${
          override?.text_override === undefined
            ? null
            : html`<div>cleaned text: ${override.text_override}</div>`
        }
        ${suggestions.map(
          (segment) =>
            html`<form
              class="inline"
              method="post"
              action="/api/overrides/${encodeURIComponent(entry.override_id)}/reconcile"
            >
              ${tokenField(token)}
              <input type="hidden" name="segment_id" value="${segment.segment_id}" />
              <button type="submit">
                Apply to ${shortRef(segment.segment_id)} (same words,
                ${clock(segment.start_offset_ms)})
              </button>
            </form> `,
        )}
        <form
          class="grid"
          method="post"
          action="/api/overrides/${encodeURIComponent(entry.override_id)}/reconcile"
        >
          ${tokenField(token)}
          <label class="wide"
            >Apply to segment ID <input type="text" name="segment_id" required
          /></label>
          <button type="submit">Reconcile</button>
        </form>
        <form
          class="inline"
          method="post"
          action="/api/overrides/${encodeURIComponent(entry.override_id)}/discard"
        >
          ${tokenField(token)}
          <button type="submit">Discard this override</button>
        </form>
      </div>`;
    })}
  </section>`;
}

function queuePanel(screen: ReviewScreen): SafeHtml {
  const queue = reviewQueue(screen.view);
  return html`<section class="panel" id="queue">
    <h2>Review queue (${queue.length})</h2>
    ${
      queue.length === 0
        ? html`<p class="muted">Nothing is waiting for review.</p>`
        : html`<ol class="queue">
            ${queue.map(
              ({ segment, reasons }) =>
                html`<li>
                  <a href="#${anchorOf(segment.segment_id)}">${clock(segment.start_offset_ms)}</a>
                  ${reasons.map(reasonChip)}
                  <span class="muted">${segment.speaker_id}:</span> ${excerpt(segment.text)}
                </li>`,
            )}
          </ol>`
    }
  </section>`;
}

function spoilerAlert(segments: readonly ReviewSegment[]): SafeHtml | null {
  if (segments.length === 0) return null;
  return html`<div class="alert danger spoiler-list">
    ${segments.length} line(s) flagged as possible spoilers are still included in the recap. Recap
    generation does not remove them:
    ${segments.map(
      (segment) =>
        html`<a href="#${anchorOf(segment.segment_id)}">${clock(segment.start_offset_ms)}</a>`,
    )}
  </div>`;
}

interface Footnoter {
  readonly next: () => number;
}

function citationNotes(
  citations: RecapCitations,
  bySegment: ReadonlyMap<string, ReviewSegment>,
  footnotes: Footnoter,
): SafeHtml[] {
  const segments = citations.segment_ids.map((id) => {
    const segment = bySegment.get(id);
    const n = footnotes.next();
    if (segment === undefined) {
      return html`<sup class="foot" title="${id}">[${n}: line not in this transcription]</sup>`;
    }
    const preview = `${segment.speaker_id} ${clock(segment.start_offset_ms)}: ${excerpt(segment.text)}`;
    return html`<sup class="foot"><a href="#${anchorOf(id)}" title="${preview}">[${n}]</a></sup>`;
  });
  const events = citations.event_ids.map(
    (id) => html`<sup class="foot" title="${id}">[${footnotes.next()}: Foundry event]</sup>`,
  );
  return [...segments, ...events];
}

function evidenceWarnings(
  citations: RecapCitations,
  bySegment: ReadonlyMap<string, ReviewSegment>,
): SafeHtml[] {
  const cited = citations.segment_ids.flatMap((id) => {
    const segment = bySegment.get(id);
    return segment === undefined ? [] : [segment];
  });
  const warnings: SafeHtml[] = [];
  if (cited.some((segment) => segment.recap_inclusion === 'exclude')) {
    warnings.push(html`<span class="chip danger">cites a line you have excluded</span>`);
  }
  if (cited.some((segment) => segment.classification_flags.includes('possible_spoiler'))) {
    warnings.push(html`<span class="chip danger">cites a possible spoiler</span>`);
  }
  return warnings;
}

const STALE_TEXT = {
  'other-transcription':
    'This draft was written from another transcription run; its citations may not resolve.',
  'corrected-since':
    'You changed lines since this draft was written. It does not reflect those corrections yet.',
} as const;

function recapEditAction(revision: number): string {
  return `/api/recap/revisions/${String(revision)}/edits`;
}

function editHidden(
  editorial: RecapEditorialView,
  kind: 'title' | 'sentence' | 'gm_note',
  id: string,
  token: string,
): SafeHtml {
  return html`${tokenField(token)}
    <input type="hidden" name="target_kind" value="${kind}" />
    <input type="hidden" name="target_id" value="${id}" />
    <input type="hidden" name="expected_edit_count" value="${editorial.editCount}" />`;
}

function citationBox(citations: RecapCitations): string {
  return citations.segment_ids.map(shortRef).join(' ');
}

function sentenceEditForm(
  sentence: EffectiveSentence,
  editorial: RecapEditorialView,
  token: string,
): SafeHtml {
  return html`<details class="edit">
    <summary>Edit sentence</summary>
    <form class="grid" method="post" action="${recapEditAction(editorial.revision)}">
      ${editHidden(editorial, 'sentence', sentence.sentence_id, token)}
      <label class="wide"
        >Text <textarea name="text" required maxlength="2000">${sentence.text}</textarea>
      </label>
      <label class="wide"
        >Citations (segment refs such as 0:12, separated by spaces; only included lines)
        <input type="text" name="citations" value="${citationBox(sentence.citations)}"
      /></label>
      <button type="submit" name="action" value="replace">Save edit</button>
      <button type="submit" name="action" value="remove" formnovalidate>Remove sentence</button>
      ${
        sentence.edited
          ? html`<button type="submit" name="action" value="revert" formnovalidate>
              Back to generated text
            </button>`
          : null
      }
    </form>
  </details>`;
}

function removedSentences(editorial: RecapEditorialView, token: string): SafeHtml | null {
  const { removedSentences: removed } = editorial.effective;
  if (removed.length === 0) return null;
  return html`<h3>Removed sentences (never exported)</h3>
    <ul class="notes">
      ${removed.map(
        (sentence) =>
          html`<li>
            <span class="removed">${sentence.text}</span>
            <form class="inline" method="post" action="${recapEditAction(editorial.revision)}">
              ${editHidden(editorial, 'sentence', sentence.sentence_id, token)}
              <button type="submit" name="action" value="revert">Restore</button>
            </form>
          </li>`,
      )}
    </ul>`;
}

function noteEditForm(note: EffectiveNote, editorial: RecapEditorialView, token: string): SafeHtml {
  return html`<details class="edit">
    <summary>Edit note</summary>
    <form class="grid" method="post" action="${recapEditAction(editorial.revision)}">
      ${editHidden(editorial, 'gm_note', note.note_id, token)}
      <label class="wide"
        >Text <textarea name="text" required maxlength="2000">${note.text}</textarea>
      </label>
      <button type="submit" name="action" value="replace">Save edit</button>
      <button type="submit" name="action" value="remove" formnovalidate>Hide note</button>
      ${
        note.edited
          ? html`<button type="submit" name="action" value="revert" formnovalidate>
              Back to generated text
            </button>`
          : null
      }
    </form>
  </details>`;
}

function titleEditForm(editorial: RecapEditorialView, token: string): SafeHtml {
  return html`<details class="edit">
    <summary>Edit title</summary>
    <form class="grid" method="post" action="${recapEditAction(editorial.revision)}">
      ${editHidden(editorial, 'title', 'title', token)}
      <label class="wide"
        >Title
        <input
          type="text"
          name="text"
          required
          maxlength="200"
          value="${editorial.effective.title}"
      /></label>
      <button type="submit" name="action" value="replace">Save title</button>
      ${
        editorial.effective.titleEdited
          ? html`<button type="submit" name="action" value="revert" formnovalidate>
              Back to generated title
            </button>`
          : null
      }
    </form>
  </details>`;
}

function spoilerConfirmation(editorial: RecapEditorialView, what: string): SafeHtml | null {
  if (editorial.spoilersIncluded.length === 0) return null;
  return html`${editorial.spoilersIncluded.map(
      (id) => html`<input type="hidden" name="spoilers_ack" value="${id}" />`,
    )}
    <label class="wide">
      <input type="checkbox" name="spoilers_confirm" value="yes" required />
      I checked the ${editorial.spoilersIncluded.length} possible spoiler(s) above and ${what}
    </label>`;
}

function revisionAction(revision: number, step: string): string {
  return `/api/recap/revisions/${String(revision)}/${step}`;
}

const STATE_TEXT: Readonly<Record<EditorialState, string>> = {
  draft: 'DRAFT: not reviewed',
  reviewed: 'REVIEWED: not approved',
  approved: 'APPROVED: this exact content',
  exported: 'EXPORTED: frozen for content',
};

function approvalPanel(editorial: RecapEditorialView, token: string): SafeHtml {
  const { state, revision, contentHash, approval, blockers } = editorial;
  const canApprove = state === 'reviewed' && blockers.length === 0;
  const canExport = (state === 'approved' || state === 'exported') && blockers.length === 0;
  const lastExport = editorial.exports[editorial.exports.length - 1];
  return html`<section class="panel approval" id="recap-approval">
    <h2>Approval: revision ${revision} <span class="state-${state}">${STATE_TEXT[state]}</span></h2>
    <dl>
      <dt>Content hash</dt>
      <dd class="mono">${contentHash}</dd>
      ${
        approval === null
          ? null
          : html`<dt>Approved by</dt>
              <dd>${approval.reviewer_id} at ${approval.approved_at}</dd>`
      }
      ${
        editorial.origin === 'fork'
          ? html`<dt>Forked from</dt>
              <dd>revision ${editorial.parentRevision}</dd>`
          : null
      }
    </dl>
    ${blockers.map((blocker) => html`<div class="alert danger">${blocker.message}</div>`)}
    ${
      state === 'exported'
        ? html`<div class="alert warn">
            This revision was exported and is frozen. A change to its text forks a new revision,
            which then needs its own review and approval.
          </div>`
        : null
    }
    ${
      editorial.spoilersIncluded.length > 0 && (state === 'reviewed' || canExport)
        ? html`<div class="alert danger">
            ${editorial.spoilersIncluded.length} line(s) flagged as possible spoilers are still
            included in this recap. Check them before you approve or export: nothing filters them
            out.
          </div>`
        : null
    }
    <div class="actions">
      ${
        state === 'draft'
          ? html`<form method="post" action="${revisionAction(revision, 'review')}">
              ${tokenField(token)}
              <input type="hidden" name="expected_hash" value="${contentHash}" />
              <button type="submit">Mark reviewed</button>
            </form>`
          : null
      }
      ${
        canApprove
          ? html`<form class="grid" method="post" action="${revisionAction(revision, 'approve')}">
              ${tokenField(token)}
              <input type="hidden" name="expected_hash" value="${contentHash}" />
              ${spoilerConfirmation(editorial, 'approve them going out with this recap.')}
              <button type="submit">Approve this exact revision</button>
            </form>`
          : null
      }
      ${
        state === 'reviewed' || state === 'approved'
          ? html`<form class="inline" method="post" action="${revisionAction(revision, 'reopen')}">
              ${tokenField(token)}
              <button type="submit">Reopen as draft</button>
            </form>`
          : null
      }
      ${
        canExport
          ? html`<form class="grid" method="post" action="${revisionAction(revision, 'export')}">
              ${tokenField(token)}
              <input type="hidden" name="expected_hash" value="${contentHash}" />
              ${spoilerConfirmation(editorial, 'want them in the exported package.')}
              <button type="submit">Export recap package</button>
            </form>`
          : null
      }
    </div>
    ${
      lastExport === undefined
        ? null
        : html`<p class="muted">
            Exported ${editorial.exports.length} time(s), last at ${lastExport.exported_at}.
            <a href="${revisionAction(revision, 'export/latest')}">Download the package</a> for the
            Foundry import. Nothing is published to players from here.
          </p>`
    }
    ${
      editorial.markdown === null
        ? html`<p class="muted">Copy Markdown appears once this exact content is approved.</p>`
        : html`<h3>Copy Markdown</h3>
            <textarea id="copy-source" readonly>${editorial.markdown}</textarea>
            <button type="button" id="copy-markdown" hidden>Copy Markdown</button>
            <span id="copy-status" class="muted"></span>`
    }
  </section>`;
}

function recapPanels(draft: RecapDraftView, screen: ReviewScreen, token: string): SafeHtml {
  const bySegment = new Map(screen.view.segments.map((s) => [s.segment_id, s]));
  let counter = 0;
  const footnotes: Footnoter = { next: () => (counter += 1) };
  const { editorial } = draft;
  const { effective } = editorial;
  return html`${draft.staleness.map(
      (reason) => html`<div class="alert warn">${STALE_TEXT[reason]}</div>`,
    )}
    ${approvalPanel(editorial, token)}
    <section class="panel player" id="recap-player">
      <span class="banner">PLAYER-FACING (only an approved revision can be exported)</span>
      <h2>
        ${effective.title} <span class="muted">revision ${draft.revision}</span>
        ${effective.titleEdited ? html`<span class="chip warn">edited</span>` : null}
      </h2>
      ${titleEditForm(editorial, token)}
      <ol class="sentences">
        ${effective.sentences.map(
          (sentence) =>
            html`<li id="${anchorOfSentence(sentence.sentence_id)}">
              ${sentence.text} ${citationNotes(sentence.citations, bySegment, footnotes)}
              <span class="muted">${sentence.assertion}</span>
              ${
                sentence.edited
                  ? html`<span class="chip warn">edited — verify evidence</span>`
                  : null
              }
              ${
                sentence.citations.segment_ids.length === 0
                  ? html`<span class="chip warn">no citation</span>`
                  : null
              }
              ${evidenceWarnings(sentence.citations, bySegment)}
              ${sentenceEditForm(sentence, editorial, token)}
            </li>`,
        )}
      </ol>
      ${removedSentences(editorial, token)}
    </section>
    <section class="panel gm-only" id="recap-gm-notes">
      <span class="banner">GM ONLY. NEVER SEND TO PLAYERS</span>
      <h2>GM notes (${effective.gmNotes.length})</h2>
      ${
        effective.gmNotes.length === 0
          ? html`<p class="muted">No notes.</p>`
          : html`<ul class="notes">
              ${effective.gmNotes.map(
                (note) =>
                  html`<li>
                    <span class="chip">${note.reason}</span> ${note.text}
                    ${citationNotes(note.citations, bySegment, footnotes)}
                    ${note.edited ? html`<span class="chip warn">edited</span>` : null}
                    ${noteEditForm(note, editorial, token)}
                  </li>`,
              )}
            </ul>`
      }
      ${
        effective.removedNotes.length === 0
          ? null
          : html`<h3>Hidden notes</h3>
              <ul class="notes">
                ${effective.removedNotes.map(
                  (note) =>
                    html`<li>
                      <span class="removed">${note.text}</span>
                      <form
                        class="inline"
                        method="post"
                        action="${recapEditAction(editorial.revision)}"
                      >
                        ${editHidden(editorial, 'gm_note', note.note_id, token)}
                        <button type="submit" name="action" value="revert">Restore</button>
                      </form>
                    </li>`,
                )}
              </ul>`
      }
    </section>`;
}

function regenerationText(state: RegenerationState): HtmlValue {
  switch (state.status) {
    case 'idle':
      return null;
    case 'running':
      return 'Generating: this can take a few minutes. Corrections are locked until it ends.';
    case 'succeeded':
      return `Generated revision ${String(state.revision ?? '?')}.`;
    case 'up-to-date':
      return 'Nothing changed since the last draft, so no new revision was written.';
    case 'cancelled':
      return 'Generation was cancelled.';
    case 'failed':
      return `Generation failed (${state.errorCode ?? 'error'}): ${state.message ?? ''}`;
  }
}

function regeneratePanel(
  screen: ReviewScreen,
  context: PageContext,
  spoilersIncluded: readonly ReviewSegment[],
): SafeHtml {
  const { view } = screen;
  const included = view.segments.filter((s) => s.recap_inclusion === 'include').length;
  const unresolved = view.segments.filter((s) => s.recap_inclusion === 'unresolved').length;
  const excluded = view.segments.length - included - unresolved;
  const lost = unreconciledExclusions(view).length;
  const state = context.regeneration;
  const blocked =
    lost > 0
      ? `${String(lost)} lost spoiler or privacy exclusion(s) must be reconciled first.`
      : !context.canRegenerate
        ? 'Restart `recap review` with --config and --glossary to regenerate from here.'
        : state.status === 'running'
          ? 'A generation is running.'
          : null;
  const status = regenerationText(state);
  return html`<section class="panel" id="recap">
    <h2>Regenerate the draft</h2>
    <p class="muted">
      From the corrected state: ${included} included, ${unresolved} waiting for you, ${excluded}
      excluded.
    </p>
    ${spoilerAlert(spoilersIncluded)}
    <p id="regen-status" data-state="${state.status}">${status}</p>
    ${
      blocked === null
        ? html`<form method="post" action="/api/recap/regenerate">
            ${tokenField(context.token)}
            <label>
              <input type="checkbox" name="confirm" value="yes" required />
              Send the ${included} included line(s) to the recap provider
              ${
                spoilersIncluded.length > 0
                  ? html`, including ${spoilersIncluded.length} possible spoiler(s)`
                  : null
              }
            </label>
            <button type="submit">Regenerate</button>
          </form>`
        : html`<p class="alert warn">${blocked}</p>`
    }
  </section>`;
}

/** The whole screen. */
export function renderReviewPage(context: PageContext): string {
  const { screen, token } = context;
  const { view, overrides, foundry } = screen;
  const byId = new Map(overrides.map((override) => [override.override_id, override]));
  const queue = reviewQueue(view);
  const pending = new Set(queue.map((entry) => entry.segment.segment_id));
  const nextInQueue = new Map<string, string>();
  queue.forEach((entry, index) => {
    const following = queue[index + 1];
    if (following !== undefined) {
      nextInQueue.set(entry.segment.segment_id, following.segment.segment_id);
    }
  });
  const citedBy = new Map<string, string[]>();
  for (const sentence of screen.recap?.editorial.effective.sentences ?? []) {
    for (const id of sentence.citations.segment_ids) {
      citedBy.set(id, [...(citedBy.get(id) ?? []), sentence.sentence_id]);
    }
  }
  const spoilersIncluded = view.segments.filter(
    (segment) =>
      segment.classification_flags.includes('possible_spoiler') &&
      segment.recap_inclusion === 'include',
  );
  const unplaced = foundry.events.filter((entry) => entry.approxOffsetMs === null);
  const items = transcriptItems(screen, (segment) =>
    segmentCard(
      segment,
      segment.override_id === undefined ? undefined : byId.get(segment.override_id),
      { token, citedBy, nextInQueue, pending },
    ),
  );
  const page = html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Review ${view.campaign_id}/${view.session_id}</title>
        <link rel="stylesheet" href="/static/review.css" />
        ${context.hasClient ? html`<script type="module" src="/static/review.js"></script>` : null}
      </head>
      <body>
        <header class="page">
          <h1>Session review: ${view.campaign_id} / ${view.session_id}</h1>
          <p>
            transcription <span class="mono">${view.transcription_run_id}</span>, classification
            <span class="mono">${view.classification_run_id ?? 'none yet'}</span>. Local only: this
            page is not shared with players.
          </p>
        </header>
        <main>
          <div>
            ${reconcilePanel(screen, token)} ${spoilerAlert(spoilersIncluded)} ${queuePanel(screen)}
            <section class="panel" id="transcript">
              <h2>Transcript (${view.segments.length} lines, chronological)</h2>
              ${timeline(view.segments)}
              <div id="filters" hidden>
                <button type="button" data-filter="all" aria-pressed="true">All</button>
                <button type="button" data-filter="attention" aria-pressed="false">
                  To review
                </button>
                ${LABELS.map(
                  (label) =>
                    html`<button type="button" data-filter="label:${label}" aria-pressed="false">
                      ${label}
                    </button>`,
                )}
                <span class="muted">j / k: next / previous line</span>
              </div>
              ${
                foundry.events.length === 0
                  ? null
                  : html`<p class="muted">
                      Foundry event positions are estimates from the capture clocks
                      (${
                        foundry.originUncertaintyMs === null
                          ? 'origin unknown'
                          : `origin within ${String(foundry.originUncertaintyMs)} ms`
                      }),
                      not verified
                      alignment.${
                        foundry.skipped > 0
                          ? ` ${String(foundry.skipped)} unreadable line(s) skipped.`
                          : ''
                      }
                    </p>`
              }
              ${items}
              ${
                unplaced.length === 0
                  ? null
                  : html`<h3>Foundry events without a position</h3>
                      ${unplaced.map((entry) => foundryEvent(entry.event, null))}`
              }
            </section>
          </div>
          <aside class="side">
            ${
              screen.recapProblem === null
                ? null
                : html`<div class="alert danger">
                    The latest draft cannot be shown: ${screen.recapProblem}
                  </div>`
            }
            ${
              screen.recap === null
                ? html`<section class="panel"><p class="muted">No recap draft yet.</p></section>`
                : recapPanels(screen.recap, screen, token)
            }
            ${regeneratePanel(screen, context, spoilersIncluded)}
          </aside>
        </main>
      </body>
    </html>`;
  return page.value;
}

export function renderMessagePage(title: string, message: string, hint?: string): string {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>${title}</title>
        <link rel="stylesheet" href="/static/review.css" />
      </head>
      <body>
        <main>
          <section class="panel">
            <h2>${title}</h2>
            <p>${message}</p>
            ${hint === undefined ? null : html`<p class="muted">${hint}</p>`}
            <p><a href="/">Back to the review</a></p>
          </section>
        </main>
      </body>
    </html>`.value;
}
