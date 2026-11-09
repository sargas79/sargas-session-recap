/**
 * What keeps other sites and other local users out of the review server (T14).
 *
 * Any web page the GM has open can make the browser send requests to 127.0.0.1, and a hostile
 * domain can rebind its DNS to 127.0.0.1 to read the answers. So every request must name exactly
 * our host, a state change must come from exactly our origin, and everything else needs the secret
 * of this run: it reaches the browser once through the launch URL and then lives in a SameSite
 * cookie. Forms and API calls repeat it as a CSRF token.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const BIND_HOST = '127.0.0.1';
/** Anything longer is not an override or a form from this page. */
export const MAX_BODY_BYTES = 256 * 1024;
export const TOKEN_FIELD = '_token';
export const TOKEN_HEADER = 'x-recap-token';
export const LAUNCH_PARAM = 'key';

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Compares digests, so neither the length nor the content of the token leaks through timing. */
export function tokenMatches(expected: string, given: string | undefined): boolean {
  if (given === undefined || given === '') return false;
  const digest = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest();
  return timingSafeEqual(digest(expected), digest(given));
}

export function originOf(port: number): string {
  return `http://${BIND_HOST}:${String(port)}`;
}

/** A rebinding attack arrives with the attacker's domain in `Host`. */
export function hostAllowed(host: string | undefined, port: number): boolean {
  return host === `${BIND_HOST}:${String(port)}`;
}

/** An `Origin` is present on cross-site requests; when present it must be ours. */
export function originAllowed(origin: string | undefined, port: number): boolean {
  return origin === undefined || origin === originOf(port);
}

/**
 * State changes require the `Origin` header: browsers always send it on a POST, and `null` (a
 * sandboxed frame or a redirect chain) is not ours. `Sec-Fetch-Site`, where sent, must agree.
 */
export function stateChangeAllowed(
  origin: string | undefined,
  fetchSite: string | undefined,
  port: number,
): boolean {
  if (origin !== originOf(port)) return false;
  return fetchSite === undefined || fetchSite === 'same-origin';
}

/** One name per port, so two running sessions do not overwrite each other's cookie. */
export function cookieName(port: number): string {
  return `recap_review_${String(port)}`;
}

export function sessionCookie(port: number, token: string): string {
  return `${cookieName(port)}=${token}; HttpOnly; SameSite=Strict; Path=/`;
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator !== -1 && part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return undefined;
}

/** No inline script or style is allowed at all, so injected markup could not run anyway. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};
