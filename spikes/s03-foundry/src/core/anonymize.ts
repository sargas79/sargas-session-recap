import { fnv1a32 } from "./ids.js";

/**
 * Payload anonymization for probe summaries. Goal: keep the *shape* and enum-like values a later normalizer (T17)
 * needs, never names or free text.
 * - Foundry-id-looking strings (16 alphanumerics) and id-looking object keys are replaced by `id:<fnv1a32>`.
 * - Strings are kept only under allowlisted enum keys and only if they look like slugs; otherwise `<str len=N>`.
 * - Numbers/booleans/null are kept. Arrays are truncated, depth is bounded.
 */

const FOUNDRY_ID_RE = /^[A-Za-z0-9]{16}$/;
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9\-_.:]{0,63}$/;

export const ENUM_KEYS: ReadonlySet<string> = new Set([
  "type",
  "outcome",
  "unadjustedOutcome",
  "kind",
  "action",
  "statistic",
  "slug",
  "damageType",
  "category",
  "rollMode",
  "format",
  "documentName",
  "hook",
  "status",
  "traits",
  "options",
  "domains",
]);

const MAX_DEPTH = 6;
const MAX_ARRAY = 10;
const MAX_KEYS = 60;

export function hashId(id: string): string {
  return `id:${fnv1a32(id)}`;
}

function anonymizeKey(key: string): string {
  return FOUNDRY_ID_RE.test(key) ? hashId(key) : key;
}

export function anonymize(value: unknown, parentKey = "", depth = 0): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (value === undefined) return null;
  if (typeof value === "string") {
    if (FOUNDRY_ID_RE.test(value)) return hashId(value);
    if (ENUM_KEYS.has(parentKey) && SLUG_RE.test(value)) return value;
    return `<str len=${value.length}>`;
  }
  if (typeof value !== "object") return `<${typeof value}>`;
  if (depth >= MAX_DEPTH) return "<depth>";
  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ARRAY).map((v) => anonymize(v, parentKey, depth + 1));
    if (value.length > MAX_ARRAY) head.push(`<+${value.length - MAX_ARRAY} more>`);
    return head;
  }
  const out: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [k, v] of entries.slice(0, MAX_KEYS)) {
    if (typeof v === "function") continue;
    out[anonymizeKey(k)] = anonymize(v, k, depth + 1);
  }
  if (entries.length > MAX_KEYS) out["<truncated>"] = entries.length - MAX_KEYS;
  return out;
}

/** Flattened dotted key paths of an update diff (e.g. `system.attributes.hp.value`), with id-like keys hashed. */
export function changedPaths(diff: unknown, prefix = "", depth = 0, acc: string[] = []): string[] {
  if (diff === null || typeof diff !== "object" || Array.isArray(diff) || depth >= MAX_DEPTH) {
    if (prefix) acc.push(prefix);
    return acc;
  }
  const entries = Object.entries(diff as Record<string, unknown>);
  if (entries.length === 0 && prefix) acc.push(prefix);
  for (const [k, v] of entries) {
    if (k === "_id") continue;
    changedPaths(v, prefix ? `${prefix}.${anonymizeKey(k)}` : anonymizeKey(k), depth + 1, acc);
  }
  return acc;
}

/** Safe nested getter for untyped Foundry objects. */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
