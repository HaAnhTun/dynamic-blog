import 'server-only'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * The cookie holding a GitHub sign-in in progress, from `start` to `callback`.
 *
 * Value: `<base64url(returnTo)>.<blob>`. `blob` is the `oauth2_auth_request` the backend signs with HMAC;
 * Next never forwards the backend's `Set-Cookie` as is to the browser, it repackages it
 * into its own cookie. `returnTo` is NOT signed, so the callback sanitizes it again.
 *
 * One slot per browser: a second sign-in in another tab overwrites the first.
 *
 * - production: `__Host-oauth_flow`, Secure, Path=/ (`__Host-` demands both and forbids Domain), so
 *   a sibling subdomain cannot plant its blob here. Chrome accepts Secure and `__Host-`
 *   on http://localhost, so QA running `next start` (production) on :3100 can still sign in.
 * - development: `oauth_flow`, narrow Path at /api/auth/github.
 *
 * SameSite=Lax rather than Strict: the callback is a top-level navigation GET from github.com, and Strict
 * would not send the cookie with it.
 */

export const OAUTH_FLOW_MAX_AGE = 600

/** The backend's blob: base64url(JSON) "." base64url(HMAC). About 1–1.5 KB. */
const BLOB = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
const PART = /^[A-Za-z0-9_-]+$/
const MAX_BLOB_LENGTH = 3_000
/**
 * A browser keeps at most about 4096 bytes for the name + value of one cookie and silently drops a larger
 * cookie: the callback then sees "no cookie" and reports `state`. 3800 leaves room for the name
 * `__Host-oauth_flow`.
 */
const MAX_VALUE_LENGTH = 3_800

type FlowCookieOptions = {
  httpOnly: true
  sameSite: 'lax'
  secure: boolean
  path: string
  maxAge: number
}

/** Reads NODE_ENV at call time (same reason as lib/auth-cookies.ts). */
function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

export function oauthFlowCookieName(): string {
  return isProduction() ? '__Host-oauth_flow' : 'oauth_flow'
}

export function oauthFlowCookieOptions(): FlowCookieOptions {
  const production = isProduction()
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: production,
    path: production ? '/' : '/api/auth/github',
    maxAge: OAUTH_FLOW_MAX_AGE,
  }
}

/** Same Path as the set: with a different Path the browser treats it as another cookie and does not delete. */
export function clearedOauthFlowCookieOptions(): FlowCookieOptions {
  return { ...oauthFlowCookieOptions(), maxAge: 0 }
}

export function isAuthRequestBlob(value: string): boolean {
  return value.length <= MAX_BLOB_LENGTH && BLOB.test(value)
}

export function encodeOauthFlow(returnTo: string, blob: string): string {
  return `${Buffer.from(returnTo, 'utf8').toString('base64url')}.${blob}`
}

/** Null for every broken value: missing, malformed, or abnormally long. */
export function decodeOauthFlow(value: string | undefined): { returnTo: string; blob: string } | null {
  if (!value || value.length > MAX_VALUE_LENGTH) return null
  const dot = value.indexOf('.')
  if (dot === -1) return null
  const head = value.slice(0, dot)
  const blob = value.slice(dot + 1)
  if (!PART.test(head) || !BLOB.test(blob)) return null
  return { returnTo: Buffer.from(head, 'base64url').toString('utf8'), blob }
}

export function readOauthFlowCookie(request: NextRequest): { returnTo: string; blob: string } | null {
  return decodeOauthFlow(request.cookies.get(oauthFlowCookieName())?.value)
}

/**
 * `safeReturnTo` limits the INPUT to 512 characters, but the output is percent-encoded: a long
 * Vietnamese query can grow several times over. If it does not fit the cookie, drop the return target and keep the sign-in.
 */
export function setOauthFlowCookie(response: NextResponse, returnTo: string, blob: string): void {
  const value = encodeOauthFlow(returnTo, blob)
  const fitted = value.length <= MAX_VALUE_LENGTH ? value : encodeOauthFlow('/', blob)
  response.cookies.set(oauthFlowCookieName(), fitted, oauthFlowCookieOptions())
}

export function clearOauthFlowCookie(response: NextResponse): void {
  response.cookies.set(oauthFlowCookieName(), '', clearedOauthFlowCookieOptions())
}

/**
 * The 303 of every OAuth response. A destination within the site is a RELATIVE Location (like app/random/route.ts):
 * building an absolute URL from the Host behind a reverse proxy can point at the wrong origin. Not cached, and
 * `Referrer-Policy: no-referrer` so a URL carrying code/state does not travel in the Referer.
 */
export function oauthRedirect(location: string): NextResponse {
  return new NextResponse(null, {
    status: 303,
    headers: { location, 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer' },
  })
}
