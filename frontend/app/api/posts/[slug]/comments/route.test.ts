// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET, POST } from './route'

/*
 * The route handler is called directly with a NextRequest and context; the fetch to the backend is fake. Each test uses its own
 * refresh token: the memo in lib/session-refresh.ts survives across tests.
 */

const ORIGIN = 'http://localhost:3000'
const CURSOR = Buffer.from('1759900000000000:0b9a5a4e-7c1d-4f7e-8f52-3c1e2d9a6b10').toString('base64url')

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
  return `r-comments-${counter}-${Math.random().toString(36).slice(2)}`
}

type Options = {
  slug?: string
  query?: string
  /** Default: a session that is still valid. */
  cookies?: Record<string, string>
  headers?: Record<string, string>
  body?: string
}

function request(method: string, { slug = 'bai-viet', query = '', cookies, headers = {}, body }: Options): NextRequest {
  const req = new NextRequest(`${ORIGIN}/api/posts/${encodeURIComponent(slug)}/comments${query}`, {
    method,
    headers:
      method === 'GET'
        ? headers
        : {
            host: 'localhost:3000',
            origin: ORIGIN,
            'sec-fetch-site': 'same-origin',
            'content-type': 'application/json',
            ...headers,
          },
    body,
  })
  for (const [name, value] of Object.entries(cookies ?? { access_token: FRESH, refresh_token: refreshToken() })) {
    req.cookies.set(name, value)
  }
  return req
}

function list(options: Options = {}) {
  return GET(request('GET', options), { params: Promise.resolve({ slug: options.slug ?? 'bai-viet' }) })
}

