/**
 * ULID generator (ADR-004): 48-bit millisecond time + 80 random bits, Crockford base32, 26 chars.
 * Monotonic within one process: IDs created in the same millisecond (or after the clock stepped
 * back) increment the random part, so they still sort in creation order.
 */
import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const MAX_TIME = 2 ** 48 - 1;

export const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

function encodeTime(ms: number): string {
  let out = '';
  let rest = ms;
  for (let i = 0; i < TIME_LEN; i += 1) {
    out = (ALPHABET[rest % 32] ?? '0') + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

/** 16 base32 digits (80 bits) as an array of values 0..31. */
function randomDigits(): number[] {
  const bytes = randomBytes(RANDOM_LEN);
  return [...bytes].map((b) => b & 31);
}

/** Increments base32 digits in place; returns false on overflow. */
function increment(digits: number[]): boolean {
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const d = digits[i] ?? 0;
    if (d < 31) {
      digits[i] = d + 1;
      return true;
    }
    digits[i] = 0;
  }
  return false;
}

export type UlidFactory = (now?: number) => string;

/** A monotonic ULID factory. `now` is Unix milliseconds (defaults to `Date.now()`). */
export function monotonicUlid(): UlidFactory {
  let lastTime = -1;
  let lastRandom: number[] = [];
  return (now = Date.now()) => {
    if (!Number.isInteger(now) || now < 0 || now > MAX_TIME) {
      throw new RangeError('ULID time must be an integer between 0 and 2^48-1 milliseconds');
    }
    let time = now;
    if (time <= lastTime) {
      time = lastTime;
      const next = [...lastRandom];
      if (!increment(next)) {
        // 2^80 IDs in one millisecond: move to the next millisecond instead of wrapping.
        time = lastTime + 1;
        lastRandom = randomDigits();
      } else {
        lastRandom = next;
      }
    } else {
      lastRandom = randomDigits();
    }
    lastTime = time;
    return encodeTime(time) + lastRandom.map((d) => ALPHABET[d] ?? '0').join('');
  };
}

/** Process-wide monotonic ULID. */
export const ulid: UlidFactory = monotonicUlid();
