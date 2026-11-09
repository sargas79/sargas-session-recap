import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { validateContract } from '@sargas-recap/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  discardUnreconciled,
  getOverride,
  listOverrideHistory,
  listOverrides,
  loadSessionReview,
  reconcileToSegment,
  setSegmentOverride,
  toReviewOverride,
  unreconciledExclusions,
} from '../../src/review/index.ts';
import { CLASS_1, CLASS_2, newWorld, result, RUN_A, RUN_B, seg, type World } from './helpers.ts';

const A0 = seg(RUN_A, 0, 0, 1_000, 'Primeira fala sintetica.');
const A1 = seg(RUN_A, 0, 1, 6_000, 'Segunda fala sintetica.');
// Resegmented: same audio, the first line is now split in two and the rest is identical.
const B0 = seg(RUN_B, 0, 0, 1_000, 'Primeira fala');
const B1 = seg(RUN_B, 0, 1, 2_500, 'sintetica.');
const B2 = seg(RUN_B, 0, 2, 6_000, 'Segunda fala sintetica.');

let world: World;

beforeEach(async () => {
  world = await newWorld();
  await world.transcribe(RUN_A, [A0, A1]);
  await world.classify(CLASS_1, RUN_A, [result(CLASS_1, A0, 'ic'), result(CLASS_1, A1, 'mixed')]);
});

afterEach(() => {
  world.close();
});

describe('setting overrides', () => {
  it('stores a valid row with the identity of ADR-005 and a history entry', async () => {
    const override = await setSegmentOverride(world.ref, A0.segment_id, {
      labelOverride: 'ooc',
      exclusionReasons: ['spoiler'],
    });
    expect(override).toMatchObject({
      transcription_run_id: RUN_A,
      segment_id: A0.segment_id,
      base_text_hash: A0.text_hash,
      revision: 1,
    });
    expect(validateContract('review-override', toReviewOverride(override)).ok).toBe(true);
    expect(listOverrideHistory(world.db, override.override_id)).toMatchObject([
      { revision: 1, action: 'create', label_override: 'ooc', exclusion_reasons: ['spoiler'] },
    ]);
  });

  it('changes the same row, keeps untouched fields and records every revision', async () => {
    const first = await setSegmentOverride(world.ref, A1.segment_id, { labelOverride: 'ic' });
    const second = await setSegmentOverride(world.ref, A1.segment_id, {
      textOverride: 'Texto\r\nlimpo.',
      reviewStatus: 'reviewed',
    });
    expect(second.override_id).toBe(first.override_id);
    expect(second).toMatchObject({
      revision: 2,
      label_override: 'ic',
      text_override: 'Texto\nlimpo.',
      review_status: 'reviewed',
    });
    const cleared = await setSegmentOverride(world.ref, A1.segment_id, { textOverride: null });
    expect(cleared).not.toHaveProperty('text_override');
    expect(listOverrideHistory(world.db, first.override_id).map((h) => h.revision)).toEqual([
      1, 2, 3,
    ]);
  });

  it('adds no revision when nothing changes', async () => {
    await setSegmentOverride(world.ref, A0.segment_id, { labelOverride: 'ic' });
    const same = await setSegmentOverride(world.ref, A0.segment_id, { labelOverride: 'ic' });
    expect(same.revision).toBe(1);
  });

  it('refuses a segment outside the active run, and text that does not fit', async () => {
    await expect(
      setSegmentOverride(world.ref, `${RUN_A}:7:7`, { labelOverride: 'ic' }),
    ).rejects.toMatchObject({ code: 'REVIEW_SEGMENT_NOT_FOUND' });
    await expect(
      setSegmentOverride(world.ref, A0.segment_id, { textOverride: '   ' }),
    ).rejects.toMatchObject({ code: 'REVIEW_INVALID_OVERRIDE' });
    await expect(
      setSegmentOverride(world.ref, A0.segment_id, { textOverride: 'x'.repeat(20_001) }),
    ).rejects.toMatchObject({ code: 'REVIEW_INVALID_OVERRIDE' });
  });

  it('the database itself protects the identity and the history', async () => {
    const override = await setSegmentOverride(world.ref, A0.segment_id, { labelOverride: 'ic' });
    expect(() =>
      world.db
        .prepare('UPDATE review_overrides SET segment_id = ? WHERE override_id = ?')
        .run(A1.segment_id, override.override_id),
    ).toThrow(/immutable/);
    expect(() => world.db.prepare('DELETE FROM review_override_history').run()).toThrow(
      /append-only/,
    );
    expect(() =>
      world.db.prepare("UPDATE review_override_history SET action = 'update'").run(),
    ).toThrow(/append-only/);
  });
});

