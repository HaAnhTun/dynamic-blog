import { getTranslations } from 'next-intl/server'
import { NextResponse } from 'next/server'
import { readCookie, readSessionTokens, refreshCookieName, setMfaChallengeCookie, setSessionCookies } from '@/lib/auth-cookies'
import { clientIp, clientIpHeaders } from '@/lib/client-ip'
import { revokeRefreshToken } from '@/lib/logout'
import { allowLoginAttempt, loginRetryAfter, resetLoginAttempts } from '@/lib/rate-limit'
import { BFF_BODY_LIMIT, payloadTooLarge, readSmallBody } from '@/lib/read-small-body'
import { assertSameOriginRequest } from '@/lib/same-origin'
import { apiBaseUrl } from '@/lib/api-base-url'

const BASE_URL = apiBaseUrl()

const PRIVATE_NO_STORE = 'private, no-store'

/**
 * Messages for LoginForm, which shows `body.error` verbatim. The backend's two "wait and retry"
 * cases do not go through its English `message`: 429 means the backend is already hashing as many
 * passwords at once as it allows, 503 means it is temporarily not serving. Values are keys of `Admin.login`.
 */
const BACKEND_WAIT: Partial<Record<number, string>> = {
  429: 'backendBusy',
  503: 'backendUnavailable',
}

type LoginBody = { email?: unknown; password?: unknown }

/**
 * The longest address (RFC 5321) and the longest password a real account can have: the policy stops at 128 characters, and 256 leaves
 * room for one set before it. A longer value cannot be anyone's credential, so it is refused here, before a body of that size is forwarded
 * and hashed. The backend bounds the same two fields (`LoginRequest`).
 */
const MAX_EMAIL = 254
const MAX_PASSWORD = 256

/**
 * This IP has used up its attempts (lib/rate-limit.ts): 429 with Retry-After, the backend is not
 * called. At least 1 second: the window may have just expired between counting and reading the time.
 */
async function tooManyAttempts(retryAfter: number): Promise<Response> {
  const t = await getTranslations('Admin.login')
  const seconds = Math.max(1, retryAfter)
  const minutes = Math.ceil(seconds / 60)
  return NextResponse.json(
    { error: t('tooManyAttempts', { minutes }) },
    { status: 429, headers: { 'retry-after': String(seconds), 'cache-control': PRIVATE_NO_STORE } },
  )
}

