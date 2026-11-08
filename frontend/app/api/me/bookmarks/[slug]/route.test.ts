// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { DELETE, GET, PUT } from './route'
import { ACCENTED_SLUG } from '@/test/fixtures/vi/accented-bookmark-slug'

/*
 * Like app/api/posts/[slug]/like/route.test.ts: the route is called directly, the fetch to the backend is fake, each test uses its own refresh
 * token (the memo in lib/session-refresh.ts survives across tests).
 */

const ORIGIN = 'http://localhost:3000'

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
  return `r-bookmark-${counter}-${Math.random().toString(36).slice(2)}`
}

type Handler = typeof GET
type Options = {
  slug?: string
  /** Default: a session that is still valid. */
  cookies?: Record<string, string>
  headers?: Record<string, string>
  body?: string
}

/** A same-origin fetch as callBff sends it: Sec-Fetch-Site, Origin, and JSON for PUT. */
function call(handler: Handler, method: string, { slug = 'bai-viet', cookies, headers = {}, body }: Options = {}) {
  const request = new NextRequest(`${ORIGIN}/api/me/bookmarks/${encodeURIComponent(slug)}`, {
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
  return handler(request, { params: Promise.resolve({ slug }) })
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

describe('GET /api/me/bookmarks/[slug] (auth required)', () => {
  it('sends Bearer, returns the backend { data: { bookmarked } } unchanged, private no-store', async () => {
    vi.stubEnv('API_BASE_URL', 'http://backend.test:8080')
    const fetchSpy = backend(() => Response.json({ data: { bookmarked: true } }))

    const res = await call(GET, 'GET')

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toEqual({ data: { bookmarked: true } })
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(String(url)).toBe('http://backend.test:8080/api/v1/me/bookmarks/bai-viet')
    expect(init).toMatchObject({ method: 'GET', cache: 'no-store' })
    expect(authOf(init)).toBe(`Bearer ${FRESH}`)
  })

  it('no session: 401 UNAUTHENTICATED without calling the backend (unlike likes: there is no guest version)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await call(GET, 'GET', { cookies: {} })

    expect(res.status).toBe(401)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'UNAUTHENTICATED' } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('GET does not need same origin: reading changes nothing', async () => {
    backend(() => Response.json({ data: { bookmarked: false } }))

    const res = await call(GET, 'GET', { headers: { 'sec-fetch-site': 'cross-site' } })

    expect(res.status).toBe(200)
  })

  it('an accented slug is encoded in the backend URL', async () => {
    const fetchSpy = backend(() => Response.json({ data: { bookmarked: false } }))

    await call(GET, 'GET', { slug: ACCENTED_SLUG })

    expect(new URL(String(fetchSpy.mock.calls[0]![0])).pathname).toBe('/api/v1/me/bookmarks/xin-ch%C3%A0o')
  })

  it.each([
    ['empty', ''],
    ['with a "/"', 'a/b'],
    ['"."', '.'],
    ['".."', '..'],
    ['longer than 255 characters', 'a'.repeat(256)],
  ])('slug %s: 400 VALIDATION_ERROR without calling the backend', async (_label, slug) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await call(GET, 'GET', { slug })

    expect(res.status).toBe(400)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each([
    [403, 'USER_SUSPENDED'],
    [404, 'POST_NOT_FOUND'],
  ])('backend %i %s: status and code pass through unchanged', async (status, code) => {
    backend(() => apiError(status, code))

    const res = await call(GET, 'GET')

    expect(res.status).toBe(status)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toMatchObject({ error: { code } })
  })
})

describe('PUT and DELETE /api/me/bookmarks/[slug] (auth required)', () => {
  it('PUT: calls PUT on the backend with Bearer and no body, returns the server { bookmarked: true }', async () => {
    const fetchSpy = backend(() => Response.json({ data: { bookmarked: true } }))

    const res = await call(PUT, 'PUT')

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toEqual({ data: { bookmarked: true } })
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(new URL(String(url)).pathname).toBe('/api/v1/me/bookmarks/bai-viet')
    expect(init).toMatchObject({ method: 'PUT', cache: 'no-store' })
    expect(init?.body).toBeUndefined()
    expect(authOf(init)).toBe(`Bearer ${FRESH}`)
    expect(res.headers.getSetCookie()).toHaveLength(0)
  })

  it('DELETE: calls DELETE on the backend, returns the server { bookmarked: false }', async () => {
    const fetchSpy = backend(() => Response.json({ data: { bookmarked: false } }))

    const res = await call(DELETE, 'DELETE')

    await expect(res.json()).resolves.toEqual({ data: { bookmarked: false } })
    expect(fetchSpy.mock.calls[0]![1]).toMatchObject({ method: 'DELETE' })
  })

  it('a foreign body (another user userId) never reaches the backend', async () => {
    const fetchSpy = backend(() => Response.json({ data: { bookmarked: true } }))

    await call(PUT, 'PUT', { body: JSON.stringify({ userId: 'someone-else', bookmarked: false }) })

    expect(fetchSpy.mock.calls[0]![1]?.body).toBeUndefined()
  })

  it.each([
    ['PUT, Sec-Fetch-Site: cross-site', PUT, 'PUT', { 'sec-fetch-site': 'cross-site' }],
    ['PUT, Origin of another site', PUT, 'PUT', { origin: 'https://evil.example' }],
    ['DELETE, Sec-Fetch-Site: same-site', DELETE, 'DELETE', { 'sec-fetch-site': 'same-site' }],
    ['DELETE, Origin of another site', DELETE, 'DELETE', { origin: 'https://evil.example' }],
  ])('%s: 403 FORBIDDEN, the backend is not called, cookies unchanged', async (_label, handler, method, headers) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await call(handler, method, { cookies: { access_token: STALE, refresh_token: refreshToken() }, headers })

    expect(res.status).toBe(403)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'FORBIDDEN' } })
    // Even the refresh: a cross-site request must not rotate the reader token.
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(res.headers.getSetCookie()).toHaveLength(0)
  })

  it('a non-JSON PUT (a cross-site form) gives 415', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await call(PUT, 'PUT', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1' })

    expect(res.status).toBe(415)
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'UNSUPPORTED_MEDIA_TYPE' } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a body over 16 KB gives 413 PAYLOAD_TOO_LARGE', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await call(PUT, 'PUT', { body: JSON.stringify({ pad: 'x'.repeat(20_000) }) })

    expect(res.status).toBe(413)
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each([
    ['PUT', PUT],
    ['DELETE', DELETE],
  ])('%s with no session: 401 UNAUTHENTICATED without calling the backend', async (method, handler) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await call(handler, method, { cookies: {} })

    expect(res.status).toBe(401)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'UNAUTHENTICATED' } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each([
    [401, 'UNAUTHENTICATED'],
    [403, 'USER_SUSPENDED'],
    [404, 'POST_NOT_FOUND'],
    [429, 'RATE_LIMITED'],
  ])('backend %i %s: status and code pass through unchanged', async (status, code) => {
    // This 401 comes after one refresh and one retry: the backend still refuses.
    backend((url) =>
      url.endsWith('/auth/refresh')
        ? Response.json({ data: { accessToken: ROTATED, refreshToken: 'r-rotated', expiresIn: 900 } })
        : apiError(status, code),
    )

    const res = await call(PUT, 'PUT')

    expect(res.status).toBe(status)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toMatchObject({ error: { code } })
  })

  it('expired access token: refreshes, saves with the new token, and sets the new cookie pair', async () => {
    const fetchSpy = backend((url) =>
      url.endsWith('/auth/refresh')
        ? Response.json({ data: { accessToken: ROTATED, refreshToken: 'r-rotated', expiresIn: 900 } })
        : Response.json({ data: { bookmarked: true } }),
    )

    const res = await call(PUT, 'PUT', { cookies: { access_token: STALE, refresh_token: refreshToken() } })

    expect(res.status).toBe(200)
    expect(fetchSpy.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/api/v1/auth/refresh',
      '/api/v1/me/bookmarks/bai-viet',
    ])
    expect(authOf(fetchSpy.mock.calls[1]![1])).toBe(`Bearer ${ROTATED}`)
    const cookies = res.headers.getSetCookie()
    expect(cookies.find((c) => c.startsWith('access_token='))).toContain(ROTATED)
    expect(cookies.find((c) => c.startsWith('refresh_token='))).toContain('r-rotated')
  })

  it('a malformed slug gives 400 after the origin check, before calling the backend', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await call(DELETE, 'DELETE', { slug: '..' })

    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