describe('classification rerun', () => {
  it('never changes an override: the new labels show, the GM decisions stay', async () => {
    const before = await setSegmentOverride(world.ref, A0.segment_id, {
      labelOverride: 'narration',
      textOverride: 'Texto do mestre.',
      exclusionReasons: ['privacy'],
      reviewStatus: 'reviewed',
    });
    await world.classify(CLASS_2, RUN_A, [
      result(CLASS_2, A0, 'ooc'),
      result(CLASS_2, A1, 'uncertain'),
    ]);
    const { view, overrides } = await loadSessionReview(world.ref);
    expect(view.classification_run_id).toBe(CLASS_2);
    expect(view.needs_reconciliation).toEqual([]);
    expect(overrides).toEqual([before]);
    expect(view.segments[0]).toMatchObject({
      label: 'narration',
      classification_label: 'ooc',
      text: 'Texto do mestre.',
      recap_inclusion: 'exclude',
      exclusion_reasons: ['privacy'],
      review_status: 'reviewed',
    });
    expect(view.segments[1]).toMatchObject({ label: 'uncertain', recap_inclusion: 'unresolved' });
  });
});

describe('retranscription', () => {
  it('flags every override of the old run and attaches none by proximity', async () => {
    const spoiler = await setSegmentOverride(world.ref, A0.segment_id, {
      exclusionReasons: ['spoiler'],
    });
    const label = await setSegmentOverride(world.ref, A1.segment_id, { labelOverride: 'ic' });
    await world.transcribe(RUN_B, [B0, B1, B2]);

    const { view, overrides } = await loadSessionReview(world.ref);
    expect(view.transcription_run_id).toBe(RUN_B);
    // The old classification belongs to other segments.
    expect(view.classification_run_id).toBeNull();
    expect(view.segments.every((s) => s.override_id === undefined)).toBe(true);
    expect(view.segments.every((s) => s.exclusion_reasons.length === 0)).toBe(true);
    expect(view.needs_reconciliation.map((n) => n.override_id)).toEqual([
      spoiler.override_id,
      label.override_id,
    ]);
    expect(view.needs_reconciliation.every((n) => n.reason === 'run_changed')).toBe(true);
    expect(unreconciledExclusions(view).map((n) => n.override_id)).toEqual([spoiler.override_id]);

    expect(overrides.every((o) => o.reconciliation === 'needs_reconciliation')).toBe(true);
    expect(getOverride(world.db, spoiler.override_id)?.reconciliation).toBe('needs_reconciliation');
    expect(listOverrideHistory(world.db, spoiler.override_id).at(-1)).toMatchObject({
      action: 'reconciliation-state',
      revision: 2,
      reconciliation: 'needs_reconciliation',
    });
  });

  it('uses the classification of the new run once there is one', async () => {
    await world.transcribe(RUN_B, [B2]);
    await world.classify(CLASS_2, RUN_B, [result(CLASS_2, B2, 'ic')]);
    const { view } = await loadSessionReview(world.ref);
    expect(view.classification_run_id).toBe(CLASS_2);
  });

  it('a segment split: one override applied to both halves on request', async () => {
    const old = await setSegmentOverride(world.ref, A0.segment_id, {
      exclusionReasons: ['spoiler'],
      reviewStatus: 'reviewed',
    });
    await world.transcribe(RUN_B, [B0, B1, B2]);
    await loadSessionReview(world.ref);

    const first = await reconcileToSegment(world.ref, old.override_id, B0.segment_id);
    const second = await reconcileToSegment(world.ref, old.override_id, B1.segment_id);
    expect(first).toMatchObject({
      supersedes_override_id: old.override_id,
      transcription_run_id: RUN_B,
      base_text_hash: B0.text_hash,
      exclusion_reasons: ['spoiler'],
      reconciliation: 'attached',
      // The GM reviewed other words.
      review_status: 'pending',
      revision: 1,
    });
    expect(second.segment_id).toBe(B1.segment_id);

    const { view } = await loadSessionReview(world.ref);
    expect(view.needs_reconciliation).toEqual([]);
    expect(unreconciledExclusions(view)).toEqual([]);
    expect(view.segments.map((s) => s.recap_inclusion)).toEqual([
      'exclude',
      'exclude',
      'unresolved',
    ]);
    // The old row stays.
    expect(getOverride(world.db, old.override_id)).toMatchObject({
      transcription_run_id: RUN_A,
      exclusion_reasons: ['spoiler'],
    });
  });

  it('a segment merge: the second override needs a decision, nothing is lost', async () => {
    const first = await setSegmentOverride(world.ref, A0.segment_id, { labelOverride: 'ic' });
    const second = await setSegmentOverride(world.ref, A1.segment_id, {
      exclusionReasons: ['spoiler'],
    });
    const merged = seg(RUN_B, 0, 0, 1_000, `${A0.text_original} ${A1.text_original}`);
    await world.transcribe(RUN_B, [merged]);

    const initial = await loadSessionReview(world.ref);
    expect(initial.view.needs_reconciliation).toHaveLength(2);
    expect(initial.view.segments[0]?.override_id).toBeUndefined();

    await reconcileToSegment(world.ref, first.override_id, merged.segment_id);
    await expect(
      reconcileToSegment(world.ref, second.override_id, merged.segment_id),
    ).rejects.toMatchObject({ code: 'REVIEW_TARGET_TAKEN' });

    const still = await loadSessionReview(world.ref);
    expect(unreconciledExclusions(still.view).map((n) => n.override_id)).toEqual([
      second.override_id,
    ]);
    await setSegmentOverride(world.ref, merged.segment_id, { exclusionReasons: ['spoiler'] });
    await discardUnreconciled(world.ref, second.override_id);

    const done = await loadSessionReview(world.ref);
    expect(done.view.needs_reconciliation).toEqual([]);
    expect(done.view.segments[0]).toMatchObject({
      recap_inclusion: 'exclude',
      exclusion_reasons: ['spoiler'],
    });
    expect(listOverrideHistory(world.db, second.override_id).at(-1)?.action).toBe('dismiss');
  });

  it('keeps the review status when the text is the same', async () => {
    const old = await setSegmentOverride(world.ref, A1.segment_id, { reviewStatus: 'reviewed' });
    await world.transcribe(RUN_B, [B2]);
    const created = await reconcileToSegment(world.ref, old.override_id, B2.segment_id);
    expect(created.review_status).toBe('reviewed');
  });

  it('a further retranscription flags the reconciled row, not the one it replaced', async () => {
    const old = await setSegmentOverride(world.ref, A1.segment_id, {
      exclusionReasons: ['privacy'],
    });
    await world.transcribe(RUN_B, [B2]);
    const moved = await reconcileToSegment(world.ref, old.override_id, B2.segment_id);
    const runC = '01JBX7Q8M2N4P6R8S0T2V4W6Y0';
    const c0 = seg(runC, 0, 0, 6_000, B2.text_original);
    await world.transcribe(runC, [c0]);
    const { view } = await loadSessionReview(world.ref);
    expect(view.needs_reconciliation.map((n) => n.override_id)).toEqual([moved.override_id]);
    await expect(
      reconcileToSegment(world.ref, old.override_id, c0.segment_id),
    ).rejects.toMatchObject({ code: 'REVIEW_NOT_RECONCILABLE' });
  });

  it('refuses to reconcile an attached override, or a discarded one', async () => {
    const live = await setSegmentOverride(world.ref, A0.segment_id, { labelOverride: 'ic' });
    await expect(discardUnreconciled(world.ref, live.override_id)).rejects.toMatchObject({
      code: 'REVIEW_NOT_RECONCILABLE',
    });
    await world.transcribe(RUN_B, [B2]);
    await discardUnreconciled(world.ref, live.override_id);
    await expect(
      reconcileToSegment(world.ref, live.override_id, B2.segment_id),
    ).rejects.toMatchObject({ code: 'REVIEW_NOT_RECONCILABLE' });
    expect(listOverrides(world.db, world.ref.campaignId, world.ref.sessionId)).toEqual([]);
  });
});

describe('run integrity', () => {
  it('refuses a transcript edited after its job finished', async () => {
    const file = path.join(world.sessionDir, 'transcript', RUN_A, 'segments.jsonl');
    writeFileSync(file, `${JSON.stringify({ ...A0, text_original: 'Adulterado.' })}\n`);
    await expect(loadSessionReview(world.ref)).rejects.toMatchObject({
      code: 'REVIEW_RUN_INVALID',
    });
  });

  it('refuses a session without a transcription', async () => {
    await expect(loadSessionReview({ ...world.ref, sessionId: 'other' })).rejects.toMatchObject({
      code: 'REVIEW_NO_TRANSCRIPT',
    });
  });
});
