/**
 * Recap editing, approval and export (T15, ADR-007, ADR-010). Synthetic world only: invented
 * segments, a written draft, no model calls, no network.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  canonicalContentHash,
  recapContentFromPackage,
  validateContract,
  type Recap,
  type RecapPackage,
} from '@sargas-recap/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyRecapEdit,
  approvedRecapMarkdown,
  approveRecap,
  exportRecap,
  isRecapEditorialError,
  latestExportFile,
  latestRecapRevision,
  loadEditorialView,
  loadRecapDraft,
  markRecapReviewed,
  reopenRecap,
  type EditRequest,
} from '../../src/recap/index.ts';
import { listEdits } from '../../src/recap/editorial-store.ts';
import { loadSessionReview, setSegmentOverride } from '../../src/review/index.ts';
import {
  CAMPAIGN,
  CLASS_1,
  CLASS_2,
  newWorld,
  result,
  RUN_A,
  RUN_B,
  seg,
  SESSION,
  type World,
} from '../review/helpers.ts';
import { writeRecap } from '../review-ui/helpers.ts';

const SENTINEL_NOTE = 'SENTINELA-NOTA-DO-GM-SECRETA';
const SENTINEL_EXCLUDED = 'SENTINELA-LINHA-EXCLUIDA';
const SENTINEL_REMOVED = 'SENTINELA-FRASE-REMOVIDA';
const SENTINEL_UNAPPROVED = 'SENTINELA-TEXTO-NAO-APROVADO';

const A0 = seg(RUN_A, 0, 0, 1_000, 'Kira abre a porta do farol.');
const A1 = seg(RUN_A, 0, 1, 5_000, 'Bruno acende a lanterna.');
const A2 = seg(RUN_A, 0, 2, 9_000, `Linha secreta ${SENTINEL_EXCLUDED}`);
const FLAGGED = seg(RUN_A, 0, 3, 13_000, 'O guarda é o traidor.');

const REVISION = 1;
const S0 = 'r1:s0';
const S1 = 'r1:s1';
const NOTE = 'r1:g0';

let world: World;

function draftInput(extra: Partial<Recap> = {}): Pick<Recap, 'sentences' | 'gm_notes'> & {
  title?: string;
} {
  return {
    title: 'Sessão sintética',
    sentences: [
      {
        sentence_id: S0,
        text: 'Kira abriu a porta do farol.',
        assertion: 'completed',
        citations: { segment_ids: [A0.segment_id], event_ids: [] },
      },
      {
        sentence_id: S1,
        text: `Bruno acendeu a lanterna. ${SENTINEL_REMOVED}`,
        assertion: 'completed',
        citations: { segment_ids: [A1.segment_id], event_ids: [] },
      },
    ],
    gm_notes: [
      {
        note_id: NOTE,
        reason: 'unsupported',
        text: `Nota do mestre ${SENTINEL_NOTE}`,
        citations: { segment_ids: [A2.segment_id], event_ids: [] },
      },
    ],
    ...extra,
  };
}

async function seed(flagged = false): Promise<void> {
  await world.transcribe(RUN_A, [A0, A1, A2, ...(flagged ? [FLAGGED] : [])]);
  await world.classify(CLASS_1, RUN_A, [
    result(CLASS_1, A0, 'ic'),
    result(CLASS_1, A1, 'ic'),
    result(CLASS_1, A2, 'ic'),
    ...(flagged ? [result(CLASS_1, FLAGGED, 'ic', { flags: ['possible_spoiler'] })] : []),
  ]);
  await writeRecap(world, REVISION, draftInput());
}

beforeEach(async () => {
  world = await newWorld();
});

afterEach(() => {
  world.close();
});

async function viewOf(revision = REVISION) {
  const { view } = await loadSessionReview(world.ref);
  return loadEditorialView(world.ref, revision, view);
}

const NO_SPOILERS = { segmentIds: [], confirmed: false };

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (isRecapEditorialError(error)) return error.code;
    throw error;
  }
  throw new Error('expected a refusal');
}

async function reviewNow(revision = REVISION): Promise<string> {
  const { contentHash } = await viewOf(revision);
  await markRecapReviewed(world.ref, revision, contentHash, 'gm');
  return contentHash;
}

async function approveNow(revision = REVISION): Promise<string> {
  const hash = await reviewNow(revision);
  await approveRecap(world.ref, revision, { expectedHash: hash, spoilers: NO_SPOILERS }, 'gm');
  return hash;
}

function exportFileText(file: string): string {
  return readFileSync(path.join(world.sessionDir, ...file.split('/')), 'utf8');
}

function editSentence(text: string, expectedEditCount: number, id = S0): EditRequest {
  return { targetKind: 'sentence', targetId: id, action: 'replace', text, expectedEditCount };
}

describe('editing a generated draft', () => {
  beforeEach(() => seed());

  it('never rewrites recap.json and marks the sentence edited', async () => {
    const file = path.join(world.sessionDir, 'recap', '1', 'recap.json');
    const before = readFileSync(file, 'utf8');
    const outcome = await applyRecapEdit(
      world.ref,
      1,
      editSentence('Kira arrombou a porta.', 0),
      'gm',
    );
    expect(outcome).toMatchObject({ changed: true, forked: false, revision: 1 });
    expect(readFileSync(file, 'utf8')).toBe(before);
    const view = await viewOf();
    expect(view.effective.sentences[0]?.text).toBe('Kira arrombou a porta.');
    expect(view.effective.sentences[0]?.edited).toBe(true);
    expect(view.effective.sentences[1]?.edited).toBe(false);
    expect(view.draft.sentences[0]?.text).toBe('Kira abriu a porta do farol.');
  });

  it('writes nothing for an edit that changes nothing', async () => {
    const hash = await approveNow();
    const outcome = await applyRecapEdit(
      world.ref,
      1,
      editSentence('Kira abriu a porta do farol.', 0),
      'gm',
    );
    expect(outcome.changed).toBe(false);
    const view = await viewOf();
    expect(view.state).toBe('approved');
    expect(view.contentHash).toBe(hash);
    expect(view.editCount).toBe(0);
    expect(view.effective.sentences[0]?.edited).toBe(false);
  });

  it('normalizes line endings and NFC, refuses blank text and a stale form', async () => {
    await applyRecapEdit(world.ref, 1, editSentence('Sessão\r\ncerta.', 0), 'gm');
    const view = await viewOf();
    expect(view.effective.sentences[0]?.text).toBe('Sessão\ncerta.');
    expect(await codeOf(applyRecapEdit(world.ref, 1, editSentence('  ', 1), 'gm'))).toBe(
      'RECAP_EDIT_INVALID',
    );
    expect(await codeOf(applyRecapEdit(world.ref, 1, editSentence('outra', 0), 'gm'))).toBe(
      'RECAP_STALE',
    );
  });

  it('refuses unknown targets and removing the last sentence', async () => {
    expect(await codeOf(applyRecapEdit(world.ref, 1, editSentence('x', 0, 'r1:s9'), 'gm'))).toBe(
      'RECAP_TARGET_NOT_FOUND',
    );
    const remove = (id: string, n: number): EditRequest => ({
      targetKind: 'sentence',
      targetId: id,
      action: 'remove',
      expectedEditCount: n,
    });
    await applyRecapEdit(world.ref, 1, remove(S0, 0), 'gm');
    expect(await codeOf(applyRecapEdit(world.ref, 1, remove(S1, 1), 'gm'))).toBe(
      'RECAP_EDIT_INVALID',
    );
  });

  it('accepts short citation refs and refuses citations that are not included lines', async () => {
    await applyRecapEdit(
      world.ref,
      1,
      {
        ...editSentence('Bruno viu a porta.', 0),
        citations: { segment_ids: ['0:0', '0:1'] },
      },
      'gm',
    );
    const view = await viewOf();
    expect(view.effective.sentences[0]?.citations.segment_ids).toEqual([
      A0.segment_id,
      A1.segment_id,
    ]);
    await setSegmentOverride(world.ref, A2.segment_id, { exclusionReasons: ['spoiler'] });
    const refused = await codeOf(
      applyRecapEdit(
        world.ref,
        1,
        { ...editSentence('x', 1), citations: { segment_ids: [A2.segment_id] } },
        'gm',
      ),
    );
    expect(refused).toBe('RECAP_EDIT_INVALID');
  });
});

describe('approval is bound to the exact revision and content hash', () => {
  beforeEach(() => seed());

  it('needs review first and records hash, reviewer and timestamp', async () => {
    const { contentHash } = await viewOf();
    expect(
      await codeOf(
        approveRecap(world.ref, 1, { expectedHash: contentHash, spoilers: NO_SPOILERS }, 'gm'),
      ),
    ).toBe('RECAP_BAD_STATE');
    await markRecapReviewed(world.ref, 1, contentHash, 'gm');
    const approval = await approveRecap(
      world.ref,
      1,
      { expectedHash: contentHash, spoilers: NO_SPOILERS },
      'gm',
    );
    expect(approval.content_hash).toBe(contentHash);
    expect(approval.reviewer_id).toBe('gm');
    expect(approval.approved_at).toMatch(/^\d{4}-/);
    expect(validateContract('recap-approval', approval).ok).toBe(true);
    const view = await viewOf();
    expect(view.state).toBe('approved');
    expect(view.approval?.approval_id).toBe(approval.approval_id);
  });

  it('refuses approving content the GM did not see', async () => {
    await reviewNow();
    expect(
      await codeOf(
        approveRecap(
          world.ref,
          1,
          { expectedHash: 'sha256:' + 'a'.repeat(64), spoilers: NO_SPOILERS },
          'gm',
        ),
      ),
    ).toBe('RECAP_STALE');
  });

  it('any content edit after approval ends it, and reverting does not resurrect it', async () => {
    await approveNow();
    await applyRecapEdit(world.ref, 1, editSentence('Kira chutou a porta.', 0), 'gm');
    let view = await viewOf();
    expect(view.state).toBe('draft');
    expect(view.approval).toBeNull();
    expect(
      await codeOf(
        exportRecap(world.ref, 1, { expectedHash: view.contentHash, spoilers: NO_SPOILERS }, 'gm'),
      ),
    ).toBe('RECAP_NOT_APPROVED');
    await applyRecapEdit(
      world.ref,
      1,
      { targetKind: 'sentence', targetId: S0, action: 'revert', expectedEditCount: 1 },
      'gm',
    );
    view = await viewOf();
    expect(view.state).toBe('draft');
    expect(view.approval).toBeNull();
  });

  it('a title edit also invalidates it', async () => {
    await approveNow();
    await applyRecapEdit(
      world.ref,
      1,
      {
        targetKind: 'title',
        targetId: 'title',
        action: 'replace',
        text: 'Novo',
        expectedEditCount: 0,
      },
      'gm',
    );
    expect((await viewOf()).state).toBe('draft');
  });

  it('a GM-note edit leaves the approval and the hash alone', async () => {
    const hash = await approveNow();
    await applyRecapEdit(
      world.ref,
      1,
      {
        targetKind: 'gm_note',
        targetId: NOTE,
        action: 'replace',
        text: 'Outra nota',
        expectedEditCount: 0,
      },
      'gm',
    );
    const view = await viewOf();
    expect(view.state).toBe('approved');
    expect(view.contentHash).toBe(hash);
    expect(view.effective.gmNotes[0]?.text).toBe('Outra nota');
  });

  it('reopen revokes an approval and keeps it as history', async () => {
    await approveNow();
    await reopenRecap(world.ref, 1, 'gm');
    const view = await viewOf();
    expect(view.state).toBe('draft');
    expect(view.approval).toBeNull();
    const rows = world.db.prepare('SELECT COUNT(*) AS n FROM recap_approvals').get() as {
      n: number;
    };
    expect(rows.n).toBe(1);
  });

  it('the logs are append-only at the database level', async () => {
    await approveNow();
    expect(() => world.db.prepare('UPDATE recap_approvals SET reviewer_id = ?').run('x')).toThrow(
      /immutable/,
    );
    expect(() => world.db.prepare('DELETE FROM recap_editorial_transitions').run()).toThrow(
      /append-only/,
    );
    expect(world.db.prepare('SELECT COUNT(*) AS n FROM recap_editorial_transitions').get()).toEqual(
      { n: 2 },
    );
  });

  it('refuses approval while an exclusion is unreconciled', async () => {
    await reviewNow();
    await setSegmentOverride(world.ref, A2.segment_id, { exclusionReasons: ['spoiler'] });
    const B0 = seg(RUN_B, 0, 0, 1_000, 'Outro texto inteiramente diferente.');
    await world.transcribe(RUN_B, [B0]);
    await world.classify(CLASS_2, RUN_B, [result(CLASS_2, B0, 'ic')]);
    const view = await viewOf();
    expect(view.blockers.map((blocker) => blocker.code)).toContain('unreconciled-exclusions');
    expect(
      await codeOf(
        approveRecap(world.ref, 1, { expectedHash: view.contentHash, spoilers: NO_SPOILERS }, 'gm'),
      ),
    ).toBe('RECAP_BLOCKED');
  });

  it('refuses approval, export and copy once a cited line is excluded', async () => {
    const hash = await approveNow();
    await setSegmentOverride(world.ref, A0.segment_id, { exclusionReasons: ['privacy'] });
    expect((await viewOf()).blockers.map((blocker) => blocker.code)).toEqual(['cites-excluded']);
    expect(
      await codeOf(exportRecap(world.ref, 1, { expectedHash: hash, spoilers: NO_SPOILERS }, 'gm')),
    ).toBe('RECAP_BLOCKED');
    expect(await codeOf(approvedRecapMarkdown(world.ref, 1))).toBe('RECAP_BLOCKED');
    await reopenRecap(world.ref, 1, 'gm');
    await markRecapReviewed(world.ref, 1, hash, 'gm');
    expect(
      await codeOf(approveRecap(world.ref, 1, { expectedHash: hash, spoilers: NO_SPOILERS }, 'gm')),
    ).toBe('RECAP_BLOCKED');
  });
});

describe('possible spoilers still included', () => {
  it('approval names them and needs the GM to confirm exactly that set', async () => {
    await seed(true);
    const hash = await reviewNow();
    const view = await viewOf();
    expect(view.spoilersIncluded).toEqual([FLAGGED.segment_id]);
    expect(
      await codeOf(approveRecap(world.ref, 1, { expectedHash: hash, spoilers: NO_SPOILERS }, 'gm')),
    ).toBe('RECAP_SPOILERS_NOT_ACKNOWLEDGED');
    expect(
      await codeOf(
        approveRecap(
          world.ref,
          1,
          { expectedHash: hash, spoilers: { segmentIds: [], confirmed: true } },
          'gm',
        ),
      ),
    ).toBe('RECAP_SPOILERS_NOT_ACKNOWLEDGED');
    const acknowledged = { segmentIds: [FLAGGED.segment_id], confirmed: true };
    await approveRecap(world.ref, 1, { expectedHash: hash, spoilers: acknowledged }, 'gm');
    expect((await viewOf()).state).toBe('approved');
    expect(
      await codeOf(exportRecap(world.ref, 1, { expectedHash: hash, spoilers: NO_SPOILERS }, 'gm')),
    ).toBe('RECAP_SPOILERS_NOT_ACKNOWLEDGED');
    const exported = await exportRecap(
      world.ref,
      1,
      { expectedHash: hash, spoilers: acknowledged },
      'gm',
    );
    expect(exported.manifest.content_hash).toBe(hash);
  });
});

describe('export', () => {
  beforeEach(() => seed());

  it('refuses a draft, a reviewed revision and a hash that does not match', async () => {
    const { contentHash } = await viewOf();
    expect(
      await codeOf(
        exportRecap(world.ref, 1, { expectedHash: contentHash, spoilers: NO_SPOILERS }, 'gm'),
      ),
    ).toBe('RECAP_NOT_APPROVED');
    await reviewNow();
    expect(
      await codeOf(
        exportRecap(world.ref, 1, { expectedHash: contentHash, spoilers: NO_SPOILERS }, 'gm'),
      ),
    ).toBe('RECAP_NOT_APPROVED');
    await approveRecap(world.ref, 1, { expectedHash: contentHash, spoilers: NO_SPOILERS }, 'gm');
    expect(
      await codeOf(
        exportRecap(
          world.ref,
          1,
          { expectedHash: 'sha256:' + '0'.repeat(64), spoilers: NO_SPOILERS },
          'gm',
        ),
      ),
    ).toBe('RECAP_STALE');
    world.db
      .prepare(
        `INSERT INTO recap_edits (edit_id, campaign_id, session_id, recap_revision, sequence,
           target_kind, target_id, action, text, citations, reviewer_id, created_at)
         VALUES (?, ?, ?, 1, 0, 'title', 'title', 'replace', ?, NULL, 'gm', '2026-11-02T22:10:00.000Z')`,
      )
      .run('01JBX7Q8M2N4P6R8S0T2V4W6AB', CAMPAIGN, SESSION, SENTINEL_UNAPPROVED);
    const mismatch = await viewOf();
    expect(mismatch.state).toBe('approved');
    expect(mismatch.contentHash).not.toBe(contentHash);
    expect(mismatch.markdown).toBeNull();
    expect(
      await codeOf(
        exportRecap(
          world.ref,
          1,
          { expectedHash: mismatch.contentHash, spoilers: NO_SPOILERS },
          'gm',
        ),
      ),
    ).toBe('RECAP_HASH_MISMATCH');
    expect(await codeOf(approvedRecapMarkdown(world.ref, 1))).toBe('RECAP_NOT_APPROVED');
  });

  it('writes a package that validates and hashes to the approved content', async () => {
    const hash = await approveNow();
    const { manifest, file } = await exportRecap(
      world.ref,
      1,
      { expectedHash: hash, spoilers: NO_SPOILERS },
      'gm',
    );
    const text = exportFileText(file);
    const parsed = JSON.parse(text) as RecapPackage;
    const checked = validateContract('recap-package', parsed);
    expect(checked.ok).toBe(true);
    expect(parsed.content_hash).toBe(hash);
    expect(parsed.approval.approved_content_hash).toBe(hash);
    expect(canonicalContentHash(recapContentFromPackage(parsed.content))).toBe(hash);
    expect(parsed.content.footnotes.map((f) => f.footnote_id)).toEqual(['r1:f0', 'r1:f1']);
    const evidence = parsed.content.footnotes[0]?.evidence[0];
    expect(evidence).toMatchObject({
      kind: 'segment',
      ref: A0.segment_id,
      session_offset_ms: 1_000,
      speaker_label: 'gm',
      excerpt: 'Kira abre a porta do farol.',
    });
    expect(validateContract('recap-export-manifest', manifest).ok).toBe(true);
    expect((await latestExportFile(world.ref, 1)).text).toBe(text);
    const view = await viewOf();
    expect(view.state).toBe('exported');
  });

  it('exports and copies no GM note, excluded line, removed sentence or unapproved text', async () => {
    await applyRecapEdit(
      world.ref,
      1,
      { targetKind: 'sentence', targetId: S1, action: 'remove', expectedEditCount: 0 },
      'gm',
    );
    await setSegmentOverride(world.ref, A2.segment_id, { exclusionReasons: ['privacy'] });
    const hash = await approveNow();
    const markdown = await approvedRecapMarkdown(world.ref, 1);
    const { file } = await exportRecap(
      world.ref,
      1,
      { expectedHash: hash, spoilers: NO_SPOILERS },
      'gm',
    );
    const packaged = exportFileText(file);
    for (const output of [markdown, packaged]) {
      expect(output).not.toContain(SENTINEL_NOTE);
      expect(output).not.toContain(SENTINEL_EXCLUDED);
      expect(output).not.toContain(SENTINEL_REMOVED);
      expect(output).not.toContain(SENTINEL_UNAPPROVED);
    }
    expect(markdown).toContain('Kira abriu a porta do farol.');
  });

  it('copy needs an approval in force', async () => {
    expect(await codeOf(approvedRecapMarkdown(world.ref, 1))).toBe('RECAP_NOT_APPROVED');
    expect((await viewOf()).markdown).toBeNull();
    await approveNow();
    expect((await viewOf()).markdown).toContain('Sessão sintética');
  });

  it('re-exports the same hash and forks on a content edit, leaving the original frozen', async () => {
    const hash = await approveNow();
    await exportRecap(world.ref, 1, { expectedHash: hash, spoilers: NO_SPOILERS }, 'gm');
    await exportRecap(world.ref, 1, { expectedHash: hash, spoilers: NO_SPOILERS }, 'gm');
    expect((await viewOf()).exports).toHaveLength(2);

    await applyRecapEdit(
      world.ref,
      1,
      {
        targetKind: 'gm_note',
        targetId: NOTE,
        action: 'replace',
        text: 'Nota nova',
        expectedEditCount: 0,
      },
      'gm',
    );
    expect((await viewOf()).state).toBe('exported');

    const outcome = await applyRecapEdit(world.ref, 1, editSentence('Conteúdo novo.', 1), 'gm');
    expect(outcome).toMatchObject({ changed: true, forked: true, revision: 2, state: 'draft' });
    const original = await viewOf(1);
    expect(original.state).toBe('exported');
    expect(original.contentHash).toBe(hash);
    expect(original.effective.sentences[0]?.text).toBe('Kira abriu a porta do farol.');

    const fork = await viewOf(2);
    expect(fork.origin).toBe('fork');
    expect(fork.parentRevision).toBe(1);
    expect(fork.state).toBe('draft');
    expect(fork.draft.sentences.map((s) => s.sentence_id)).toEqual(['r2:s0', 'r2:s1']);
    expect(fork.effective.sentences[0]?.text).toBe('Conteúdo novo.');
    expect(fork.effective.sentences[0]?.edited).toBe(true);
    expect(fork.effective.gmNotes[0]?.note_id).toBe('r2:g0');
    expect(fork.effective.gmNotes[0]?.text).toBe('Nota nova');
    expect(fork.effective.gmNotes[0]?.edited).toBe(true);
    expect(latestRecapRevision(world.ref)).toBe(2);
    expect((await loadRecapDraft(world.ref, 2)).recap_revision).toBe(2);
    expect(existsRow('fork', 2, 1)).toBe(true);
    // The new revision gets its own approval and its own, higher revision number.
    const newHash = await approveNow(2);
    expect(newHash).not.toBe(hash);
    const exported = await exportRecap(
      world.ref,
      2,
      { expectedHash: newHash, spoilers: NO_SPOILERS },
      'gm',
    );
    expect(exported.manifest.recap_revision).toBe(2);
    expect(await codeOf(reopenRecap(world.ref, 2, 'gm'))).toBe('RECAP_BAD_STATE');
  });

  it('the edit log of a fork carries only effective edits', async () => {
    await applyRecapEdit(world.ref, 1, editSentence('Primeira.', 0), 'gm');
    await applyRecapEdit(
      world.ref,
      1,
      { targetKind: 'sentence', targetId: S0, action: 'revert', expectedEditCount: 1 },
      'gm',
    );
    await applyRecapEdit(world.ref, 1, { ...editSentence('Segunda.', 2, S1) }, 'gm');
    const hash = await approveNow();
    await exportRecap(world.ref, 1, { expectedHash: hash, spoilers: NO_SPOILERS }, 'gm');
    await applyRecapEdit(world.ref, 1, editSentence('Terceira.', 3), 'gm');
    const edits = listEdits({
      db: world.db,
      campaignId: CAMPAIGN,
      sessionId: SESSION,
      revision: 2,
    });
    expect(edits.map((edit) => [edit.target_id, edit.text])).toEqual([
      ['r2:s1', 'Segunda.'],
      ['r2:s0', 'Terceira.'],
    ]);
  });
});

function existsRow(origin: string, revision: number, parent: number): boolean {
  return (
    world.db
      .prepare(
        'SELECT 1 FROM recap_revisions WHERE campaign_id = ? AND session_id = ? AND revision = ? AND origin = ? AND parent_revision = ?',
      )
      .get(CAMPAIGN, SESSION, revision, origin, parent) !== undefined
  );
}
