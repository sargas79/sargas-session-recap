/**
 * Exact decimal-string arithmetic for ffmpeg/ffprobe timestamps.
 *
 * ffmpeg prints times as decimal strings such as `2.500000`, `1.00002` or, via
 * `%.6g`, `2.08333e-05`. Converting them through binary floating point can make
 * results depend on rounding quirks, so they are parsed as exact decimals with
 * BigInt and rounded once, half away from zero, to an integer unit.
 */

const DECIMAL_RE =
  /^([-+])?(\d+)(?:\.(\d*))?(?:[eE]([-+]?\d+))?$|^([-+])?\.(\d+)(?:[eE]([-+]?\d+))?$/;

interface ExactDecimal {
  /** Signed integer mantissa. */
  readonly digits: bigint;
  /** Value = digits * 10^-scale. May be negative (meaning a multiplier). */
  readonly scale: number;
}

function parseExactDecimal(text: string): ExactDecimal | undefined {
  const match = DECIMAL_RE.exec(text.trim());
  if (match === null) {
    return undefined;
  }
  const sign = match[1] ?? match[5];
  const intPart = match[2] ?? '0';
  const fracPart = match[3] ?? match[6] ?? '';
  const expPart = match[4] ?? match[7] ?? '0';
  const exponent = Number.parseInt(expPart, 10);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) {
    return undefined;
  }
  const magnitude = BigInt(`${intPart}${fracPart}`);
  return {
    digits: sign === '-' ? -magnitude : magnitude,
    scale: fracPart.length - exponent,
  };
}

/** Divides with rounding half away from zero. `divisor` must be positive. */
export function divRound(numerator: bigint, divisor: bigint): bigint {
  // BigInt division truncates toward zero; step away from zero when the
  // remainder is at least half the divisor.
  const quotient = numerator / divisor;
  const remainder = numerator % divisor;
  const twice = (remainder < 0n ? -remainder : remainder) * 2n;
  if (twice >= divisor) {
    return numerator >= 0n ? quotient + 1n : quotient - 1n;
  }
  return quotient;
}

/**
 * Converts a decimal string to `round(value * multiplier)` as a bigint, or
 * `undefined` if the text is not a decimal number.
 */
export function scaleDecimal(text: string, multiplier: bigint): bigint | undefined {
  const parsed = parseExactDecimal(text);
  if (parsed === undefined) {
    return undefined;
  }
  const product = parsed.digits * multiplier;
  if (parsed.scale <= 0) {
    return product * 10n ** BigInt(-parsed.scale);
  }
  return divRound(product, 10n ** BigInt(parsed.scale));
}

/** Seconds as a decimal string -> integer milliseconds (rounded). */
export function secondsToMs(text: string): number | undefined {
  const value = scaleDecimal(text, 1000n);
  return value === undefined ? undefined : toSafeNumber(value);
}

export function toSafeNumber(value: bigint): number | undefined {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    return undefined;
  }
  return Number(value);
}
