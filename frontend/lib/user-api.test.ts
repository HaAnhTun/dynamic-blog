// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { forwardToApi } from './user-api'

const ORIGIN = 'http://localhost:3000'

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function jwt(secondsFromNow: number, tag = 'a'): string {
  const exp = Math.floor(Date.now() / 1000) + secondsFromNow
  return `${b64url({ alg: 'HS256' })}.${b64url({ sub: 'u1', role: 'USER', exp, tag })}.sig`
}

const FRESH = jwt(600, 'fresh')
const STALE = jwt(-60, 'stale')

/** One refresh token per test: the memo of lib/session-refresh.ts lives across the tests. */
let counter = 0
function refreshToken(): string {
  counter += 1
  return `r-${counter}-${Math.random().toString(36).slice(2)}`
}

function request(cookies: Record<string, string>): NextRequest {
  const req = new NextRequest(`${ORIGIN}/api/posts/bai-viet/comments`)
  for (const [name, value] of Object.entries(cookies)) req.cookies.set(name, value)
  return req
}

type Route = (url: string, init: RequestInit) => Response | Promise<Response>

/** Fake fetch, answers by path; records every call. */
function backend(route: Route) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => route(String(input), init ?? {}))
}

function authOf(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get('authorization')
}

const ROTATED = { data: { accessToken: FRESH, refreshToken: 'r-rotated', expiresIn: 900 } }

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('forwardToApi: sends the Bearer and returns the backend response as is', () => {
  it('access token still valid: sends the Bearer, returns status and envelope as is, private no-store', async () => {
    vi.stubEnv('API_BASE_URL', 'http://backend.test:8080')
    const fetchSpy = backend(() => Response.json({ data: { liked: true, count: 3 } }))

    const res = await forwardToApi(
      request({ access_token: FRESH, refresh_token: refreshToken() }),
      '/api/v1/posts/bai-viet/like',
      { method: 'GET' },
      'optional',
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toEqual({ data: { liked: true, count: 3 } })
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(String(url)).toBe('http://backend.test:8080/api/v1/posts/bai-viet/like')
    expect(authOf(init)).toBe(`Bearer ${FRESH}`)
    expect(init).toMatchObject({ method: 'GET', cache: 'no-store' })
    // No refresh when not needed, so no cookie is touched.
    expect(res.headers.getSetCookie()).toHaveLength(0)
  })

  it('POST forwards the body as is, with a JSON content-type', async () => {
    const fetchSpy = backend(() => Response.json({ data: { id: 'c1' } }, { status: 201 }))

    const res = await forwardToApi(
      request({ access_token: FRESH, refresh_token: refreshToken() }),
      '/api/v1/posts/bai-viet/comments',
      { method: 'POST', body: '{"content":"Hello there"}' },
      'required',
    )

    expect(res.status).toBe(201)
    const init = fetchSpy.mock.calls[0]![1]!
    expect(init.body).toBe('{"content":"Hello there"}')
    expect(new Headers(init.headers).get('content-type')).toBe('application/json')
  })

  it('a backend error comes out with its status and code, not turned into 500', async () => {
    backend(() => Response.json({ error: { code: 'RATE_LIMITED', message: 'slow down' } }, { status: 429 }))

    const res = await forwardToApi(
      request({ access_token: FRESH, refresh_token: refreshToken() }),
      '/api/v1/posts/bai-viet/like',
      { method: 'PUT' },
      'required',
    )

    expect(res.status).toBe(429)
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'RATE_LIMITED' } })
  })

  it('204 comes out as 204 with no body', async () => {
    backend(() => new Response(null, { status: 204 }))

    const res = await forwardToApi(
      request({ access_token: FRESH, refresh_token: refreshToken() }),
      '/api/v1/comments/c1',
      { method: 'DELETE' },
      'required',
    )

    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
  })

  it("an unreachable backend gives 502, and the proxy's HTML error body never leaks out", async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('fetch failed'))
    const down = await forwardToApi(request({ access_token: FRESH }), '/api/v1/x', { method: 'GET' }, 'optional')
    expect(down.status).toBe(502)

    backend(() => new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }))
    const html = await forwardToApi(request({ access_token: FRESH }), '/api/v1/x', { method: 'GET' }, 'optional')
    expect(html.status).toBe(502)
    expect(await html.text()).not.toContain('<html>')
  })
})

