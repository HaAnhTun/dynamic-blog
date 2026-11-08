// @vitest-environment node
// frontend/proxy.test.ts
import type { IncomingHttpHeaders } from 'node:http'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, type NextResponse } from 'next/server'
// Deep import into Next's internals, used by one test only and deliberately: the
// question that test answers is "what does Next 16.3.7 actually do", and the honest
// way to answer it without a running server is to call the function the server calls.
// `next/package.json` declares no `exports` map, so the subpath resolves for both
// TypeScript and Vite, and the `.d.ts` beside it means this is fully typed.
import { createRequestStore, type RequestStoreInputs } from 'next/dist/server/async-storage/request-store'
import { accessCookieName, refreshCookieName } from '@/lib/auth-cookies'
import { READ_LIMITS } from '@/lib/read-limit'
import { config, proxy } from './proxy'

const ORIGIN = 'http://localhost:3000'

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

/**
 * A token with a real `exp` and the signature dropped. `role` defaults to ADMIN, as in every test that predates the role claim;
 * `null` is a token that carries no role claim.
 */
function jwt(secondsFromNow: number, role: string | null = 'ADMIN'): string {
  const exp = Math.floor(Date.now() / 1000) + secondsFromNow
  const claims = role === null ? { sub: 'u1', exp } : { sub: 'u1', role, exp }
  return `${b64url({ alg: 'HS256' })}.${b64url(claims)}.sig`
}

function requestTo(path: string, cookies: Record<string, string>): NextRequest {
  const request = new NextRequest(`${ORIGIN}${path}`)
  for (const [name, value] of Object.entries(cookies)) request.cookies.set(name, value)
  return request
}

/** An access token that is already expired, so middleware always rotates. */
const STALE = jwt(-60)

/** What `cookies()` would return for a render handed these raw request headers. */
function storeFor(headers: IncomingHttpHeaders) {
  const inputs: RequestStoreInputs = {
    phase: 'render',
    headers,
    onUpdateCookies: undefined,
    url: { pathname: '/admin', search: '' },
    rootParams: {},
    implicitTags: { tags: [], expirationsByCacheKind: new Map() },
    resumeDataCache: null,
    previewProps: undefined,
    isHmrRefresh: false,
    serverComponentsHmrCache: undefined,
    hmrRefreshHash: undefined,
    stagedFallbackParams: null,
  }
  return createRequestStore(inputs)
}

