/**
 * ULID generator (ADR-004): 48-bit Unix ms timestamp + 80 random bits, Crockford base32, 26 chars.
 * Used for `package_id`. One ID per import, so no intra-millisecond monotonicity is needed.
 */
import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const MAX_TIME = 2 ** 48 - 1;

export function newUlid(now: number = Date.now(), random: Uint8Array = randomBytes(10)): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > MAX_TIME) {
    throw new RangeError('ULID time must be an integer between 0 and 2^48 - 1');
  }
  if (random.length !== 10) throw new RangeError('ULID randomness must be 10 bytes');
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i += 1) {
    time = (CROCKFORD[t % 32] ?? '0') + time;
    t = Math.floor(t / 32);
  }
  let bits = 0n;
  for (const byte of random) bits = (bits << 8n) | BigInt(byte);
  let rand = '';
  for (let i = 0; i < 16; i += 1) {
    rand = (CROCKFORD[Number(bits & 31n)] ?? '0') + rand;
    bits >>= 5n;
  }
  return time + rand;
}
