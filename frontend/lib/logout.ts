import 'server-only'
import { NextResponse } from 'next/server'
import { refreshCookieName, clearMfaChallengeCookie, clearSessionCookies, readCookie } from './auth-cookies'
import { assertSameOriginRequest } from './same-origin'
import { apiBaseUrl } from '@/lib/api-base-url'

/**
 * Sign-out, shared by /admin/logout and /api/auth/logout, and revoking the
 * old refresh token when a login overwrites an existing session (/admin/login/submit, the GitHub callback; those two only
 * need the WARN that revokeRefreshToken writes when it fails).
 */

const REVOKE_TIMEOUT_MS = 3_000

/** Read at call time, not at module load: changing env needs no rebuild, and tests can change it. */
function apiBase(): string {
  return apiBaseUrl()
}

/**
 * What happened to the refresh token at the backend:
 *   - `revoked`:      the backend ended it (204).
 *   - `already-dead`: it was not alive any more (401: expired, revoked, never issued). Nothing left to end.
 *   - `failed`:       the backend could not be asked, or refused for another reason. The token stays valid until it expires.
 */
export type RevokeResult = 'revoked' | 'already-dead' | 'failed'

/** No answer at all (network error, timeout): the status of an attempt that got none. */
const NO_ANSWER = 0

/** One attempt: the status the backend answered, or {@link NO_ANSWER}. */
async function attemptRevoke(token: string): Promise<number> {
  try {
    const res = await fetch(`${apiBase()}/api/v1/auth/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: token }),
      cache: 'no-store',
      signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
    })
    // Only the status is needed: release the connection.
    await res.body?.cancel()
    return res.status
  } catch {
    return NO_ANSWER
  }
}

/** A backend that is restarting or busy: worth one more try. A definitive answer (204, 401, another 4xx) is not. */
function worthRetrying(status: number): boolean {
  return status === NO_ANSWER || status >= 500 || status === 408 || status === 429
}

/**
 * Revoke in the backend so the token dies everywhere, not only in this browser. It never throws and never keeps the caller
 * from ending the browser session: the user already clicked sign out (or just signed in again), so the cookies are cleared
 * whatever this returns. But it says what happened (audit 038): a revocation that failed leaves the token valid until it
 * expires, and the caller can tell the person.
 *
 * One more attempt after a network error, a timeout or a 5xx (a backend that is restarting, Argon2 slots busy for the sign-in
 * routes). When it still fails one WARN line says so, with the status and nothing of the token.
 */
export async function revokeRefreshToken(token: string): Promise<RevokeResult> {
  let status = await attemptRevoke(token)
  if (worthRetrying(status)) status = await attemptRevoke(token)

  if (status >= 200 && status < 300) return 'revoked'
  if (status === 401) return 'already-dead'
  console.warn(`[auth] refresh token revoke failed at sign-out, ${status === NO_ANSWER ? 'no answer' : `status=${status}`}`)
  return 'failed'
}

export type LogoutOptions = {
  /**
   * `'ok-json'` is the 200 `{ ok: true, revoked }` response of /admin/logout (`revoked` is false when the backend could not end
   * the session, which stays valid until it expires); default 204.
   */
  success?: 'no-content' | 'ok-json'
  /**
   * Requires `content-type: application/json` (reader sign-out goes through the full same-origin and
   * JSON layers, like every other write route). On by default. Only /admin/logout turns it off: the admin sign-out button
   * has always sent a bare POST (from before the JSON layer was added), and that route keeps its behavior.
   */
  requireJson?: boolean
}

/**
 * Checks same origin, revokes the refresh token, then clears both cookies.
 *
 * `SameSite=Lax` already does not send cookies on a cross-site POST; the layers here are the second layer, because Lax has an
 * exception for top-level navigation, and a forged `<form method="post">` is exactly that. The JSON layer blocks
 * exactly that kind of form too (a form can only send urlencoded, multipart or text/plain) in browsers
 * that send neither `Sec-Fetch-Site` nor `Origin`. The consequence of one forgery is only being signed out, so the
 * admin route can drop the JSON layer.
 */
export async function logoutResponse(
  request: Request,
  { success = 'no-content', requireJson = true }: LogoutOptions = {},
): Promise<NextResponse> {
  const refusal = assertSameOriginRequest(request, { requireJson })
  if (refusal) return new NextResponse(refusal.body, refusal)

  const refreshToken = readCookie(request, refreshCookieName())
  // No cookie, nothing to end. Whatever the backend says, the cookies below are cleared: the browser session must end.
  const revoked = refreshToken ? (await revokeRefreshToken(refreshToken)) !== 'failed' : true

  const response = success === 'ok-json' ? NextResponse.json({ ok: true, revoked }) : new NextResponse(null, { status: 204 })
  response.headers.set('cache-control', 'private, no-store')
  clearSessionCookies(response)
  // A sign-in left half done (the password typed, the code not) ends with the session: nobody finishes it after signing out.
  clearMfaChallengeCookie(response)
  return response
}
