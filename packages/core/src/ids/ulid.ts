/**
 * ULID generators (ADR-004): 48-bit Unix millisecond time + 80 random bits, Crockford base32,
 * 26 characters. The one ULID implementation in core:
 *
 * - {@link newUlid}: a single ID (e.g. `package_id`, one per import). Randomness is injectable for
 *   tests.
 * - {@link monotonicUlid} / {@link ulid}: monotonic within one process. IDs created in the same
 *   millisecond (or after the clock stepped back) increment the random part, so they still sort in
 *   creation order (run IDs).
 */
import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const MAX_TIME = 2 ** 48 - 1;

export const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

function checkTime(ms: number): void {
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > MAX_TIME) {
    throw new RangeError('ULID time must be an integer between 0 and 2^48-1 milliseconds');
  }
}

function encodeTime(ms: number): string {
  let out = '';
  let rest = ms;
  for (let i = 0; i < TIME_LEN; i += 1) {
    out = (ALPHABET[rest % 32] ?? '0') + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

/** One ULID. `random` is the 80-bit random part as 10 bytes (big-endian). */
export function newUlid(now: number = Date.now(), random: Uint8Array = randomBytes(10)): string {
  checkTime(now);
  if (random.length !== 10) throw new RangeError('ULID randomness must be 10 bytes');
  let bits = 0n;
  for (const byte of random) bits = (bits << 8n) | BigInt(byte);
  let rand = '';
  for (let i = 0; i < RANDOM_LEN; i += 1) {
    rand = (ALPHABET[Number(bits & 31n)] ?? '0') + rand;
    bits >>= 5n;
  }
  return encodeTime(now) + rand;
}

/** 16 base32 digits (80 bits) as an array of values 0..31. */
function randomDigits(): number[] {
  return [...randomBytes(RANDOM_LEN)].map((b) => b & 31);
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
    checkTime(now);
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
