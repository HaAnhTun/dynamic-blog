import type { NextResponse } from 'next/server'

/**
 * The names of the two session cookies. In production they carry the `__Host-` prefix (audit 031): the browser then accepts them
 * only from a secure origin, with `Path=/` and no `Domain`, which is exactly what they are set with, so a sibling subdomain (or a
 * network attacker on plain HTTP) cannot plant a cookie of that name to be read before ours (session fixation into the attacker's
 * account). Outside production they are plain, because the prefix demands `Secure` and development runs on plain HTTP.
 *
 * Two functions rather than constants on purpose: a constant would have been the dev name in every test and the wrong one in
 * production. The name is read at call time, like `secure`. Every reader and writer of the cookies goes through them.
 */
const ACCESS_BASE = 'access_token'
const REFRESH_BASE = 'refresh_token'
const HOST_PREFIX = '__Host-'

/**
 * The names the cookies had before the prefix (the same on a development run). A production browser may still hold them from an
 * older release: they are never read, since a cookie of that name can be planted, and every response that sets or clears the
 * session deletes them (`clearLegacySessionCookies`). So nobody is left with a stale pair, and signing in again is all an upgrade
 * costs (docs/UPGRADING.md).
 */
const LEGACY_NAMES = [ACCESS_BASE, REFRESH_BASE] as const

/** Read at call time, not at module load (see `base`). */
function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

export function accessCookieName(): string {
  return isProduction() ? `${HOST_PREFIX}${ACCESS_BASE}` : ACCESS_BASE
}

export function refreshCookieName(): string {
  return isProduction() ? `${HOST_PREFIX}${REFRESH_BASE}` : REFRESH_BASE
}
/**
 * The single-use challenge of a sign-in that still needs its second step (`202` from the backend). It is not a session: it
 * only lets `/admin/login/mfa/*` and `/admin/login/enroll/*` hand the challenge back with a code.
 */
export const MFA_CHALLENGE_COOKIE = 'mfa_challenge'

/**
 * Seconds. The longest a refresh cookie lives, and the lifetime used when the backend does not say (a reader's refresh token, which
 * is the longest the backend issues). The backend states the real life of each refresh token (`refreshExpiresIn`: an ADMIN or
 * AUTHOR session is shorter), and the cookie follows it, so the cookie ends when the backend would refuse the token. The access
 * cookie is a session cookie.
 */
const REFRESH_MAX_AGE = 30 * 24 * 60 * 60

/** Seconds. The backend's challenge lives 5 minutes by default (`app.mfa.challenge-ttl`); a longer setting is cut by this. */
const MFA_CHALLENGE_MAX_AGE = 5 * 60

/** The only part of the site that reads the challenge cookie: the sign-in pages and their route handlers. */
const MFA_CHALLENGE_PATH = '/admin/login'

type CookieOptions = {
  httpOnly: true
  sameSite: 'lax'
  secure: boolean
  path: string
  maxAge?: number
}

/**
 * One place decides `secure`, because the cost of getting it wrong is different in each
 * direction: `secure` in development silently breaks login on http://localhost with no
 * error anywhere, and missing it in production exposes the session to any network
 * observer while behaving perfectly in every test.
 *
 * Read `process.env.NODE_ENV` at call time, not at module load: Next inlines it at build
 * time in client bundles, and a value captured in a module constant cannot be stubbed in
 * a test, which would make the two-direction assertion in route.test.ts impossible.
 */
function base(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction(),
    path: '/',
  }
}

/**
 * No maxAge: a session cookie. The access token is worthless after 15 minutes and
 * middleware replaces it, so there is nothing to gain from persisting it to disk.
 */
export function accessCookieOptions(): CookieOptions {
  return base()
}

/**
 * `lifetimeSeconds` is the `refreshExpiresIn` of the backend's answer. Missing, not a number or not above zero: the maximum
 * (an older backend, or an answer off the contract: the cookie then outlives a shorter session, and the backend refuses the
 * token when it comes back). Never above the maximum: a cookie must not outlive the longest session the backend issues.
 */
