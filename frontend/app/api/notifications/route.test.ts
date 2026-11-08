// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from './route'

/*
 * The route handler is called directly with a NextRequest; the fetch to the backend is fake. Each test uses its own refresh token:
 * the memo in lib/session-refresh.ts survives across tests.
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
  return `r-notifications-${counter}-${Math.random().toString(36).slice(2)}`
}

type Options = {
  query?: string
  /** Default: a session that is still valid. */
  cookies?: Record<string, string>
  headers?: Record<string, string>
}

function list({ query = '', cookies, headers = {} }: Options = {}) {
  const request = new NextRequest(`${ORIGIN}/api/notifications${query}`, { headers })
  for (const [name, value] of Object.entries(cookies ?? { access_token: FRESH, refresh_token: refreshToken() })) {
    request.cookies.set(name, value)
  }
  return GET(request)
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

const PAGE = { data: { items: [], nextCursor: null, headCursor: null } }

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('GET /api/notifications (auth required)', () => {
  it('forwards the validated size, after and unread to the backend with Bearer; private no-store', async () => {
    vi.stubEnv('API_BASE_URL', 'http://backend.test:8080')
    const fetchSpy = backend(() => Response.json(PAGE))

    const res = await list({ query: `?after=${CURSOR}&size=20&unread=true` })

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toEqual(PAGE)
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(String(url)).toBe(`http://backend.test:8080/api/v1/notifications?after=${CURSOR}&size=20&unread=true`)
    expect(init).toMatchObject({ method: 'GET', cache: 'no-store' })
    expect(init?.body).toBeUndefined()
    expect(authOf(init)).toBe(`Bearer ${FRESH}`)
    expect(res.headers.getSetCookie()).toHaveLength(0)
  })

  it('no parameters: the exact path, no query (the backend defaults to 20)', async () => {
    const fetchSpy = backend(() => Response.json(PAGE))

    await list()

    const url = new URL(String(fetchSpy.mock.calls[0]![0]))
    expect(url.pathname).toBe('/api/v1/notifications')
    expect(url.search).toBe('')
  })

  it('the query is rebuilt only from validated values: unknown parameters are dropped, "06" becomes "6"', async () => {
    const fetchSpy = backend(() => Response.json(PAGE))

    await list({ query: '?size=06&unread=false&userId=someone-else&x=1' })

    const url = new URL(String(fetchSpy.mock.calls[0]![0]))
    expect([...url.searchParams]).toEqual([
      ['size', '6'],
      ['unread', 'false'],
    ])
  })

  it.each([1, 6, 20, 50])('size=%i is accepted', async (size) => {
    const fetchSpy = backend(() => Response.json(PAGE))

    const res = await list({ query: `?size=${size}` })

    expect(res.status).toBe(200)
    expect(new URL(String(fetchSpy.mock.calls[0]![0])).searchParams.get('size')).toBe(String(size))
  })

  it.each([
    ['empty after', '?after='],
    ['after with characters outside base64url', '?after=abc%2Bdef'],
    ['after with an injected parameter', '?after=abc%26size%3D500'],
    ['after longer than 200', `?after=${'a'.repeat(201)}`],
    ['size 0', '?size=0'],
    ['size 51', '?size=51'],
    ['size with three digits', '?size=100'],
    ['size that is not a number', '?size=abc'],
    ['decimal size', '?size=1.5'],
    ['negative size', '?size=-1'],
    ['empty size', '?size='],
    ['unknown unread value', '?unread=yes'],
    ['upper-case unread value', '?unread=TRUE'],
    ['empty unread', '?unread='],
  ])('%s: 400 VALIDATION_ERROR without calling the backend', async (_label, query) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await list({ query })

    expect(res.status).toBe(400)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('no session: 401 UNAUTHENTICATED without calling the backend', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await list({ cookies: {} })

    expect(res.status).toBe(401)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'UNAUTHENTICATED' } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('GET does not require same-origin headers: reading changes nothing', async () => {
    backend(() => Response.json(PAGE))

    const res = await list({ headers: { 'sec-fetch-site': 'cross-site' } })

    expect(res.status).toBe(200)
  })

  it('expired access token: refreshes, reads with the new token, sets the new cookie pair', async () => {
    const fetchSpy = backend((url) =>
      url.endsWith('/auth/refresh')
        ? Response.json({ data: { accessToken: ROTATED, refreshToken: 'r-rotated', expiresIn: 900 } })
        : Response.json(PAGE),
    )

    const res = await list({ cookies: { access_token: STALE, refresh_token: refreshToken() } })

    expect(res.status).toBe(200)
    expect(fetchSpy.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/api/v1/auth/refresh',
      '/api/v1/notifications',
    ])
    expect(authOf(fetchSpy.mock.calls[1]![1])).toBe(`Bearer ${ROTATED}`)
    const cookies = res.headers.getSetCookie()
    expect(cookies.find((c) => c.startsWith('access_token='))).toContain(ROTATED)
    expect(cookies.find((c) => c.startsWith('refresh_token='))).toContain('r-rotated')
  })

  it.each([
    [400, 'VALIDATION_ERROR'],
    [403, 'USER_SUSPENDED'],
    // An older backend (not restarted yet) lacks this endpoint: its `denyAll` passes through intact.
    [403, 'FORBIDDEN'],
  ])('backend %i %s: status and code pass through unchanged', async (status, code) => {
    backend(() => apiError(status, code))

    const res = await list()

    expect(res.status).toBe(status)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toMatchObject({ error: { code } })
  })

  it('backend does not answer: 502 UPSTREAM_UNAVAILABLE', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))

    const res = await list()

    expect(res.status).toBe(502)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'UPSTREAM_UNAVAILABLE' } })
  })
})