function create(options: Options = {}) {
  const body = options.body ?? JSON.stringify({ content: 'Great article!' })
  return POST(request('POST', { ...options, body }), { params: Promise.resolve({ slug: options.slug ?? 'bai-viet' }) })
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

const PAGE = { data: { threads: [], nextCursor: null } }

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('GET /api/posts/[slug]/comments (auth optional)', () => {
  it('first page: fixed size=10, no after; a guest has no Bearer; private no-store', async () => {
    vi.stubEnv('API_BASE_URL', 'http://backend.test:8080')
    const fetchSpy = backend(() => Response.json(PAGE))

    const res = await list({ cookies: {} })

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toEqual(PAGE)
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(String(url)).toBe('http://backend.test:8080/api/v1/posts/bai-viet/comments?size=10')
    expect(init).toMatchObject({ method: 'GET', cache: 'no-store' })
    expect(authOf(init)).toBeNull()
  })

  it('later page: forwards after, size stays 10 even if the client asks for another', async () => {
    const fetchSpy = backend(() => Response.json(PAGE))

    await list({ query: `?after=${CURSOR}&size=500&x=1` })

    const url = new URL(String(fetchSpy.mock.calls[0]![0]))
    expect(url.pathname).toBe('/api/v1/posts/bai-viet/comments')
    expect([...url.searchParams]).toEqual([
      ['after', CURSOR],
      ['size', '10'],
    ])
  })

  it('logged in: sends Bearer so the backend computes `mine`', async () => {
    const fetchSpy = backend(() => Response.json(PAGE))

    await list()

    expect(authOf(fetchSpy.mock.calls[0]![1])).toBe(`Bearer ${FRESH}`)
  })

  it.each([
    ['empty after', '?after='],
    ['after with characters outside base64url', '?after=abc%2Bdef'],
    ['after with an injected parameter', '?after=abc%26size%3D500'],
    ['after longer than 200', `?after=${'a'.repeat(201)}`],
  ])('%s: 400 VALIDATION_ERROR without calling the backend', async (_label, query) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await list({ query })

    expect(res.status).toBe(400)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each([['a/b'], ['..'], ['a'.repeat(256)]])('slug %j: 400 without calling the backend', async (slug) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await list({ slug })

    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('backend 404 POST_NOT_FOUND and 400 for a malformed cursor pass the code through unchanged', async () => {
    backend(() => apiError(404, 'POST_NOT_FOUND'))
    const missing = await list({ cookies: {} })
    expect(missing.status).toBe(404)
    await expect(missing.json()).resolves.toMatchObject({ error: { code: 'POST_NOT_FOUND' } })

    backend(() => apiError(400, 'VALIDATION_ERROR'))
    const badCursor = await list({ cookies: {}, query: '?after=QUFB' })
    expect(badCursor.status).toBe(400)
  })
})

describe('POST /api/posts/[slug]/comments (auth required)', () => {
  it('201: forwards the JSON body unchanged with Bearer, returns the backend envelope unchanged', async () => {
    const created = {
      data: {
        id: '0b9a5a4e-7c1d-4f7e-8f52-3c1e2d9a6b10',
        status: 'VISIBLE',
        content: 'Great article!',
        author: { displayName: 'Tracy Reader', githubLogin: 'doc-gia', avatarUrl: null, siteOwner: false },
        createdAt: '2026-10-08T03:00:00Z',
        edited: false,
        mine: true,
      },
    }
    const fetchSpy = backend(() => Response.json(created, { status: 201 }))

    const res = await create()

    expect(res.status).toBe(201)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toEqual(created)
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(new URL(String(url)).pathname).toBe('/api/v1/posts/bai-viet/comments')
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ content: 'Great article!' }) })
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json')
    expect(authOf(init)).toBe(`Bearer ${FRESH}`)
  })

  it.each([
    ['Sec-Fetch-Site: cross-site', { 'sec-fetch-site': 'cross-site' }],
    ['Sec-Fetch-Site: same-site', { 'sec-fetch-site': 'same-site' }],
    ['Origin of another site', { origin: 'https://evil.example' }],
    ['Origin "null"', { origin: 'null' }],
  ])('%s: 403 FORBIDDEN, the backend is not called, cookies unchanged', async (_label, headers) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await create({ cookies: { access_token: STALE, refresh_token: refreshToken() }, headers })

    expect(res.status).toBe(403)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'FORBIDDEN' } })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(res.headers.getSetCookie()).toHaveLength(0)
  })

  it.each(['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x'])(
    'content-type %s (a cross-site form can send it): 415',
    async (type) => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')

      const res = await create({ headers: { 'content-type': type } })

      expect(res.status).toBe(415)
      expect(fetchSpy).not.toHaveBeenCalled()
    },
  )

  it('a 20 KB body gives 413 PAYLOAD_TOO_LARGE, even without a declared content-length', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const body = JSON.stringify({ content: 'x'.repeat(20_000) })

    const res = await create({ body })

    expect(res.status).toBe(413)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('no session: 401 UNAUTHENTICATED without calling the backend', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await create({ cookies: {} })

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'UNAUTHENTICATED' } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each([
    [400, 'VALIDATION_ERROR'],
    [403, 'USER_SUSPENDED'],
    [404, 'POST_NOT_FOUND'],
    [409, 'COMMENT_DUPLICATE'],
    [429, 'RATE_LIMITED'],
  ])('backend %i %s: status and code pass through unchanged, not cached', async (status, code) => {
    backend(() => apiError(status, code))

    const res = await create()

    expect(res.status).toBe(status)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toMatchObject({ error: { code } })
  })

  it('backend 401 even though the token is valid (revoked): refreshes once, retries once, still 401 returns 401 with the new cookie pair', async () => {
    const body = JSON.stringify({ content: 'Great article!' })
    const fetchSpy = backend((url) =>
      url.endsWith('/auth/refresh')
        ? Response.json({ data: { accessToken: ROTATED, refreshToken: 'r-rotated', expiresIn: 900 } })
        : apiError(401, 'UNAUTHENTICATED'),
    )

    const res = await create({ body })

    expect(res.status).toBe(401)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'UNAUTHENTICATED' } })
    // Exactly one refresh, exactly one retry, same body: the 401 comes from the Bearer filter, the controller has not run.
    expect(fetchSpy.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/api/v1/posts/bai-viet/comments',
      '/api/v1/auth/refresh',
      '/api/v1/posts/bai-viet/comments',
    ])
    expect(authOf(fetchSpy.mock.calls[0]![1])).toBe(`Bearer ${FRESH}`)
    expect(authOf(fetchSpy.mock.calls[2]![1])).toBe(`Bearer ${ROTATED}`)
    expect(fetchSpy.mock.calls[2]![1]).toMatchObject({ method: 'POST', body })
    // The backend revoked the old refresh token when rotating: the new pair must still reach the browser.
    const cookies = res.headers.getSetCookie()
    expect(cookies.find((c) => c.startsWith('access_token='))).toContain(ROTATED)
    expect(cookies.find((c) => c.startsWith('refresh_token='))).toContain('r-rotated')
  })

  it('expired access token: refreshes, posts with the new token, and sets the new cookie pair', async () => {
    const fetchSpy = backend((url) =>
      url.endsWith('/auth/refresh')
        ? Response.json({ data: { accessToken: ROTATED, refreshToken: 'r-rotated', expiresIn: 900 } })
        : Response.json({ data: { id: 'c1' } }, { status: 201 }),
    )

    const res = await create({ cookies: { access_token: STALE, refresh_token: refreshToken() } })

    expect(res.status).toBe(201)
    expect(authOf(fetchSpy.mock.calls[1]![1])).toBe(`Bearer ${ROTATED}`)
    const cookies = res.headers.getSetCookie()
    expect(cookies.find((c) => c.startsWith('access_token='))).toContain(ROTATED)
    expect(cookies.find((c) => c.startsWith('refresh_token='))).toContain('r-rotated')
    // The token lives only in the cookie, never in the body.
    expect(await res.text()).not.toContain('r-rotated')
  })

  it('a malformed slug gives 400 without reading the body or calling the backend', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const req = request('POST', { slug: 'a/b', body: JSON.stringify({ content: 'Great article!' }) })

    const res = await POST(req, { params: Promise.resolve({ slug: 'a/b' }) })

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
    expect(req.bodyUsed).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