export function refreshCookieOptions(lifetimeSeconds?: number): CookieOptions {
  const usable = typeof lifetimeSeconds === 'number' && Number.isFinite(lifetimeSeconds) && lifetimeSeconds > 0
  return { ...base(), maxAge: usable ? Math.min(Math.floor(lifetimeSeconds), REFRESH_MAX_AGE) : REFRESH_MAX_AGE }
}

/** maxAge 0 is what deletes a cookie; an empty value alone leaves it live. */
export function clearedCookieOptions(): CookieOptions {
  return { ...base(), maxAge: 0 }
}

/**
 * The challenge cookie: httpOnly, Lax, five minutes, and `Path=/admin/login` so that it travels with no other request.
 *
 * Trade-off, recorded for the `__Host-` prefix work (docs/SECURITY.md): that prefix requires `Path=/`, so this cookie cannot carry
 * it. It is single use and bound to the account that passed the first factor, so a copy planted by a sibling host can at worst make
 * the visitor spend their code on someone else's challenge, which fails.
 */
export function mfaChallengeCookieOptions(): CookieOptions {
  return { ...base(), path: MFA_CHALLENGE_PATH, maxAge: MFA_CHALLENGE_MAX_AGE }
}

/** Same Path as the set: with a different Path the browser treats it as another cookie and does not delete. */
export function clearedMfaChallengeCookieOptions(): CookieOptions {
  return { ...mfaChallengeCookieOptions(), maxAge: 0 }
}

export function setMfaChallengeCookie(response: NextResponse, challenge: string): void {
  response.cookies.set(MFA_CHALLENGE_COOKIE, challenge, mfaChallengeCookieOptions())
}

export function clearMfaChallengeCookie(response: NextResponse): void {
  response.cookies.set(MFA_CHALLENGE_COOKIE, '', clearedMfaChallengeCookieOptions())
}

/**
 * The token pair the backend returns (`TokenResponse`, without `expiresIn`), with how many seconds the refresh token lives
 * (`refreshExpiresIn`) when the backend said.
 */
export type SessionTokens = { accessToken: string; refreshToken: string; refreshExpiresIn?: number }

/**
 * The pair in the `data` of a backend answer that carries one (a sign-in, a refresh, a password change...), or null when either
 * token is missing or empty. One reader for every route that puts a pair in the cookies.
 */
export function readSessionTokens(data: unknown): SessionTokens | null {
  if (typeof data !== 'object' || data === null) return null
  const { accessToken, refreshToken, refreshExpiresIn } = data as Record<string, unknown>
  if (typeof accessToken !== 'string' || !accessToken || typeof refreshToken !== 'string' || !refreshToken) return null
  return typeof refreshExpiresIn === 'number' ? { accessToken, refreshToken, refreshExpiresIn } : { accessToken, refreshToken }
}

/** Sets both session cookies. The two cookies always go together: the refresh token rotates on every use. */
export function setSessionCookies(response: NextResponse, tokens: SessionTokens): void {
  response.cookies.set(accessCookieName(), tokens.accessToken, accessCookieOptions())
  response.cookies.set(refreshCookieName(), tokens.refreshToken, refreshCookieOptions(tokens.refreshExpiresIn))
  clearLegacySessionCookies(response)
}

export function clearSessionCookies(response: NextResponse): void {
  response.cookies.set(accessCookieName(), '', clearedCookieOptions())
  response.cookies.set(refreshCookieName(), '', clearedCookieOptions())
  clearLegacySessionCookies(response)
}

/**
 * Deletes the session cookies of the releases before the `__Host-` prefix, in production only (elsewhere the legacy names are the
 * names). Same attributes as they were set with, or the browser treats the deletion as another cookie.
 */
export function clearLegacySessionCookies(response: NextResponse): void {
  if (!isProduction()) return
  for (const name of LEGACY_NAMES) response.cookies.set(name, '', clearedCookieOptions())
}

/**
 * A cookie of the request, for handlers that receive a plain `Request` (not a NextRequest). Percent-decodes
 * like Next's `request.cookies`; an empty value counts as absent.
 */
export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie')
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue
    const raw = part.slice(eq + 1).trim()
    let value = raw
    try {
      value = decodeURIComponent(raw)
    } catch {
      // Keep the raw string when it is not valid percent-encoding.
    }
    return value === '' ? undefined : value
  }
  return undefined
}
