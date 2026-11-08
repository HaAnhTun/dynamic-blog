import 'server-only'
import { NextResponse, type NextRequest } from 'next/server'
import { accessCookieName, refreshCookieName, clearSessionCookies, setSessionCookies, type SessionTokens } from './auth-cookies'
import { clientIp, clientIpHeaders } from './client-ip'
import { isExpiringWithin } from './jwt'
import { refreshSession } from './session-refresh'
import { apiBaseUrl } from '@/lib/api-base-url'

/**
 * The BFF layer for the reader's route handlers: reads the session from the cookie,
 * refreshes when needed, calls the backend with a Bearer, and returns the backend's status and JSON envelope as is.
 *
 * Tokens live only in the HttpOnly cookie and in the header sent to the backend; never in the response
 * body. Every response carries `cache-control: private, no-store`.
 *
 * The most important cookie rule here: when a refresh succeeds the new pair MUST be set on the
 * final response, whatever that response is (even a 502). The backend revoked the old token the moment it rotated;
 * letting the browser keep the old token signs the reader out on the next request.
 */

export type Auth = 'optional' | 'required'
export type ApiInit = {
  method: string
  body?: string
  /**
   * The visitor's address (`clientIp(request)`, `null` when unknown), for the backend's per-address limits. Absent means the
   * call has no such limit and the headers are not sent. The visitor can never choose it: see `clientIpHeaders`.
   */
  clientIp?: string | null
}

export const PRIVATE_NO_STORE = 'private, no-store'

/**
 * Seconds. The same margin as proxy.ts: a token that passes this check must still be alive through the trip to the
 * backend.
 */
const EXPIRY_MARGIN_SECONDS = 30
const TIMEOUT_MS = 10_000

/** The session of one request, after reading the cookie (and refreshing if needed). */
export type SessionState = {
  /** The token sent with the Bearer, or null when going as an anonymous visitor. */
  accessToken: string | null
  /** The refresh token not yet used in this request: one refresh attempt is still allowed. */
  refreshToken: string | null
  /** The visitor's address (lib/client-ip.ts), forwarded with a refresh for the backend's per-address limit. */
  clientIp: string | null
  /** The new pair to set on the final response. */
  rotated: SessionTokens | null
  /** A really dead session (rejected): clear both cookies. */
  clear: boolean
  /** The refresh met a backend that did not answer. */
  unavailable: boolean
}

/** Read at call time, not at module load: changing the env needs no rebuild, and tests can change it. */
function apiBase(): string {
  return apiBaseUrl()
}

export function bffError(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status, headers: { 'cache-control': PRIVATE_NO_STORE } })
}

/**
 * Uses the remaining refresh token (at most once per request). The `revoked` outcome leaves the cookie alone:
 * see lib/session-refresh.ts.
 */
export async function refreshOnce(state: SessionState): Promise<void> {
  const token = state.refreshToken
  if (!token) return
  state.refreshToken = null
  const outcome = await refreshSession(token, state.clientIp)
  state.accessToken = null
  switch (outcome.kind) {
    case 'ok':
      state.accessToken = outcome.accessToken
      state.rotated = {
        accessToken: outcome.accessToken,
        refreshToken: outcome.refreshToken,
        refreshExpiresIn: outcome.refreshExpiresIn,
      }
      break
    case 'rejected':
      state.clear = true
      break
    case 'unavailable':
      state.unavailable = true
      break
    case 'revoked':
      break
  }
}

/**
 * Steps 1–2: a still valid access token is used; one missing or expiring within 30 seconds with a
 * refresh token available is refreshed.
 */
export async function readSession(request: NextRequest): Promise<SessionState> {
  const access = request.cookies.get(accessCookieName())?.value || null
  const state: SessionState = {
    accessToken: null,
    refreshToken: request.cookies.get(refreshCookieName())?.value || null,
    clientIp: clientIp(request),
    rotated: null,
    clear: false,
    unavailable: false,
  }
  if (access && !isExpiringWithin(access, EXPIRY_MARGIN_SECONDS)) {
    state.accessToken = access
    return state
  }
  await refreshOnce(state)
  return state
}

/** One backend call. Null when unreachable (network error, 10 second timeout). */
export async function callApi(path: string, init: ApiInit, accessToken: string | null): Promise<Response | null> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  if (accessToken) headers.authorization = `Bearer ${accessToken}`
  if (init.clientIp !== undefined) Object.assign(headers, clientIpHeaders(init.clientIp))
  try {
    return await fetch(`${apiBase()}${path}`, {
      method: init.method,
      headers,
      body: init.body,
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    return null
  }
}

/** Sets the session cookie (if changed) and `cache-control` on the final response. */
export function finishResponse(response: NextResponse, state: SessionState): NextResponse {
  response.headers.set('cache-control', PRIVATE_NO_STORE)
  if (state.rotated) setSessionCookies(response, state.rotated)
  else if (state.clear) clearSessionCookies(response)
  return response
}

export function unreachable(): NextResponse {
  return bffError(502, 'UPSTREAM_UNAVAILABLE', 'The API is unreachable')
}

function unauthenticated(): NextResponse {
  return bffError(401, 'UNAUTHENTICATED', 'Authentication required')
}

/**
 * Returns the backend's status and JSON envelope as is. A body that is not JSON (an HTML error page from a
 * proxy, say) must never be passed through to the browser.
 */
async function passThrough(res: Response): Promise<NextResponse> {
  if (res.status === 204 || res.status === 205 || res.status === 304) {
    await res.body?.cancel()
    return new NextResponse(null, { status: res.status })
  }
  if (!/\bjson\b/i.test(res.headers.get('content-type') ?? '')) {
    await res.body?.cancel()
    return res.status >= 500 || res.ok
      ? bffError(502, 'UPSTREAM_UNAVAILABLE', `The API answered ${res.status} without JSON`)
      : bffError(res.status, 'UPSTREAM_ERROR', `The API answered ${res.status} without JSON`)
  }
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Forwards a reader's request to the backend (steps 1–6).
 *
 * - `optional`: with no usable session it goes as an anonymous visitor. A GET carrying a Bearer that the backend answers with 401
 *   is retried once without the Bearer (the reader still sees the comments).
 * - `required`: with no session gives 401 UNAUTHENTICATED without calling the backend (a refresh meeting a
 *   dead backend gives 502). A backend 401 while the refresh token is unused refreshes once and resends
 *   once: that 401 comes from the Bearer filter, the controller has not run, so resending is safe.
 *
 * `path` is the already built backend path (the caller checks parameters and `encodeURIComponent`s).
 */
export async function forwardToApi(request: NextRequest, path: string, init: ApiInit, auth: Auth): Promise<NextResponse> {
  const state = await readSession(request)

  if (auth === 'required' && !state.accessToken) {
    return finishResponse(state.unavailable ? unreachable() : unauthenticated(), state)
  }

  let res = await callApi(path, init, state.accessToken)

  if (res?.status === 401 && state.accessToken) {
    if (auth === 'optional' && init.method === 'GET') {
      await res.body?.cancel()
      res = await callApi(path, init, null)
    } else if (auth === 'required' && state.refreshToken) {
      await res.body?.cancel()
      await refreshOnce(state)
      if (!state.accessToken) {
        return finishResponse(state.unavailable ? unreachable() : unauthenticated(), state)
      }
      res = await callApi(path, init, state.accessToken)
    }
  }

  if (res === null) return finishResponse(unreachable(), state)
  return finishResponse(await passThrough(res), state)
}
