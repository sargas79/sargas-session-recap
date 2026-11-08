/**
 * Canonical JSON and content hashes for config values.
 *
 * Canonical form: object keys sorted by UTF-16 code unit, no whitespace, `undefined` properties
 * dropped, arrays in order. Only JSON values are accepted (no NaN/Infinity, no functions, no
 * non-plain objects), so the same logical config always yields the same hash regardless of YAML
 * formatting, comments or key order.
 */
import { createHash } from 'node:crypto';

export type Sha256 = `sha256:${string}`;

function canonical(value: unknown, depth: number): string {
  if (depth > 64) throw new TypeError('canonical JSON: value nested too deeply');
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonical JSON: non-finite number');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((v: unknown) => canonical(v, depth + 1)).join(',')}]`;
      }
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError('canonical JSON: only plain objects are supported');
      }
      const obj = value as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of Object.keys(obj).sort()) {
        const v = obj[key];
        if (v === undefined) continue;
        parts.push(`${JSON.stringify(key)}:${canonical(v, depth + 1)}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      throw new TypeError(`canonical JSON: unsupported ${typeof value}`);
  }
}

export function canonicalJson(value: unknown): string {
  return canonical(value, 0);
}

/** `sha256:<64 lowercase hex>` of the canonical JSON (UTF-8) of `value`. */
export function contentHash(value: unknown): Sha256 {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}