describe('forwardToApi: optional', () => {
  it('with no cookie at all it calls the backend as an anonymous visitor', async () => {
    const fetchSpy = backend(() => Response.json({ data: { liked: false, count: 3 } }))

    const res = await forwardToApi(request({}), '/api/v1/posts/bai-viet/like', { method: 'GET' }, 'optional')

    expect(res.status).toBe(200)
    expect(authOf(fetchSpy.mock.calls[0]![1])).toBeNull()
  })

  it('a GET carrying a Bearer that gets 401 retries once without the Bearer', async () => {
    const fetchSpy = backend((_url, init) =>
      authOf(init)
        ? Response.json({ error: { code: 'UNAUTHENTICATED', message: 'x' } }, { status: 401 })
        : Response.json({ data: { threads: [], nextCursor: null } }),
    )

    const res = await forwardToApi(
      request({ access_token: FRESH, refresh_token: refreshToken() }),
      '/api/v1/posts/bai-viet/comments?size=10',
      { method: 'GET' },
      'optional',
    )

    expect(res.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(authOf(fetchSpy.mock.calls[1]![1])).toBeNull()
  })

  it('a refresh meeting a dead backend still goes on as an anonymous visitor, keeping the cookie', async () => {
    const fetchSpy = backend((url) => {
      if (url.endsWith('/auth/refresh')) throw new TypeError('fetch failed')
      return Response.json({ data: { liked: false, count: 1 } })
    })

    const res = await forwardToApi(
      request({ access_token: STALE, refresh_token: refreshToken() }),
      '/api/v1/posts/bai-viet/like',
      { method: 'GET' },
      'optional',
    )

    expect(res.status).toBe(200)
    expect(authOf(fetchSpy.mock.calls.at(-1)![1])).toBeNull()
    expect(res.headers.getSetCookie()).toHaveLength(0)
  })
})

describe('forwardToApi: required', () => {
  it('with no session gives 401 UNAUTHENTICATED without calling the backend', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await forwardToApi(request({}), '/api/v1/posts/bai-viet/like', { method: 'PUT' }, 'required')

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'UNAUTHENTICATED' } })
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a refresh meeting a dead backend gives 502, keeping the cookie', async () => {
    const fetchSpy = backend(() => {
      throw new TypeError('fetch failed')
    })

    const res = await forwardToApi(
      request({ access_token: STALE, refresh_token: refreshToken() }),
      '/api/v1/posts/bai-viet/like',
      { method: 'PUT' },
      'required',
    )

    expect(res.status).toBe(502)
    expect(fetchSpy).toHaveBeenCalledTimes(1) // only the refresh
    expect(res.headers.getSetCookie()).toHaveLength(0)
  })

  it('backend 401 while the refresh token is unused: refreshes once, resends once, sets the new cookie', async () => {
    const fetchSpy = backend((url, init) => {
      if (url.endsWith('/auth/refresh')) return Response.json(ROTATED)
      return authOf(init) === `Bearer ${FRESH}`
        ? Response.json({ data: { liked: true, count: 1 } })
        : Response.json({ error: { code: 'UNAUTHENTICATED', message: 'x' } }, { status: 401 })
    })
    // The access token has not expired by Next's clock, but the backend rejects it (clock skew, key change).
    const rejected = jwt(600, 'rejected-by-backend')

    const res = await forwardToApi(
      request({ access_token: rejected, refresh_token: refreshToken() }),
      '/api/v1/posts/bai-viet/like',
      { method: 'PUT' },
      'required',
    )

    expect(res.status).toBe(200)
    expect(fetchSpy.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/api/v1/posts/bai-viet/like',
      '/api/v1/auth/refresh',
      '/api/v1/posts/bai-viet/like',
    ])
    const cookies = res.headers.getSetCookie()
    expect(cookies.find((c) => c.startsWith('access_token='))).toContain(FRESH)
    expect(cookies.find((c) => c.startsWith('refresh_token='))).toContain('r-rotated')
  })
})

