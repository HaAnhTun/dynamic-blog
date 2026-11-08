// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { DELETE, PUT } from './route'

/*
 * The route handler is called directly with a NextRequest and context; the fetch to the backend is fake. Each test uses its own
 * refresh token: the memo in lib/session-refresh.ts survives across tests.
 */

const ORIGIN = 'http://localhost:3000'
const ID = '0b9a5a4e-7c1d-4f7e-8f52-3c1e2d9a6b10'

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function jwt(secondsFromNow: number, tag: string): string {
  const exp = Math.floor(Date.now() / 1000) + secondsFromNow
  return `${b64url({ alg: 'HS256' })}.${b64url({ sub: 'u1', role: 'USER', exp, tag })}.sig`
}

const FRESH = jwt(600, 'fresh')
const STALE = jwt(-60, 'stale')
const ROTATED = jwt(900, 'rotated')

let counter = 0
function refreshToken(): string {
  counter += 1
  return `r-comment-like-${counter}-${Math.random().toString(36).slice(2)}`
}

type Handler = typeof PUT
type Options = {
  id?: string
  /** Default: a session that is still valid. */
  cookies?: Record<string, string>
  headers?: Record<string, string>
  body?: string
}

/** A same-origin fetch as callBff sends it: Sec-Fetch-Site, Origin, and JSON for PUT. */
function call(handler: Handler, method: 'PUT' | 'DELETE', { id = ID, cookies, headers = {}, body }: Options = {}) {
  const request = new NextRequest(`${ORIGIN}/api/comments/${encodeURIComponent(id)}/like`, {
    method,
    headers: {
      host: 'localhost:3000',
      origin: ORIGIN,
      'sec-fetch-site': 'same-origin',
      ...(method === 'PUT' ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body,
  })
  for (const [name, value] of Object.entries(cookies ?? { access_token: FRESH, refresh_token: refreshToken() })) {
    request.cookies.set(name, value)
  }
  return handler(request, { params: Promise.resolve({ id }) })
}

type Route = (url: string, init: RequestInit) => Response | Promise<Response>

function backend(route: Route) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => route(String(input), init ?? {}))
}

function authOf(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get('authorization')
}

function apiError(status: number, code: string): Response {
  return Response.json({ error: { code, message: 'English text for API callers' } }, { status })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('PUT /api/comments/[id]/like (like)', () => {
  it('calls PUT /api/v1/comments/{id}/like with Bearer and no body, returns the server { liked, count } unchanged', async () => {
    vi.stubEnv('API_BASE_URL', 'http://backend.test:8080')
    const fetchSpy = backend(() => Response.json({ data: { liked: true, count: 5 } }))

    const res = await call(PUT, 'PUT')

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toEqual({ data: { liked: true, count: 5 } })
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(String(url)).toBe(`http://backend.test:8080/api/v1/comments/${ID}/like`)
    expect(init).toMatchObject({ method: 'PUT', cache: 'no-store' })
    expect(init?.body).toBeUndefined()
    expect(authOf(init)).toBe(`Bearer ${FRESH}`)
    // No refresh means the cookies are untouched.
    expect(res.headers.getSetCookie()).toHaveLength(0)
  })

  it('a foreign body (fake userId, liked) never reaches the backend', async () => {
    const fetchSpy = backend(() => Response.json({ data: { liked: true, count: 1 } }))

    await call(PUT, 'PUT', { body: JSON.stringify({ userId: 'someone-else', liked: false }) })

    expect(fetchSpy.mock.calls[0]![1]?.body).toBeUndefined()
  })

  it('a non-JSON PUT (a cross-site form) gives 415 and the backend is not called', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await call(PUT, 'PUT', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1' })

    expect(res.status).toBe(415)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'UNSUPPORTED_MEDIA_TYPE' } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('expired access token: refreshes, likes with the new token, and sets the new cookie pair', async () => {
    const fetchSpy = backend((url) =>
      url.endsWith('/auth/refresh')
        ? Response.json({ data: { accessToken: ROTATED, refreshToken: 'r-rotated', expiresIn: 900 } })
        : Response.json({ data: { liked: true, count: 9 } }),
    )

    const res = await call(PUT, 'PUT', { cookies: { access_token: STALE, refresh_token: refreshToken() } })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ data: { liked: true, count: 9 } })
    expect(fetchSpy.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/api/v1/auth/refresh',
      `/api/v1/comments/${ID}/like`,
    ])
    expect(authOf(fetchSpy.mock.calls[1]![1])).toBe(`Bearer ${ROTATED}`)
    const cookies = res.headers.getSetCookie()
    expect(cookies.find((c) => c.startsWith('access_token='))).toContain(ROTATED)
    expect(cookies.find((c) => c.startsWith('refresh_token='))).toContain('r-rotated')
    expect(cookies.every((c) => c.includes('HttpOnly'))).toBe(true)
  })
})

