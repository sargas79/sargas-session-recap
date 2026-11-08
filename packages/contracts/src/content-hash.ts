/**
 * Recap content hash (ADR-010). One implementation for core (T15 approval and export) and the
 * Foundry module (T19 import), so both sides compute the same `sha256:` value.
 *
 * What is hashed: the player-facing content only, i.e. the title, the language and, in order, every
 * player-facing sentence with its ID, text and citations. GM notes, assertions, outcome bases,
 * timestamps, run IDs, revision, reviewer and editorial state are not hashed.
 *
 * How: build the canonical content object, serialize it with the RFC 8785 (JCS) subset implemented
 * by `canonicalJson`, take the UTF-8 bytes and hash them with SHA-256 (pure JS, see sha256.ts).
 *
 * Browser-safe and synchronous: no Node built-ins, no WebCrypto.
 */
import type { RecapPackage } from './schemas/recap-package.ts';
import { sha256Utf8 } from './sha256.ts';

/** Version of the canonical form. Part of the hashed object; bumped on any change to ADR-010. */
export const CONTENT_HASH_VERSION = 1 as const;

/**
 * The fields the hash covers. A `Recap` (draft) is assignable to this type; T15 passes the
 * effective content (draft + SQLite edits) and T19 derives it with `recapContentFromPackage`.
 * Extra properties on the argument (GM notes, assertions, ...) are ignored.
 */
export interface RecapContentInput {
  readonly language: string;
  readonly title: string;
  readonly sentences: readonly {
    readonly sentence_id: string;
    readonly text: string;
    readonly citations: {
      readonly segment_ids: readonly string[];
      readonly event_ids: readonly string[];
    };
  }[];
}

/** The object that is serialized and hashed. Key order here is irrelevant: JCS sorts keys. */
export interface CanonicalContent {
  content_hash_version: typeof CONTENT_HASH_VERSION;
  language: string;
  title: string;
  sentences: {
    sentence_id: string;
    text: string;
    citations: { segment_ids: string[]; event_ids: string[] };
  }[];
}

/** Citation IDs are a set: NFC-normalized, deduplicated, sorted by UTF-16 code units. */
function citationSet(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.normalize('NFC')))].sort(compareCodeUnits);
}

function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * Project a recap (or any `RecapContentInput`) onto exactly the hashed fields. Only the listed
 * properties are copied, so GM notes and other extra properties can never leak into the hash.
 * Sentence order is kept: it is part of the content.
 */
export function canonicalContentObject(content: RecapContentInput): CanonicalContent {
  return {
    content_hash_version: CONTENT_HASH_VERSION,
    language: content.language,
    title: content.title,
    sentences: content.sentences.map((s) => ({
      sentence_id: s.sentence_id,
      text: s.text,
      citations: {
        segment_ids: citationSet(s.citations.segment_ids),
        event_ids: citationSet(s.citations.event_ids),
      },
    })),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function canonicalString(value: string): string {
  // Lone surrogates are not valid Unicode (RFC 8785 section 3.2.2.2 requires valid input).
  for (const char of value) {
    const cp = char.codePointAt(0) ?? 0;
    if (cp >= 0xd800 && cp <= 0xdfff) {
      throw new RangeError('canonical JSON: string contains a lone surrogate');
    }
  }
  // For well-formed strings, JSON.stringify escapes exactly as RFC 8785 requires: `"` and `\` as
  // \" and \\, U+0008/09/0A/0C/0D as \b \t \n \f \r, other U+0000..U+001F as \u00xx (lowercase
  // hex), and every other code point literally (including non-ASCII, U+007F, U+2028, U+2029).
  return JSON.stringify(value.normalize('NFC'));
}

/**
 * RFC 8785 (JCS) serialization of the JSON subset used by ADR-010: plain objects, arrays, strings
 * and safe integers. Strings (values and keys) are NFC-normalized first. Object keys are sorted by
 * UTF-16 code units, arrays keep their order, there is no whitespace. Throws `TypeError` on
 * anything else (floats, booleans, null, undefined, non-plain objects) and `RangeError` on lone
 * surrogates, unsafe integers or keys that collide after normalization: the content contracts never
 * contain them, so their presence is a bug, not something to encode.
 */
export function canonicalJson(value: unknown): string {
  if (typeof value === 'string') return canonicalString(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError('canonical JSON: only safe integers are allowed (ADR-003, ADR-010)');
    }
    // Integers in the safe range print as plain decimal digits, as RFC 8785 (ECMAScript) does.
    // -0 prints as 0.
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (isPlainObject(value)) {
    const entries = new Map<string, unknown>();
    for (const [key, item] of Object.entries(value)) {
      const nfcKey = key.normalize('NFC');
      if (entries.has(nfcKey)) {
        throw new RangeError('canonical JSON: two keys are equal after NFC normalization');
      }
      entries.set(nfcKey, item);
    }
    const keys = [...entries.keys()].sort(compareCodeUnits);
    return `{${keys.map((k) => `${canonicalString(k)}:${canonicalJson(entries.get(k))}`).join(',')}}`;
  }
  throw new TypeError(
    `canonical JSON: unsupported value of type ${value === null ? 'null' : typeof value}`,
  );
}

/** Canonical JSON text of the hashed content (what `canonicalContentHash` hashes). */
export function canonicalContentJson(content: RecapContentInput): string {
  return canonicalJson(canonicalContentObject(content));
}

/**
 * `sha256:<64 lowercase hex>` of the canonical content (ADR-010). Accepts a recap draft, the
 * effective content of a revision or `recapContentFromPackage(pkg.content)`.
 */
export function canonicalContentHash(content: RecapContentInput): string {
  return sha256Utf8(canonicalContentJson(content));
}

/**
 * Rebuild the hashed content from an exported package's `content` (T19 importer): each sentence's
 * citations are the union of the evidence refs of its footnotes, split by `kind`. Throws if a
 * sentence references a footnote that is not in the package. Footnote IDs, footnote order,
 * evidence order and evidence context (offset, speaker label, excerpt) are not part of the hash.
 */
export function recapContentFromPackage(content: RecapPackage['content']): RecapContentInput {
  const footnotes = new Map(content.footnotes.map((f) => [f.footnote_id, f]));
  return {
    language: content.language,
    title: content.title,
    sentences: content.sentences.map((s) => {
      const segmentIds: string[] = [];
      const eventIds: string[] = [];
      for (const footnoteId of s.footnote_ids) {
        const footnote = footnotes.get(footnoteId);
        if (footnote === undefined) {
          throw new RangeError('recap package: a sentence references a missing footnote');
        }
        for (const evidence of footnote.evidence) {
          (evidence.kind === 'segment' ? segmentIds : eventIds).push(evidence.ref);
        }
      }
      return {
        sentence_id: s.sentence_id,
        text: s.text,
        citations: { segment_ids: segmentIds, event_ids: eventIds },
      };
    }),
  };
}
