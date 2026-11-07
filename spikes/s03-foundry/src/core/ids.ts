/**
 * Event identity for the S03 spike.
 *
 * Two different identities exist on purpose:
 * - `eventId` is derived from the *source* (document id + a discriminator that every client sees identically,
 *   e.g. a ChatMessage id or `_stats.modifiedTime`). Two clients (or one client seeing a hook twice) observing the
 *   same underlying change produce the same eventId, which is what export deduplication keys on.
 * - `recordId` is the local append-only primary key: `<sessionId>#<seq>`. It is unique per page load and is what
 *   the loss measurement counts.
 */

export const MODULE_ID = "sargas-recap-spike";
/** Namespace prefix. Bump the version suffix if the id grammar changes. */
export const EVENT_NAMESPACE = `${MODULE_ID}/v1`;

const SEGMENT_MAX = 128;

/** FNV-1a 32-bit, hex. Not cryptographic: used for anonymizing ids and short content fingerprints only. */
export function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function encodeSegment(name: string, value: string | number): string {
  const s = String(value);
  if (s.length === 0) throw new Error(`event id segment "${name}" is empty`);
  if (s.length > SEGMENT_MAX) throw new Error(`event id segment "${name}" exceeds ${SEGMENT_MAX} chars`);
  // encodeURIComponent escapes ':' and '#' so segments can never forge extra separators.
  return encodeURIComponent(s);
}

export interface EventIdParts {
  /** Probe kind, e.g. "chat", "actor-hp", "combat-round". */
  kind: string;
  /** Stable source identifier, e.g. a document id or uuid (hashed before storage by callers if sensitive). */
  source: string;
  /** Value that distinguishes repeated changes to the same source and is identical on every client. */
  discriminator: string | number;
}

export function makeEventId(parts: EventIdParts): string {
  return [
    EVENT_NAMESPACE,
    encodeSegment("kind", parts.kind),
    encodeSegment("source", parts.source),
    encodeSegment("discriminator", parts.discriminator),
  ].join(":");
}

const EVENT_ID_RE = /^sargas-recap-spike\/v1:[A-Za-z0-9\-_.!~*'()%]+:[A-Za-z0-9\-_.!~*'()%]+:[A-Za-z0-9\-_.!~*'()%]+$/;

export function isNamespacedEventId(id: unknown): id is string {
  return typeof id === "string" && EVENT_ID_RE.test(id);
}

export function makeRecordId(sessionId: string, seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error("seq must be a positive integer");
  return `${sessionId}#${String(seq).padStart(9, "0")}`;
}

/** Random page-load session id. Uses crypto.randomUUID when present (browsers, Node >= 19). */
export function newSessionId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