describe('DELETE /api/comments/[id]/like (unlike)', () => {
  it('calls DELETE on the backend with no body, returns the server { liked: false, count }', async () => {
    const fetchSpy = backend(() => Response.json({ data: { liked: false, count: 4 } }))

    const res = await call(DELETE, 'DELETE')

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toEqual({ data: { liked: false, count: 4 } })
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(new URL(String(url)).pathname).toBe(`/api/v1/comments/${ID}/like`)
    expect(init).toMatchObject({ method: 'DELETE' })
    expect(init?.body).toBeUndefined()
  })
})

describe.each([
  ['PUT', PUT],
  ['DELETE', DELETE],
] as const)('%s /api/comments/[id]/like: shared checks', (method, handler) => {
  it.each([
    ['Sec-Fetch-Site: cross-site', { 'sec-fetch-site': 'cross-site' }],
    ['Sec-Fetch-Site: same-site', { 'sec-fetch-site': 'same-site' }],
    // The Origin layer stands alone: old browsers do not send Sec-Fetch-Site.
    ['Origin of another site', { origin: 'https://evil.example' }],
  ])('%s: 403 FORBIDDEN, the backend is not called, cookies unchanged', async (_label, headers) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await call(handler, method, { cookies: { access_token: STALE, refresh_token: refreshToken() }, headers })

    expect(res.status).toBe(403)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'FORBIDDEN' } })
    // Even the refresh: a cross-site request must not rotate the reader token.
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(res.headers.getSetCookie()).toHaveLength(0)
  })

  it.each(['abc', `${ID}x`, ID.replace(/-/g, ''), '..', `${ID}/../../posts/x`])(
    'id %j is not a UUID: 400 VALIDATION_ERROR without calling the backend',
    async (id) => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')

      const res = await call(handler, method, { id })

      expect(res.status).toBe(400)
      expect(res.headers.get('cache-control')).toBe('private, no-store')
      await expect(res.json()).resolves.toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
      expect(fetchSpy).not.toHaveBeenCalled()
    },
  )

  it('a malformed id on a cross-site request: 403 first, nothing leaks about the parameter', async () => {
    const res = await call(handler, method, { id: '..', headers: { 'sec-fetch-site': 'cross-site' } })

    expect(res.status).toBe(403)
  })

  it('a 20 KB body gives 413 PAYLOAD_TOO_LARGE and the backend is not called', async () => {
    // The body is not forwarded but is still read under the 16 KB cap: every write route gives the same 413.
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await call(handler, method, { body: JSON.stringify({ pad: 'x'.repeat(20_000) }) })

    expect(res.status).toBe(413)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('no session: 401 UNAUTHENTICATED without calling the backend', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await call(handler, method, { cookies: {} })

    expect(res.status).toBe(401)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'UNAUTHENTICATED' } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each([
    [400, 'VALIDATION_ERROR'],
    [403, 'USER_SUSPENDED'],
    [404, 'COMMENT_NOT_FOUND'],
    [429, 'RATE_LIMITED'],
    // An older backend (not restarted yet) lacks this endpoint: its `denyAll` passes through intact.
    [403, 'FORBIDDEN'],
  ])('backend %i %s: status and code pass through unchanged', async (status, code) => {
    backend(() => apiError(status, code))

    const res = await call(handler, method)

    expect(res.status).toBe(status)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toMatchObject({ error: { code } })
  })

  it('backend 401 even though the token is valid (revoked): refreshes once, retries once, still 401 returns 401 with the new cookie pair', async () => {
    const fetchSpy = backend((url) =>
      url.endsWith('/auth/refresh')
        ? Response.json({ data: { accessToken: ROTATED, refreshToken: 'r-rotated', expiresIn: 900 } })
        : apiError(401, 'UNAUTHENTICATED'),
    )

    const res = await call(handler, method)

    expect(res.status).toBe(401)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'UNAUTHENTICATED' } })
    expect(fetchSpy.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      `/api/v1/comments/${ID}/like`,
      '/api/v1/auth/refresh',
      `/api/v1/comments/${ID}/like`,
    ])
    const retry = fetchSpy.mock.calls[2]![1]
    expect(authOf(retry)).toBe(`Bearer ${ROTATED}`)
    // The retry is identical to the first attempt: same method, still no body.
    expect(retry).toMatchObject({ method })
    expect(retry?.body).toBeUndefined()
    const cookies = res.headers.getSetCookie()
    expect(cookies.find((c) => c.startsWith('access_token='))).toContain(ROTATED)
    expect(cookies.find((c) => c.startsWith('refresh_token='))).toContain('r-rotated')
  })
})