export async function POST(request: Request): Promise<Response> {
  // Login CSRF protection: a `<form enctype="text/plain">` on another site can send a body that
  // reads as JSON, and the response to a top-level navigation can still set a Lax cookie.
  // LoginForm always sends `application/json` from this very site.
  const refused = assertSameOriginRequest(request)
  if (refused) return refused

  // 10 attempts per 10 minutes per IP, counting both wrong and right ones, blocked here before the
  // backend spends an Argon2 hash (16 MiB, even for a non-existent email). The IP is the entry added
  // by the trusted proxy in X-Forwarded-For, not the first entry the client sets itself
  // (lib/client-ip.ts). A request refused cross-site above costs the site owner no attempt.
  const ip = clientIp(request)
  if (!allowLoginAttempt(ip)) return await tooManyAttempts(loginRetryAfter(ip))

  // At most 16 KB, like every other public BFF write: a body read whole would let an anonymous caller put its size in memory (the only
  // other cap is the proxy's, 6 MB for /admin/). The count above is already taken, as before.
  const raw = await readSmallBody(request, BFF_BODY_LIMIT)
  if (raw === null) return payloadTooLarge()

  let body: LoginBody
  try {
    body = JSON.parse(raw) as LoginBody
  } catch {
    return NextResponse.json({ error: 'Malformed request' }, { status: 400 })
  }

  if (typeof body !== 'object' || body === null || typeof body.email !== 'string' || typeof body.password !== 'string') {
    return NextResponse.json({ error: 'Email and password are required' }, { status: 400 })
  }
  if (body.email.length > MAX_EMAIL || body.password.length > MAX_PASSWORD) {
    return NextResponse.json({ error: 'Malformed request' }, { status: 400 })
  }

  let upstream: Response
  try {
    upstream = await fetch(`${BASE_URL}/api/v1/auth/login`, {
      method: 'POST',
      // The visitor's address too, for the backend's own per-address limit (a public backend URL must not be unlimited).
      headers: { 'content-type': 'application/json', ...clientIpHeaders(ip) },
      body: JSON.stringify({ email: body.email, password: body.password }),
      cache: 'no-store',
    })
  } catch {
    // Distinguished from 500 on purpose: this is "the API is not answering", which is
    // what a developer sees when they forget to start the backend.
    return NextResponse.json({ error: (await getTranslations('Admin.login'))('apiUnreachable') }, { status: 502 })
  }

  if (!upstream.ok) {
    // The backend answers a wrong password and an unknown email identically by design.
    // Pass its message through unchanged rather than writing a second copy here that
    // could drift into distinguishing them.
    const failure = (await upstream.json().catch(() => ({}))) as {
      error?: { message?: string }
    }
    // Keep 429/503 as they are instead of folding them into 502: "wait and retry" is exactly what
    // the user should do, while 502 says the API is broken.
    const wait = BACKEND_WAIT[upstream.status]
    if (wait !== undefined) {
      const message = (await getTranslations('Admin.login'))(wait)
      return NextResponse.json({ error: message }, { status: upstream.status, headers: { 'cache-control': PRIVATE_NO_STORE } })
    }
    return NextResponse.json(
      { error: failure.error?.message ?? (await getTranslations('Admin.login'))('failed') },
      { status: upstream.status === 401 ? 401 : 502 },
    )
  }

  const payload = (await upstream.json()) as {
    data?: {
      accessToken?: string
      refreshToken?: string
      refreshExpiresIn?: number
      challenge?: string
      purpose?: string
      enrollmentCodeRequired?: boolean
    }
  }

  // 202 Accepted: the password was right, but a second step is due (every administrator, an author who turned it on). No session
  // exists yet. The challenge goes into its own cookie and not into the body, so that no script of the page can read it; the page
  // only learns which step to show. The session cookies of an older sign-in are left alone: they are replaced, and the refresh token
  // they hold revoked, when the second step succeeds.
  if (upstream.status === 202) {
    const challenge = payload.data?.challenge
    if (!challenge)
      return NextResponse.json({ error: (await getTranslations('Admin.login'))('unusableSession') }, { status: 502 })
    // The password was right: this IP's earlier wrong attempts no longer count, as for a login that ends here.
    resetLoginAttempts(ip)
    const response = NextResponse.json(
      {
        ok: true,
        next: payload.data?.purpose === 'ENROLL' ? 'enroll' : 'mfa',
        enrollmentCodeRequired: payload.data?.enrollmentCodeRequired === true,
      },
      { headers: { 'cache-control': PRIVATE_NO_STORE } },
    )
    setMfaChallengeCookie(response, challenge)
    return response
  }

  const tokens = readSessionTokens(payload.data)
  if (tokens === null) {
    return NextResponse.json({ error: (await getTranslations('Admin.login'))('unusableSession') }, { status: 502 })
  }

  // Login succeeded: this IP's earlier wrong attempts no longer count (lib/rate-limit.ts).
  resetLoginAttempts(ip)

  // Logging in over an existing session (a GitHub reader, or a stale admin tab): the cookie is about
  // to be overwritten, so revoke the old refresh token at the backend first, otherwise it lives on for
  // 30 days with no browser holding it. Best effort, at most 3 seconds, errors are swallowed.
  const previous = readCookie(request, refreshCookieName())
  if (previous && previous !== tokens.refreshToken) await revokeRefreshToken(previous)

  // `{ ok: true }` and nothing else. The tokens go in the cookies; a body carrying
  // either one would put it where client JavaScript — and anything that can read the
  // response — can see it, which is the entire thing this design avoids.
  const response = NextResponse.json({ ok: true })
  setSessionCookies(response, tokens)
  return response
}