describe('proxy', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  // Addition, not in the plan. The plan requires `@vitest-environment node` because
  // NextRequest/NextResponse behave differently under jsdom — but every assertion
  // below happens to pass under jsdom too, so a docblock that stops being honoured
  // (moved off line 1, renamed, dropped in a merge) would silently take the whole
  // file back to jsdom and nothing here would complain. This is the only assertion
  // that notices.
  it('runs in the node environment the rest of this file depends on', () => {
    expect(typeof window).toBe('undefined')
  })

  it('sends an unauthenticated visitor to the login page', async () => {
    const res = await proxy(requestTo('/admin', {}))

    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe(`${ORIGIN}/admin/login`)
  })

  it('lets the login page itself through, or nobody could ever log in', async () => {
    const res = await proxy(requestTo('/admin/login', {}))
    expect(res.headers.get('location')).toBeNull()
  })

  it('passes a healthy token through and sets no cookie', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const access = jwt(900)

    const res = await proxy(requestTo('/admin', { access_token: access, refresh_token: 'r' }))

    expect(fetchSpy).not.toHaveBeenCalled()
    // Rewriting the cookie on every request would be harmless but wasteful; asserting
    // it is absent is how we know the fast path is actually the fast path.
    expect(res.headers.getSetCookie()).toHaveLength(0)
  })

  it('refreshes an expired access token and sets the rotated pair', async () => {
    const fresh = jwt(900)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { accessToken: fresh, refreshToken: 'r2', expiresIn: 900 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    const res = await proxy(requestTo('/admin', { access_token: jwt(-60), refresh_token: 'r1' }))
    const cookies = res.headers.getSetCookie()

    expect(res.headers.get('location')).toBeNull()
    expect(cookies.find((c) => c.startsWith('access_token='))).toContain(fresh)
    // The rotated refresh token MUST be stored. 4a revokes the old one on use, so
    // keeping r1 means the next refresh fails and the author is logged out — the exact
    // bug that only appears after 15 idle minutes.
    expect(cookies.find((c) => c.startsWith('refresh_token='))).toContain('r2')
  })

  it('sets the refresh cookie for as long as the backend says the new token lives (audit 007)', async () => {
    const fresh = jwt(900)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ data: { accessToken: fresh, refreshToken: 'r2', expiresIn: 900, refreshExpiresIn: 604_800 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )

    const res = await proxy(requestTo('/admin', { access_token: jwt(-60), refresh_token: 'r1' }))
    const cookies = res.headers.getSetCookie()

    expect(cookies.find((c) => c.startsWith('refresh_token='))).toContain('Max-Age=604800')
    // The access cookie is a session cookie: no Max-Age at all.
    expect(cookies.find((c) => c.startsWith('access_token='))).not.toContain('Max-Age')
  })

  it('refreshes with the visitor address (counted from the right of X-Forwarded-For) and the shared token for the backend refresh limit', async () => {
    vi.stubEnv('CLIENT_IP_TOKEN', '  proxy-token-for-tests  ')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { accessToken: jwt(900), refreshToken: 'r2', expiresIn: 900 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const request = new NextRequest(`${ORIGIN}/admin`, { headers: { 'x-forwarded-for': '6.6.6.6, 198.51.100.91' } })
    request.cookies.set(refreshCookieName(), 'r1')

    await proxy(request)

    const headers = new Headers(fetchSpy.mock.calls[0]![1]?.headers)
    expect(headers.get('x-client-ip')).toBe('198.51.100.91')
    expect(headers.get('x-client-ip-token')).toBe('proxy-token-for-tests')
    expect([...headers.values()]).not.toContain('6.6.6.6')
  })

  it('refreshes when the access cookie is missing entirely', async () => {
    const fresh = jwt(900)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { accessToken: fresh, refreshToken: 'r2', expiresIn: 900 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    const res = await proxy(requestTo('/admin', { refresh_token: 'r1' }))

    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(res.headers.getSetCookie().find((c) => c.startsWith('access_token='))).toContain(fresh)
  })

  // Addition, not in the plan. EXPIRY_MARGIN_SECONDS is the one constant in the file
  // with a paragraph of justification — it exists so a token cannot die in flight, in a
  // request where no page can set a replacement — and nothing in the plan's suite pins
  // it: the plan's fixtures are jwt(900) and jwt(-60), both of which land the same side
  // of the line for any margin under 900. Mutation 7 in the report sets the margin to 0
  // and the plan's eight tests all pass. 10 seconds is inside the margin and in the
  // future, so this test fails for margin 0 and passes for 30.
  it('refreshes a token that is still valid but expiring inside the margin', async () => {
    const fresh = jwt(900)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { accessToken: fresh, refreshToken: 'r2', expiresIn: 900 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    const res = await proxy(requestTo('/admin', { access_token: jwt(10), refresh_token: 'r1' }))

    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(res.headers.getSetCookie().find((c) => c.startsWith('access_token='))).toContain(fresh)
  })

  // Addition, not in the plan. The plan covers a MISSING access cookie and an EXPIRED
  // one, but not a present-and-unreadable one, which is the third way `isExpiringWithin`
  // can return true and the one the task calls out: a truncated cookie, or a leftover
  // from an older token format. Treating it as healthy would send the author to the API
  // with a token it rejects, and no page can set a cookie to recover. Mutation 4 in the
  // report shows the plan's other two tests do not catch a fail-open on this path.
  it('fails closed on an unreadable access token and refreshes it', async () => {
    const fresh = jwt(900)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { accessToken: fresh, refreshToken: 'r2', expiresIn: 900 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    const res = await proxy(requestTo('/admin', { access_token: 'not-a-jwt', refresh_token: 'r1' }))

    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(res.headers.getSetCookie().find((c) => c.startsWith('access_token='))).toContain(fresh)
  })

  it.each([
    ['REFRESH_TOKEN_EXPIRED', 401],
    ['REFRESH_TOKEN_INVALID', 401],
    ['USER_SUSPENDED', 403],
  ])('clears both cookies and redirects when the refresh is rejected (%s)', async (code, status) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { code } }), { status }))

    const res = await proxy(requestTo('/admin', { access_token: jwt(-60), refresh_token: 'stale' }))

    expect(res.headers.get('location')).toBe(`${ORIGIN}/admin/login`)

    // Leaving a revoked refresh token in place means every subsequent request spends a
    // doomed refresh call before redirecting.
    const cleared = res.headers.getSetCookie()
    // CHANGED from the plan, which asserted only the `every(...)` line below. That line
    // alone is inert: `[].every(...)` is true, so it passed unchanged against a
    // middleware that cleared nothing at all (mutation 5 in the report). These two
    // assertions are what give it teeth — a count, and each cookie named.
    expect(cleared).toHaveLength(2)
    expect(cleared.find((c) => c.startsWith('access_token='))).toContain('Max-Age=0')
    expect(cleared.find((c) => c.startsWith('refresh_token='))).toContain('Max-Age=0')
    expect(cleared.every((c) => c.includes('Max-Age=0'))).toBe(true)
  })

  // /api/session of every public page also rotates exactly this cookie pair. An /admin tab that loses the race gets REFRESH_TOKEN_REVOKED while the winner's
  // response is setting the new pair; deleting the cookies here, if it arrives later, overwrites that pair and logs the admin out in every tab.
  it('redirects without clearing anything when the refresh lost a rotation race (REFRESH_TOKEN_REVOKED)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'REFRESH_TOKEN_REVOKED' } }), { status: 401 }),
    )

    const res = await proxy(requestTo('/admin', { access_token: jwt(-60), refresh_token: 'r1' }))

    expect(res.headers.get('location')).toBe(`${ORIGIN}/admin/login`)
    expect(res.headers.getSetCookie()).toHaveLength(0)
    expect(res.headers.get('x-middleware-set-cookie')).toBeNull()
  })

  // The backend counts refreshes per client address now (REFRESH_CLIENT), so /api/v1/auth/refresh can answer 429: a busy shared address
  // or a flood of junk refresh cookies from elsewhere. The session itself is fine; lib/session-refresh.ts already treats these as "try again later".
  it.each([429, 408, 500, 502, 503])(
    'redirects without clearing anything when the refresh answers %i (unavailable, not a dead session)',
    async (status) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ error: { code: 'RATE_LIMITED' } }), { status }),
      )

      const res = await proxy(requestTo('/admin', { access_token: jwt(-60), refresh_token: 'r1' }))

      expect(res.headers.get('location')).toBe(`${ORIGIN}/admin/login`)
      expect(res.headers.getSetCookie()).toHaveLength(0)
      expect(res.headers.get('x-middleware-set-cookie')).toBeNull()
    },
  )

  it('still clears the cookies when the refresh is refused with another 4xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'REFRESH_TOKEN_EXPIRED' } }), { status: 401 }),
    )

    const res = await proxy(requestTo('/admin', { access_token: jwt(-60), refresh_token: 'r1' }))

    expect(res.headers.get('location')).toBe(`${ORIGIN}/admin/login`)
    expect(res.headers.getSetCookie()).toHaveLength(2)
    expect(res.headers.getSetCookie().every((c) => c.includes('Max-Age=0'))).toBe(true)
  })

  it('redirects rather than erroring when the API is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))

    const res = await proxy(requestTo('/admin', { access_token: jwt(-60), refresh_token: 'r1' }))

    expect(res.headers.get('location')).toBe(`${ORIGIN}/admin/login`)
  })

  it('lets the first-run setup page through without next-intl, a session or a refresh', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    for (const pathname of ['/setup', '/setup/submit']) {
      const res = await proxy(requestTo(pathname, {}))

      expect(res.headers.get('location'), pathname).toBeNull()
      expect(res.headers.get('x-middleware-rewrite'), pathname).toBeNull()
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('does not touch a public page', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await proxy(requestTo('/posts/hello', {}))

    expect(res.headers.get('location')).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// A Server Action call with no session: do NOT redirect. The browser fetch follows the 307 by itself,
// POSTs the action again to /admin/login, Next returns a 404 `x-nextjs-action-not-found` and every admin
// screen shows "Could not reach the server, try again later." instead of the session-expired sentence (measured on the QA stack). Letting
// it through makes the action report it itself: adminRequest throws SessionExpiredError when the access cookie is missing or
// empty (lib/admin-api.test.ts), the editor shows its sentence in place, runAdminAction goes back to the
// login (posts/actions.test.ts, lib/admin-action.test.ts).
// ---------------------------------------------------------------------------
/**
 * Audit 031. In production the session cookies are `__Host-access_token` and `__Host-refresh_token`. A cookie of the old plain name
 * can be planted by a sibling subdomain, so it is never read, and never preferred over the prefixed one.
 */
describe('proxy, the __Host- session cookies in production', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  function refreshed(fresh: string) {
    return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { accessToken: fresh, refreshToken: 'r2', expiresIn: 900 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }

  it('reads the __Host- pair, refreshes it, and sets the new pair under the __Host- names', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const fresh = jwt(900)
    const fetchSpy = refreshed(fresh)

    const res = await proxy(requestTo('/admin', { '__Host-access_token': jwt(-60), '__Host-refresh_token': 'r1' }))
    const cookies = res.headers.getSetCookie()

    expect(JSON.parse(String(fetchSpy.mock.calls[0]![1]!.body))).toEqual({ refreshToken: 'r1' })
    expect(cookies.find((c) => c.startsWith('__Host-access_token='))).toContain(fresh)
    const refresh = cookies.find((c) => c.startsWith('__Host-refresh_token='))!
    expect(refresh).toContain('r2')
    expect(refresh).toContain('Secure')
    expect(refresh).toContain('Path=/')
    // And the old names are deleted on the way, so a pair from the release before the prefix does not linger.
    expect(cookies.filter((c) => /^(access_token|refresh_token)=;/.test(c))).toHaveLength(2)
  })

  it('never prefers a cookie of the old plain name over the __Host- one', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const fetchSpy = refreshed(jwt(900))

    await proxy(
      requestTo('/admin', {
        refresh_token: 'planted-by-a-sibling',
        access_token: jwt(900),
        '__Host-access_token': jwt(-60),
        '__Host-refresh_token': 'genuine',
      }),
    )

    expect(JSON.parse(String(fetchSpy.mock.calls[0]![1]!.body))).toEqual({ refreshToken: 'genuine' })
  })

  it('treats a request that carries only the old plain names as having no session: no refresh, back to the login', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await proxy(requestTo('/admin', { access_token: jwt(900), refresh_token: 'planted-or-stale' }))

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(res.headers.get('location')).toBe(`${ORIGIN}/admin/login`)
  })

  it('a dead session clears the __Host- pair and the old names', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'REFRESH_TOKEN_EXPIRED' } }), { status: 401 }),
    )

    const res = await proxy(requestTo('/admin', { '__Host-access_token': jwt(-60), '__Host-refresh_token': 'r1' }))

    expect(
      res.headers
        .getSetCookie()
        .map((c) => c.split('=')[0])
        .sort(),
    ).toEqual(['__Host-access_token', '__Host-refresh_token', 'access_token', 'refresh_token'])
  })
})

