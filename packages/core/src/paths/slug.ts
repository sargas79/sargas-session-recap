import { PathsError } from './errors.ts';

/**
 * ADR-004 slug: lowercase `[a-z0-9-]`, 1-64 chars, no leading/trailing hyphen.
 *
 * Mirrors `SLUG_PATTERN` in `packages/contracts/src/common.ts` (core cannot import
 * contracts source at runtime: its package exports point at `dist/`). A test in
 * `packages/core/test/paths/` keeps the two in sync.
 */
export const SLUG_PATTERN = '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$';

const SLUG_RE = new RegExp(SLUG_PATTERN);

/**
 * Windows reserved device names. They match the slug pattern but cannot be used
 * as a directory name on Windows (`con`, `nul`, `com1`, ...), so they are refused
 * on every platform to keep data roots portable.
 */
const WINDOWS_RESERVED = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

export type SlugKind = 'campaign_id' | 'session_id';

export function isSlug(value: string): boolean {
  return SLUG_RE.test(value) && !WINDOWS_RESERVED.has(value);
}

/**
 * Throws `PATHS_INVALID_ID` unless `value` is a safe path segment. The value is
 * echoed back (JSON-quoted, truncated) because IDs are operator-chosen names, not
 * session content.
 */
export function assertSlug(kind: SlugKind, value: string): string {
  if (isSlug(value)) {
    return value;
  }
  const shown = JSON.stringify(value.length > 70 ? `${value.slice(0, 70)}...` : value);
  const reason = WINDOWS_RESERVED.has(value)
    ? 'is a reserved device name on Windows'
    : 'must match [a-z0-9-], 1-64 chars, no leading or trailing hyphen (ADR-004)';
  throw new PathsError('PATHS_INVALID_ID', `invalid ${kind} ${shown}: ${reason}`);
}
