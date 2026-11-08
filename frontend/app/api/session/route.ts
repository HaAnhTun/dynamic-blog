import { NextResponse, type NextRequest } from 'next/server'
import { refreshCookieName } from '@/lib/auth-cookies'
import type { SessionUser, UserRole } from '@/lib/types'
import {
  PRIVATE_NO_STORE,
  bffError,
  callApi,
  finishResponse,
  readSession,
  refreshOnce,
  unreachable,
  type SessionState,
} from '@/lib/user-api'

/**
 * GET /api/session: "who am I" for the client-side islands.
 *
 * Public pages never read cookies (reading makes a page dynamic and loses ISR), so the header asks here
 * after hydration. Returns `{ data: SessionUser | null }`: no id, no email, no status,
 * no token.
 *
 * - No refresh cookie: `{ data: null }` without calling the backend.
 * - The backend says 401 (even for a freshly refreshed token) or 403 USER_SUSPENDED: the session is dead, clear the cookies and
 *   `{ data: null }` — a suspended user sees themselves logged out on the next page load.
 * - The backend does not answer: 502, keep the cookies (the client treats it as a guest and asks again next time).
 */

const ROLES: readonly UserRole[] = ['ADMIN', 'AUTHOR', 'USER']

/** `CurrentUserResponse` → `SessionUser`. Null when the response breaks the contract. */
function toSessionUser(raw: unknown): SessionUser | null {
  if (raw === null || typeof raw !== 'object') return null
  const me = raw as Record<string, unknown>
  const role = ROLES.find((candidate) => candidate === me.role)
  if (typeof me.displayName !== 'string' || role === undefined || typeof me.createdAt !== 'string') return null
  return {
    displayName: me.displayName,
    githubLogin: typeof me.githubLogin === 'string' ? me.githubLogin : null,
    avatarUrl: typeof me.avatarUrl === 'string' ? me.avatarUrl : null,
    role,
    joinedAt: me.createdAt,
    canAccessAdmin: role === 'ADMIN' || role === 'AUTHOR',
  }
}

function anonymous(state: SessionState): NextResponse {
  return finishResponse(NextResponse.json({ data: null }), state)
}

/** A truly dead session: clear both cookies, even the pair just received from a refresh. */
function loggedOut(state: SessionState): NextResponse {
  state.rotated = null
  state.clear = true
  return anonymous(state)
}

async function errorCode(res: Response): Promise<string | undefined> {
  const body = (await res.json().catch(() => null)) as { error?: { code?: unknown } } | null
  return typeof body?.error?.code === 'string' ? body.error.code : undefined
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!request.cookies.get(refreshCookieName())?.value) {
    return NextResponse.json({ data: null }, { headers: { 'cache-control': PRIVATE_NO_STORE } })
  }

  const state = await readSession(request)
  if (!state.accessToken) return state.unavailable ? finishResponse(unreachable(), state) : anonymous(state)

  let res = await callApi('/api/v1/auth/me', { method: 'GET' }, state.accessToken)

  // The access token is still valid by the Next clock but the backend refuses it anyway (clock skew, signing key change): try
  // one refresh before concluding the session is dead.
  if (res?.status === 401 && state.refreshToken) {
    await res.body?.cancel()
    await refreshOnce(state)
    if (!state.accessToken) return state.unavailable ? finishResponse(unreachable(), state) : anonymous(state)
    res = await callApi('/api/v1/auth/me', { method: 'GET' }, state.accessToken)
  }

  if (res === null) return finishResponse(unreachable(), state)

  if (res.status === 401) {
    await res.body?.cancel()
    return loggedOut(state)
  }
  if (!res.ok) {
    if (res.status === 403 && (await errorCode(res)) === 'USER_SUSPENDED') return loggedOut(state)
    return finishResponse(bffError(502, 'UPSTREAM_ERROR', `The API answered ${res.status}`), state)
  }

  const body = (await res.json().catch(() => null)) as { data?: unknown } | null
  const user = toSessionUser(body?.data)
  if (user === null) return finishResponse(bffError(502, 'BAD_RESPONSE', 'Unexpected /auth/me payload'), state)
  return finishResponse(NextResponse.json({ data: user }), state)
}
