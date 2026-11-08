import type { NextRequest, NextResponse } from 'next/server'
import {
  readSessionTokens,
  refreshCookieName,
  setMfaChallengeCookie,
  setSessionCookies,
  type SessionTokens,
} from '@/lib/auth-cookies'
import { revokeRefreshToken } from '@/lib/logout'
import { clearOauthFlowCookie, oauthRedirect, readOauthFlowCookie } from '@/lib/oauth-flow-cookie'
import { allowOAuthAttempt } from '@/lib/rate-limit'
import { loginErrorPath, mfaStepPath, safeReturnTo, type LoginError } from '@/lib/return-to'
import { apiBaseUrl } from '@/lib/api-base-url'

/**
 * GET /api/auth/github/callback?code&state: GitHub sends the reader back here.
 *
 * Next forwards the query string verbatim to the backend together with the signed blob from the
 * `oauth_flow` cookie; Spring checks the HMAC, expiry, state and replay protection, exchanges the
 * code for tokens (redirect_uri and the PKCE verifier come from the blob), reads the GitHub
 * profile, stores the user, then returns the same `TokenResponse` as a password login. Next sets
 * the two session cookies and redirects to the page the reader was viewing. Tokens never appear
 * in a URL, a redirect or page JavaScript.
 *
 * A `202` is the same sign-in gate as the password login has: the account (every administrator, an author who turned on two-step
 * verification) needs a second step first. The backend then returns a challenge and no token; Next keeps the challenge in its own
 * cookie (lib/auth-cookies.ts) and redirects to `/admin/login/mfa` or `/admin/login/enroll`, not to `/login`, which is the reader's
 * page. The session cookies exist only after a verified second factor. Of the `returnTo` only a path of the admin area survives the
 * second step (lib/return-to.ts `safeAdminNext`).
 *
 * This is a top-level cross-site GET navigation from github.com: a SameSite=Lax cookie still
 * travels with it (Strict would not), and the `sec-fetch-site: same-origin` check from
 * app/api/views/route.ts must NOT be copied here.
 *
 * Never log the query string, cookies or response bodies: they contain the code, state and tokens.
 */

const MAX_QUERY_LENGTH = 2048
const TIMEOUT_MS = 20_000

/** Read at call time, not at module load: changing the env needs no rebuild, and tests can change it. */
function apiBase(): string {
  return apiBaseUrl()
}

/** Every callback response: 303, clear the flow cookie (a blob is single-use), no-referrer. */
function finish(location: string): NextResponse {
  const response = oauthRedirect(location)
  clearOauthFlowCookie(response)
  return response
}

/**
 * Invalid or expired state. If the browser already has a session this is the Back button after a
 * successful login, or a stale tab: the reader is already logged in, so an error is just noise.
 */
function stateFailure(request: NextRequest, returnTo?: string): NextResponse {
  return finish(request.cookies.get(refreshCookieName())?.value ? '/' : loginErrorPath('state', returnTo))
}

async function readTokens(res: Response): Promise<SessionTokens | null> {
  const body = (await res.json().catch(() => null)) as { data?: unknown } | null
  return readSessionTokens(body?.data)
}

/** The challenge of a `202`, in the shape `MfaChallengeResponse` has; null when the answer carries none. */
async function readChallenge(res: Response): Promise<{ challenge: string; enroll: boolean; codeRequired: boolean } | null> {
  const body = (await res.json().catch(() => null)) as {
    data?: { challenge?: unknown; purpose?: unknown; enrollmentCodeRequired?: unknown }
  } | null
  const challenge = body?.data?.challenge
  if (typeof challenge !== 'string' || !challenge) return null
  return {
    challenge,
    enroll: body?.data?.purpose === 'ENROLL',
    codeRequired: body?.data?.enrollmentCodeRequired === true,
  }
}

/** Backend error code (GithubLoginFailureHandler) → /login page code. */
async function loginErrorFor(res: Response): Promise<LoginError> {
  const body = (await res.json().catch(() => null)) as { error?: { code?: unknown } } | null
  switch (body?.error?.code) {
    case 'OAUTH_ACCESS_DENIED':
      return 'denied'
    case 'OAUTH_STATE_INVALID':
      return 'state'
    case 'OAUTH_PROVIDER_UNAVAILABLE':
      return 'unavailable'
    case 'USER_SUSPENDED':
      return 'suspended'
    case undefined:
      // No envelope: a 5xx from an intermediate proxy means "the backend did not answer".
      return res.status >= 500 ? 'unavailable' : 'failed'
    default:
      return 'failed'
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const flow = readOauthFlowCookie(request)
  // The cookie is unsigned: the returnTo in it is sanitized again like any other input.
  const returnTo = flow === null ? undefined : safeReturnTo(flow.returnTo)

  if (!allowOAuthAttempt(request)) return finish(loginErrorPath('rate', returnTo))

  const query = request.nextUrl.search
  if (query.length > MAX_QUERY_LENGTH) return stateFailure(request, returnTo)

  if (flow === null) {
    // The reader clicked "Cancel" on GitHub after the cookie expired (or in another tab): still
    // a self-cancellation, not a session error.
    if (request.nextUrl.searchParams.get('error') === 'access_denied') return finish(loginErrorPath('denied'))
    return stateFailure(request)
  }

  let res: Response
  try {
    res = await fetch(`${apiBase()}/api/v1/auth/oauth2/callback/github${query}`, {
      headers: { cookie: `oauth2_auth_request=${flow.blob}`, accept: 'application/json' },
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    // Only the error name (TypeError, TimeoutError): never the URL, because it contains the code and state.
    console.warn(`[oauth] callback: backend did not answer (${error instanceof Error ? error.name : 'unknown error'}).`)
    return finish(loginErrorPath('unavailable', returnTo))
  }

  if (res.status === 202) {
    const pending = await readChallenge(res)
    if (pending === null) return finish(loginErrorPath('failed', returnTo))
    const response = finish(
      mfaStepPath(pending.enroll ? 'enroll' : 'mfa', { next: returnTo, codeRequired: pending.codeRequired }),
    )
    setMfaChallengeCookie(response, pending.challenge)
    return response
  }

  if (res.status !== 200) {
    const error = await loginErrorFor(res)
    return error === 'state' ? stateFailure(request, returnTo) : finish(loginErrorPath(error, returnTo))
  }

  const tokens = await readTokens(res)
  if (tokens === null) return finish(loginErrorPath('failed', returnTo))

  // Logging in over another session: revoke the old refresh token before overwriting its cookie,
  // otherwise it lives on for 30 days with no browser holding it. Best effort, at most 3 seconds.
  const previous = request.cookies.get(refreshCookieName())?.value
  if (previous && previous !== tokens.refreshToken) await revokeRefreshToken(previous)

  const response = finish(returnTo ?? '/')
  setSessionCookies(response, tokens)
  return response
}