describe('proxy, Server Action calls without a usable session', () => {
  afterEach(() => vi.restoreAllMocks())

  /** Exactly the shape the Next router sends for an action: a POST, the id in `next-action`. */
  function actionTo(path: string, cookies: Record<string, string>, method = 'POST'): NextRequest {
    const request = new NextRequest(`${ORIGIN}${path}`, {
      method,
      headers: { 'next-action': '7f3a9c0d1e2b', 'content-type': 'text/plain;charset=UTF-8' },
      ...(method === 'POST' ? { body: '["p1"]' } : {}),
    })
    for (const [name, value] of Object.entries(cookies)) request.cookies.set(name, value)
    return request
  }

  it('lets the call through when there is no session at all, so the action reports it', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await proxy(actionTo('/admin/posts/p1/edit', {}))

    expect(res.headers.get('location')).toBeNull()
    expect(res.status).toBe(200)
    expect(res.headers.get('x-middleware-next')).toBe('1')
    // Nothing to try, and nothing to delete.
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(res.headers.getSetCookie()).toHaveLength(0)
  })

  it('clears the cookies of a rejected refresh without redirecting, and the action reads them as gone', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'REFRESH_TOKEN_EXPIRED' } }), { status: 401 }),
    )

    const res = await proxy(actionTo('/admin/gallery', { access_token: STALE, refresh_token: 'stale' }))

    expect(res.headers.get('location')).toBeNull()
    expect(res.headers.get('x-middleware-next')).toBe('1')
    const cleared = res.headers.getSetCookie()
    expect(cleared).toHaveLength(2)
    expect(cleared.find((c) => c.startsWith('access_token='))).toContain('Max-Age=0')
    expect(cleared.find((c) => c.startsWith('refresh_token='))).toContain('Max-Age=0')

    // What the action really sees: its cookies() merges x-middleware-set-cookie, so the access cookie
    // has no value (measured: `{ name: 'access_token' }`, value undefined) instead of the old token, and
    // adminRequest throws SessionExpiredError before calling the API (`if (!token)`).
    const staleCookieHeader = `${accessCookieName()}=${STALE}; ${refreshCookieName()}=stale`
    const merged = storeFor({
      cookie: staleCookieHeader,
      'x-middleware-set-cookie': res.headers.get('x-middleware-set-cookie') ?? '',
    })
    expect(merged.cookies.get(accessCookieName())?.value).toBeFalsy()
    // Control: without the merge step the action reads the old token back and sends it to the backend.
    expect(storeFor({ cookie: staleCookieHeader }).cookies.get(accessCookieName())?.value).toBe(STALE)
  })

  it('lets the call through untouched when the refresh lost a rotation race (REFRESH_TOKEN_REVOKED)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'REFRESH_TOKEN_REVOKED' } }), { status: 401 }),
    )

    const res = await proxy(actionTo('/admin/gallery', { access_token: STALE, refresh_token: 'r1' }))

    expect(res.headers.get('location')).toBeNull()
    expect(res.headers.get('x-middleware-next')).toBe('1')
    // Not deleted: the winner's new pair must stay intact. The action sends the old token, the backend returns 401 and
    // adminRequest throws SessionExpiredError like every time the session expires.
    expect(res.headers.getSetCookie()).toHaveLength(0)
  })

  it('lets the call through untouched when the refresh is rate limited (429), the session is not dead', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'RATE_LIMITED' } }), { status: 429 }),
    )

    const res = await proxy(actionTo('/admin/gallery', { access_token: STALE, refresh_token: 'r1' }))

    expect(res.headers.get('location')).toBeNull()
    expect(res.headers.get('x-middleware-next')).toBe('1')
    expect(res.headers.getSetCookie()).toHaveLength(0)
  })

  it('treats a refresh answer without tokens like a rejected one', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'content-type': 'application/json' } }),
    )

    const res = await proxy(actionTo('/admin/series', { access_token: STALE, refresh_token: 'r1' }))

    expect(res.headers.get('location')).toBeNull()
    expect(res.headers.getSetCookie().every((c) => c.includes('Max-Age=0'))).toBe(true)
    expect(res.headers.getSetCookie()).toHaveLength(2)
  })

  it('lets the call through when the API is unreachable, so the action says so', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))

    const res = await proxy(actionTo('/admin/posts/new', { access_token: STALE, refresh_token: 'r1' }))

    expect(res.headers.get('location')).toBeNull()
    expect(res.headers.get('x-middleware-next')).toBe('1')
    // The session may still be alive: a dead API is no reason to log anyone out.
    expect(res.headers.getSetCookie()).toHaveLength(0)
  })

  it('still rotates the tokens for an action call when the refresh works', async () => {
    const fresh = jwt(900)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { accessToken: fresh, refreshToken: 'r2', expiresIn: 900 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    const res = await proxy(actionTo('/admin/curated', { access_token: STALE, refresh_token: 'r1' }))

    expect(res.headers.get('location')).toBeNull()
    expect(res.headers.getSetCookie().find((c) => c.startsWith('access_token='))).toContain(fresh)
    expect(res.headers.getSetCookie().find((c) => c.startsWith('refresh_token='))).toContain('r2')
  })

  // The boundary of the check: only a POST carrying `next-action` is an action call. A stray GET with that header is still a
  // page navigation and still goes to the login; a plain form POST without it is refused outright (see the last describe).
  it('still redirects a GET that carries the action header, and refuses a plain form POST', async () => {
    const plainPost = new NextRequest(`${ORIGIN}/admin/posts/new`, { method: 'POST', body: 'title=x' })
    const getWithHeader = actionTo('/admin/posts/new', {}, 'GET')

    const res = await proxy(getWithHeader)
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe(`${ORIGIN}/admin/login`)
    expect((await proxy(plainPost)).status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// The /admin UI is for ADMIN and AUTHOR. With a usable token (existing or just rotated)
// whose role claim is neither of those two roles, the page and RSC requests go to /admin/login?reason=forbidden,
// carrying the cookie pair just rotated; a Server Action call goes on so the backend returns 403 FORBIDDEN
// and runAdminAction shows its "This account is not allowed to do that." sentence. The claim only decides navigation, not data.
// ---------------------------------------------------------------------------
describe('proxy, /admin is for ADMIN and AUTHOR (V7a)', () => {
  afterEach(() => vi.restoreAllMocks())

  const FORBIDDEN = `${ORIGIN}/admin/login?reason=forbidden`

  function rotatingTo(fresh: string) {
    return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { accessToken: fresh, refreshToken: 'r2', expiresIn: 900 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }

  function actionTo(path: string, cookies: Record<string, string>): NextRequest {
    const request = new NextRequest(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: { 'next-action': '7f3a9c0d1e2b', 'content-type': 'text/plain;charset=UTF-8' },
      body: '["p1"]',
    })
    for (const [name, value] of Object.entries(cookies)) request.cookies.set(name, value)
    return request
  }

  it.each([
    ['an ADMIN', 'ADMIN'],
    ['an AUTHOR', 'AUTHOR'],
  ])('lets %s with a healthy token in, without a refresh', async (_label, role) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await proxy(requestTo('/admin/posts', { access_token: jwt(900, role), refresh_token: 'r' }))

    expect(res.headers.get('location')).toBeNull()
    expect(res.headers.get('x-middleware-next')).toBe('1')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each([
    ['a USER', 'USER'],
    ['a lower-case author claim', 'author'],
  ])('sends %s with a healthy token to the forbidden notice, without a refresh', async (_label, role) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await proxy(requestTo('/admin/posts', { access_token: jwt(900, role), refresh_token: 'r' }))

    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe(FORBIDDEN)
    expect(fetchSpy).not.toHaveBeenCalled()
    // The reader is still logged in on the public side: being refused /admin is not being logged out.
    expect(res.headers.getSetCookie()).toHaveLength(0)
  })

  it.each([
    ['no role claim at all', null],
    ['an unknown role', 'SUPERUSER'],
    ['a role in the wrong case', 'admin'],
  ])('treats a token with %s as forbidden', async (_label, role) => {
    const res = await proxy(requestTo('/admin', { access_token: jwt(900, role), refresh_token: 'r' }))

    expect(res.headers.get('location')).toBe(FORBIDDEN)
  })

  it('redirects RSC and prefetch requests too, not only full page loads', async () => {
    const request = new NextRequest(`${ORIGIN}/admin/topics`, { headers: { rsc: '1', 'next-router-prefetch': '1' } })
    request.cookies.set(accessCookieName(), jwt(900, 'USER'))
    request.cookies.set(refreshCookieName(), 'r')

    const res = await proxy(request)

    expect(res.headers.get('location')).toBe(FORBIDDEN)
  })

  it('keeps the rotated pair on the redirect when the refresh was what produced the token', async () => {
    const fresh = jwt(900, 'USER')
    rotatingTo(fresh)

    const res = await proxy(requestTo('/admin', { access_token: jwt(-60, 'USER'), refresh_token: 'r1' }))
    const cookies = res.headers.getSetCookie()

    expect(res.headers.get('location')).toBe(FORBIDDEN)
    // The backend revoked r1 when rotating. Dropping the new pair here logs the reader out of the whole public part
    // too: their next refresh carries r1 and is refused.
    expect(cookies.find((c) => c.startsWith('access_token='))).toContain(fresh)
    expect(cookies.find((c) => c.startsWith('refresh_token='))).toContain('r2')
  })

  it('decides on the freshly refreshed token, not the stale one', async () => {
    // The old token says USER, the new token says ADMIN (just promoted by SQL): the new claim wins.
    const fresh = jwt(900, 'ADMIN')
    rotatingTo(fresh)

    const res = await proxy(requestTo('/admin', { access_token: jwt(-60, 'USER'), refresh_token: 'r1' }))

    expect(res.headers.get('location')).toBeNull()
    expect(res.headers.get('x-middleware-next')).toBe('1')
  })

  it("lets a USER's Server Action call through, so the backend answers 403 and the action says so", async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await proxy(actionTo('/admin/posts/p1/edit', { access_token: jwt(900, 'USER'), refresh_token: 'r' }))

    expect(res.status).toBe(200)
    expect(res.headers.get('location')).toBeNull()
    expect(res.headers.get('x-middleware-next')).toBe('1')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(res.headers.getSetCookie()).toHaveLength(0)
  })

  it('still rotates the tokens for a USER action call', async () => {
    const fresh = jwt(900, 'USER')
    rotatingTo(fresh)

    const res = await proxy(actionTo('/admin/gallery', { access_token: jwt(-60, 'USER'), refresh_token: 'r1' }))

    expect(res.headers.get('location')).toBeNull()
    expect(res.headers.get('x-middleware-next')).toBe('1')
    expect(res.headers.getSetCookie().find((c) => c.startsWith('access_token='))).toContain(fresh)
    expect(res.headers.getSetCookie().find((c) => c.startsWith('refresh_token='))).toContain('r2')
  })

  it('leaves an ADMIN exactly as before', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await proxy(requestTo('/admin/series', { access_token: jwt(900, 'ADMIN'), refresh_token: 'r' }))

    expect(res.headers.get('location')).toBeNull()
    expect(res.headers.get('x-middleware-next')).toBe('1')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(res.headers.getSetCookie()).toHaveLength(0)
  })

  it.each(['/admin/login', '/admin/login/submit', '/admin/logout'])(
    'never gates %s, or a reader could not reach the admin login at all',
    async (path) => {
      const res = await proxy(requestTo(path, { access_token: jwt(900, 'USER'), refresh_token: 'r' }))

      expect(res.headers.get('location')).toBeNull()
    },
  )
})

describe('proxy, the second step of a sign-in is reachable without a session', () => {
  afterEach(() => vi.restoreAllMocks())

  const STEPS = [
    '/admin/login/mfa',
    '/admin/login/mfa/submit',
    '/admin/login/enroll',
    '/admin/login/enroll/begin',
    '/admin/login/enroll/confirm',
  ]

  it.each(STEPS)('lets %s through with no cookie at all, without a refresh', async (path) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await proxy(requestTo(path, {}))

    expect(res.headers.get('location')).toBeNull()
    expect(res.headers.get('x-middleware-next')).toBe('1')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(res.headers.getSetCookie()).toHaveLength(0)
  })

  it.each([
    '/admin/login/mfaX',
    '/admin/login/mfa/',
    '/admin/login/mfa/other',
    '/admin/login/enroll/other',
    '/admin/login/enrollment',
  ])('does not open %s: only the five exact paths are open', async (path) => {
    const res = await proxy(requestTo(path, {}))

    expect(res.headers.get('location')).toContain('/admin/login')
    expect(res.headers.get('x-middleware-next')).toBeNull()
  })

  it('lets a JSON post to the route handlers through, with the same plain-form rule as the login target', async () => {
    for (const path of ['/admin/login/mfa/submit', '/admin/login/enroll/begin', '/admin/login/enroll/confirm']) {
      const request = new NextRequest(`${ORIGIN}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      const res = await proxy(request)
      expect(res.status, path).toBe(200)
      expect(res.headers.get('x-middleware-next'), path).toBe('1')
    }
  })
})

// ---------------------------------------------------------------------------
// Step 6's open question, settled by measurement. The plan feared that the page
// rendered in the SAME pass as a rotation reads the OLD cookie — the response
// carries the new one, the request still carries the stale one — and proposed
// rewriting the forwarded `cookie` header via `next({ request: { headers } })`.
// It explicitly said not to implement that on the strength of the paragraph.
//
// These two tests are the measurement, and they are kept rather than thrown away
// because they are the only thing that would notice a Next upgrade changing it.
// ---------------------------------------------------------------------------
describe('same-pass cookie visibility (Next 16.3.7, measured)', () => {
  afterEach(() => vi.restoreAllMocks())

  async function rotate(fresh: string): Promise<NextResponse> {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { accessToken: fresh, refreshToken: 'r2', expiresIn: 900 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    return proxy(requestTo('/admin', { access_token: STALE, refresh_token: 'r1' }))
  }

  it('does not rewrite the forwarded request headers', async () => {
    const res = await rotate(jwt(900))

    // `handleMiddlewareField` (server/web/spec-extension/response.js) is what emits
    // these two, and only when `next()` is given `{ request: { headers } }`. Their
    // absence is the positive signal that the simple version is what shipped.
    expect(res.headers.get('x-middleware-override-headers')).toBeNull()
    expect(res.headers.get('x-middleware-request-cookie')).toBeNull()
  })

  it("still reaches the render's cookies(), through x-middleware-set-cookie", async () => {
    const fresh = jwt(900)
    const res = await rotate(fresh)

    // Step 1 of the chain: setting a response cookie also writes this internal header.
    const setCookieHeader = res.headers.get('x-middleware-set-cookie')
    expect(setCookieHeader).toContain(fresh)

    // Step 2 is one line of Next's router, not worth re-implementing: resolve-routes.js
    // copies that header onto the downstream request —
    //   `if (key === 'x-middleware-set-cookie') { req.headers[key] = value; continue }`
    // — deliberately onto the REQUEST and not the response. So the render's raw
    // `cookie` header is still the stale one, and it arrives alongside the new header.
    const staleCookieHeader = `${accessCookieName()}=${STALE}; ${refreshCookieName()}=r1`

    // Step 3: drive Next's real request store, the same function `next start` uses to
    // build what `cookies()` returns. This is the actual measurement.
    //
    // Each `storeFor` gets its OWN header object on purpose. Measured the hard way:
    // the merge MUTATES the object it is given, because `HeadersAdapter.from` wraps a
    // plain object rather than copying it, so `RequestCookies.set` writes the fresh
    // tokens straight back into `headers.cookie`. Sharing one object between the
    // measurement and the control below silently made the control pass fresh values.
    const merged = storeFor({
      cookie: staleCookieHeader,
      'x-middleware-set-cookie': setCookieHeader ?? '',
    })
    expect(merged.cookies.get(accessCookieName())?.value).toBe(fresh)
    expect(merged.cookies.get(refreshCookieName())?.value).toBe('r2')

    // The control. Without the header the identical store yields the STALE token, so
    // the merge is doing the work — the assertions above are not passing because the
    // fixture happened to contain the fresh value already.
    const unmerged = storeFor({ cookie: staleCookieHeader })
    expect(unmerged.cookies.get(accessCookieName())?.value).toBe(STALE)

    // Caveat, from Next's own TODO above `mergeMiddlewareCookies`: the merge fires for
    // Node `IncomingHttpHeaders` and silently falls through for a Web `Headers`
    // instance. That is why this test feeds a plain object — it is the shape the Node
    // server passes, and the only shape we deploy on.
  })
})

describe('proxy, plain form posts to /admin', () => {
  afterEach(() => vi.restoreAllMocks())

  function postTo(path: string, contentType: string, headers: Record<string, string> = {}): NextRequest {
    const request = new NextRequest(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: { 'content-type': contentType, ...headers },
      body: 'a=b',
    })
    request.cookies.set(accessCookieName(), jwt(600, 'ADMIN'))
    request.cookies.set(refreshCookieName(), 'refresh')
    return request
  }

  it.each(['multipart/form-data; boundary=x', 'application/x-www-form-urlencoded', 'text/plain'])(
    'refuses a %s POST without next-action, even for an ADMIN',
    async (contentType) => {
      const res = await proxy(postTo('/admin/users', contentType))

      expect(res.status).toBe(403)
      expect(res.headers.get('x-middleware-next')).toBeNull()
    },
  )

  it('still lets the same POST through when it is a Server Action call', async () => {
    const res = await proxy(postTo('/admin/users', 'multipart/form-data; boundary=x', { 'next-action': '7f3a9c0d1e2b' }))

    expect(res.status).toBe(200)
    expect(res.headers.get('x-middleware-next')).toBe('1')
  })

  it('refuses the post with no session too, and keeps the login and logout targets open', async () => {
    const noSession = new NextRequest(`${ORIGIN}/admin/users`, {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
      body: 'a=b',
    })
    expect((await proxy(noSession)).status).toBe(403)

    for (const open of ['/admin/login/submit', '/admin/logout']) {
      const res = await proxy(postTo(open, 'application/x-www-form-urlencoded'))
      expect(res.status, open).toBe(200)
    }
  })
})

/** The same function Next uses to match a path against a middleware `source` (see next-config.test.ts). */
const { getPathMatch } = createRequire(import.meta.url)(
  'next/dist/shared/lib/router/utils/path-match',
) as typeof import('next/dist/shared/lib/router/utils/path-match')

describe('proxy, config.matcher keeps every /admin path', () => {
  const matches = (pathname: string) =>
    config.matcher.some((source) => getPathMatch(source, { strict: true, removeUnnamedParams: true })(pathname) !== false)

  it.each([
    '/admin',
    '/admin/users',
    '/admin/settings/about.x',
    '/admin/series/1.json',
    '/admin/settings/a.b.c',
    '/admin/series/a.b',
    '/admin/series/11111111-1111-1111-1111-111111111111',
    '/admin/posts/x.y',
    '/admin/posts/x.y/edit',
  ])('runs the proxy for %s whatever its extension', (pathname) => {
    expect(matches(pathname)).toBe(true)
  })

  it('still leaves files outside /admin alone', () => {
    expect(matches('/robots.txt')).toBe(false)
    expect(matches('/uploads/photo.png')).toBe(false)
    expect(matches('/_next/static/a.js')).toBe(false)
    expect(matches('/media/x.png')).toBe(false)
  })

  it('keeps the feeds on the locale routing', () => {
    expect(matches('/feed.xml')).toBe(true)
    expect(matches('/en/feed.xml')).toBe(true)
  })

  it('refuses a multipart POST without next-action to a dynamic admin route that looks like a file', async () => {
    const request = new NextRequest(`${ORIGIN}/admin/settings/about.x`, {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
      body: 'a=b',
    })
    request.cookies.set(accessCookieName(), jwt(600, 'ADMIN'))
    request.cookies.set(refreshCookieName(), 'refresh')

    expect((await proxy(request)).status).toBe(403)
  })
})

/**
 * Two paths cannot count themselves and are counted here, with the address the proxy wrote (lib/read-limit.ts): the image optimizer,
 * whose fetch of `/media/<id>` carries the address of the proxy and not of the reader (the route does not count it either), and the
 * sitemap, a metadata route that cannot answer 429. Next internals other than `/_next/image` stay out.
 */
describe.each([
  ['the image optimizer', '/_next/image?url=%2Fmedia%2Fx.png&w=640&q=75', 'image'],
  ['the sitemap', '/sitemap.xml', 'sitemap'],
] as const)('proxy, %s', (_name, target, kind) => {
  const matches = (pathname: string) =>
    config.matcher.some((source) => getPathMatch(source, { strict: true, removeUnnamedParams: true })(pathname) !== false)
  const call = (ip: string | null) =>
    new NextRequest(`${ORIGIN}${target}`, { headers: ip === null ? {} : { 'x-forwarded-for': ip } })

  it('runs for its path and for no other path of Next, nor for a picture', () => {
    expect(matches(target.split('?')[0]!)).toBe(true)
    expect(matches('/_next/static/chunks/app.js')).toBe(false)
    expect(matches('/_next/data/x.json')).toBe(false)
    expect(matches('/media/0b9a5a4e-7c1d-4f7e-8f52-3c1e2d9a6b10.png')).toBe(false)
    expect(matches('/robots.txt')).toBe(false)
  })

  it('lets the requests through up to the allowance, then answers 429 with Retry-After and no body', async () => {
    const { limit } = READ_LIMITS[kind]
    for (let i = 0; i < limit; i++) {
      const response = await proxy(call('198.51.100.7, 203.0.113.70'))
      expect(response.status).toBe(200)
      expect(response.headers.get('x-middleware-next')).toBe('1')
    }

    const refused = await proxy(call('198.51.100.8, 203.0.113.70'))

    expect(refused.status).toBe(429)
    expect(refused.headers.get('x-middleware-next')).toBeNull()
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    expect(refused.headers.get('cache-control')).toBe('no-store')
    expect(refused.body).toBeNull()
  })

  it('counts each reader apart, by the address the proxy wrote and not by the first entry the caller sent', async () => {
    const { limit } = READ_LIMITS[kind]
    for (let i = 0; i <= limit; i++) await proxy(call(`10.66.${i % 250}.1, 203.0.113.71`))

    expect((await proxy(call('10.99.0.1, 203.0.113.71'))).status).toBe(429)
    expect((await proxy(call('10.99.0.1, 203.0.113.72'))).status).toBe(200)
  })

  it('does not limit a request whose address cannot be read: one shared bucket would break every reader', async () => {
    for (let i = 0; i < READ_LIMITS[kind].limit + 20; i++) expect((await proxy(call(null))).status).toBe(200)
  })
})