describe('forwardToApi: cookie sau khi refresh', () => {
  it('access expired, refresh ok: uses the new pair and sets both cookies on the response', async () => {
    const fetchSpy = backend((url) =>
      url.endsWith('/auth/refresh') ? Response.json(ROTATED) : Response.json({ data: { liked: true, count: 2 } }),
    )

    const res = await forwardToApi(
      request({ access_token: STALE, refresh_token: refreshToken() }),
      '/api/v1/posts/bai-viet/like',
      { method: 'PUT' },
      'required',
    )

    expect(res.status).toBe(200)
    expect(authOf(fetchSpy.mock.calls[1]![1])).toBe(`Bearer ${FRESH}`)
    const cookies = res.headers.getSetCookie()
    expect(cookies.map((c) => c.split('=')[0]).sort()).toEqual(['access_token', 'refresh_token'])
    expect(cookies.every((c) => c.includes('HttpOnly') && c.includes('SameSite=lax'))).toBe(true)
    // The token is only in the cookie, never in the body.
    expect(await res.text()).not.toContain('r-rotated')
  })

  it('the new cookie has Secure in production and not in development', async () => {
    backend((url) =>
      url.endsWith('/auth/refresh') ? Response.json(ROTATED) : Response.json({ data: { liked: true, count: 2 } }),
    )

    vi.stubEnv('NODE_ENV', 'production')
    // In production the session lives in the __Host- cookies (audit 031).
    const prod = await forwardToApi(
      request({ '__Host-access_token': STALE, '__Host-refresh_token': refreshToken() }),
      '/api/v1/posts/bai-viet/like',
      { method: 'GET' },
      'optional',
    )
    const prodCookies = prod.headers.getSetCookie()
    // The new pair, and the deletion of the two cookies of the old plain names.
    expect(prodCookies.map((c) => c.split('=')[0]).sort()).toEqual([
      '__Host-access_token',
      '__Host-refresh_token',
      'access_token',
      'refresh_token',
    ])
    expect(prodCookies.every((c) => c.includes('Secure'))).toBe(true)

    vi.stubEnv('NODE_ENV', 'development')
    const dev = await forwardToApi(
      request({ access_token: STALE, refresh_token: refreshToken() }),
      '/api/v1/posts/bai-viet/like',
      { method: 'GET' },
      'optional',
    )
    expect(dev.headers.getSetCookie()).toHaveLength(2)
    expect(dev.headers.getSetCookie().some((c) => c.includes('Secure'))).toBe(false)
  })

  it('the new pair is still set when the main call fails: the old token was already revoked by the backend', async () => {
    backend((url) => {
      if (url.endsWith('/auth/refresh')) return Response.json(ROTATED)
      throw new TypeError('fetch failed')
    })

    const res = await forwardToApi(
      request({ access_token: STALE, refresh_token: refreshToken() }),
      '/api/v1/posts/bai-viet/like',
      { method: 'PUT' },
      'required',
    )

    expect(res.status).toBe(502)
    expect(res.headers.getSetCookie().find((c) => c.startsWith('refresh_token='))).toContain('r-rotated')
  })

  it('revoked (lost a rotation race): goes on as an anonymous visitor and does NOT clear the cookie', async () => {
    backend((url) =>
      url.endsWith('/auth/refresh')
        ? Response.json({ error: { code: 'REFRESH_TOKEN_REVOKED', message: 'x' } }, { status: 401 })
        : Response.json({ data: { liked: false, count: 2 } }),
    )

    const optional = await forwardToApi(
      request({ access_token: STALE, refresh_token: refreshToken() }),
      '/api/v1/posts/bai-viet/like',
      { method: 'GET' },
      'optional',
    )
    expect(optional.status).toBe(200)
    // The winner's response is setting the new pair; clearing here would overwrite it.
    expect(optional.headers.getSetCookie()).toHaveLength(0)

    const required = await forwardToApi(
      request({ access_token: STALE, refresh_token: refreshToken() }),
      '/api/v1/posts/bai-viet/like',
      { method: 'PUT' },
      'required',
    )
    expect(required.status).toBe(401)
    expect(required.headers.getSetCookie()).toHaveLength(0)
  })

  it('rejected (expired, locked): clears both cookies', async () => {
    backend((url) =>
      url.endsWith('/auth/refresh')
        ? Response.json({ error: { code: 'REFRESH_TOKEN_EXPIRED', message: 'x' } }, { status: 401 })
        : Response.json({ data: { liked: false, count: 2 } }),
    )

    const res = await forwardToApi(
      request({ access_token: STALE, refresh_token: refreshToken() }),
      '/api/v1/posts/bai-viet/like',
      { method: 'GET' },
      'optional',
    )

    expect(res.status).toBe(200)
    const cookies = res.headers.getSetCookie()
    expect(cookies.map((c) => c.split('=')[0]).sort()).toEqual(['access_token', 'refresh_token'])
    expect(cookies.every((c) => c.includes('Max-Age=0'))).toBe(true)
  })
})

describe('forwardToApi: the visitor address goes with the refresh it triggers, not with ordinary calls', () => {
  function requestFrom(forwardedFor: string, cookies: Record<string, string>): NextRequest {
    const req = new NextRequest(`${ORIGIN}/api/posts/bai-viet/comments`, { headers: { 'x-forwarded-for': forwardedFor } })
    for (const [name, value] of Object.entries(cookies)) req.cookies.set(name, value)
    return req
  }

  it('an expired access token is refreshed with the address counted from the right of X-Forwarded-For and the shared token', async () => {
    vi.stubEnv('CLIENT_IP_TOKEN', '  bff-token-for-tests  ')
    const fetchSpy = backend((url) =>
      url.endsWith('/auth/refresh') ? Response.json(ROTATED) : Response.json({ data: { liked: true, count: 3 } }),
    )

    await forwardToApi(
      requestFrom('6.6.6.6, 198.51.100.81', { access_token: STALE, refresh_token: refreshToken() }),
      '/api/v1/posts/bai-viet/like',
      { method: 'GET' },
      'optional',
    )

    const refresh = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/auth/refresh'))!
    const headers = new Headers(refresh[1]?.headers)
    expect(headers.get('x-client-ip')).toBe('198.51.100.81')
    expect(headers.get('x-client-ip-token')).toBe('bff-token-for-tests')
    expect([...headers.values()]).not.toContain('6.6.6.6')

    // The ordinary call that follows carries a Bearer and has no per-address limit at the backend: no address header.
    const ordinary = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/posts/bai-viet/like'))!
    const ordinaryHeaders = new Headers(ordinary[1]?.headers)
    expect(ordinaryHeaders.has('x-client-ip')).toBe(false)
    expect(ordinaryHeaders.has('x-client-ip-token')).toBe(false)
  })
})
