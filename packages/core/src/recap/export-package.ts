/**
 * Builds the `recap-package` of an approved revision (T15, ADR-007, ADR-010): the player-facing
 * effective content plus, per sentence, footnotes whose evidence refs are exactly its citations.
 * Pure: the guards (approval, hash, blockers) are editorial.ts. GM notes are never read here, so
 * they cannot reach a package.
 */
import type {
  EffectiveTranscriptReview,
  RecapApproval,
  RecapPackage,
} from '@sargas-recap/contracts';
import type { EffectiveRecap } from './editorial.ts';

/** `excerpt` in the contract. Longer text is cut on a code point, not inside a pair. */
const EXCERPT_MAX = 500;
/** Bump when the package shape produced here changes. */
export const EXPORT_GENERATOR_VERSION = '1';

function excerptOf(text: string): string {
  return Array.from(text).slice(0, EXCERPT_MAX).join('');
}

export interface PackageInput {
  readonly effective: EffectiveRecap;
  readonly view: EffectiveTranscriptReview;
  readonly campaignId: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly contentHash: string;
  readonly approval: RecapApproval;
  readonly exportedAt: string;
}

export function buildRecapPackage(input: PackageInput): RecapPackage {
  const { effective, view, revision } = input;
  const bySegment = new Map(view.segments.map((segment) => [segment.segment_id, segment]));
  const footnotes: RecapPackage['content']['footnotes'] = [];
  const sentences = effective.sentences.map((sentence) => {
    const evidence: RecapPackage['content']['footnotes'][number]['evidence'] = [
      ...sentence.citations.segment_ids.map((ref) => {
        const segment = bySegment.get(ref);
        return {
          kind: 'segment' as const,
          ref,
          ...(segment === undefined
            ? {}
            : {
                session_offset_ms: segment.start_offset_ms,
                speaker_label: segment.speaker_id,
                excerpt: excerptOf(segment.text),
              }),
        };
      }),
      ...sentence.citations.event_ids.map((ref) => ({ kind: 'event' as const, ref })),
    ];
    if (evidence.length === 0) {
      return { sentence_id: sentence.sentence_id, text: sentence.text, footnote_ids: [] };
    }
    const footnoteId = `r${String(revision)}:f${String(footnotes.length)}`;
    footnotes.push({ footnote_id: footnoteId, evidence });
    return {
      sentence_id: sentence.sentence_id,
      text: sentence.text,
      footnote_ids: [footnoteId],
    };
  });
  return {
    schema_version: 1,
    package_kind: 'sargas-recap',
    campaign_id: input.campaignId,
    session_id: input.sessionId,
    recap_revision: revision,
    content_hash: input.contentHash,
    approval: {
      approved_content_hash: input.approval.content_hash,
      approved_at: input.approval.approved_at,
    },
    exported_at: input.exportedAt,
    generator: { name: 'sargas-recap', version: EXPORT_GENERATOR_VERSION },
    content: {
      language: effective.language,
      title: effective.title,
      sentences,
      footnotes,
    },
  };
}
