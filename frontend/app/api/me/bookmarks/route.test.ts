// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from './route'
import { msg } from '@/test/render-intl'

/* Like app/api/notifications/route.test.ts: the route is called directly, the fetch to the backend is fake, each test uses its own refresh token. */

const ORIGIN = 'http://localhost:3000'

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function jwt(secondsFromNow: number, tag: string): string {
  const exp = Math.floor(Date.now() / 1000) + secondsFromNow
  return `${b64url({ alg: 'HS256' })}.${b64url({ sub: 'u1', role: 'USER', exp, tag })}.sig`
}

const FRESH = jwt(600, 'fresh')

let counter = 0
function refreshToken(): string {
  counter += 1
  return `r-bookmarks-${counter}-${Math.random().toString(36).slice(2)}`
}

type Options = {
  query?: string
  /** Default: a session that is still valid. */
  cookies?: Record<string, string>
  headers?: Record<string, string>
}

function list({ query = '', cookies, headers = {} }: Options = {}) {
  const request = new NextRequest(`${ORIGIN}/api/me/bookmarks${query}`, { headers })
  for (const [name, value] of Object.entries(cookies ?? { access_token: FRESH, refresh_token: refreshToken() })) {
    request.cookies.set(name, value)
  }
  return GET(request)
}

type Route = (url: string, init: RequestInit) => Response | Promise<Response>

function backend(route: Route) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => route(String(input), init ?? {}))
}

/** The exact backend `PagedResponse` envelope: `pagination` sits next to `data` and must pass through intact. */
const PAGE = {
  data: [{ id: 'p1', slug: 'bai-viet', title: msg('Site.about.readNextLinks.writing'), tags: [] }],
  pagination: { page: 0, size: 20, totalElements: 1, totalPages: 1 },
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('GET /api/me/bookmarks (auth required)', () => {
  it('forwards the validated page and size to the backend with Bearer; the envelope passes through intact, private no-store', async () => {
    vi.stubEnv('API_BASE_URL', 'http://backend.test:8080')
    const fetchSpy = backend(() => Response.json(PAGE))

    const res = await list({ query: '?page=2&size=20' })

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toEqual(PAGE)
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(String(url)).toBe('http://backend.test:8080/api/v1/me/bookmarks?page=2&size=20')
    expect(init).toMatchObject({ method: 'GET', cache: 'no-store' })
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${FRESH}`)
  })

  it('no parameters: the exact path, no query (the backend uses its defaults)', async () => {
    const fetchSpy = backend(() => Response.json(PAGE))

    await list()

    const url = new URL(String(fetchSpy.mock.calls[0]![0]))
    expect(url.pathname).toBe('/api/v1/me/bookmarks')
    expect(url.search).toBe('')
  })

  it('the query is rebuilt only from validated values: unknown parameters are dropped, "007" becomes "7", "06" becomes "6"', async () => {
    const fetchSpy = backend(() => Response.json(PAGE))

    await list({ query: '?size=06&userId=someone-else&page=007&sort=title' })

    expect([...new URL(String(fetchSpy.mock.calls[0]![0])).searchParams]).toEqual([
      ['page', '7'],
      ['size', '6'],
    ])
  })

  it.each([
    ['negative page', '?page=-1'],
    ['decimal page', '?page=1.5'],
    ['non-numeric page', '?page=abc'],
    ['empty page', '?page='],
    ['seven-digit page', '?page=1000000'],
    ['page injecting an extra parameter', '?page=1%26size%3D500'],
    ['size 0', '?size=0'],
    ['size 51', '?size=51'],
    ['three-digit size', '?size=100'],
    ['non-numeric size', '?size=abc'],
    ['empty size', '?size='],
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

  it('backend 403 USER_SUSPENDED passes status and code through unchanged', async () => {
    backend(() => Response.json({ error: { code: 'USER_SUSPENDED', message: 'Suspended' } }, { status: 403 }))

    const res = await list()

    expect(res.status).toBe(403)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'USER_SUSPENDED' } })
  })

  it('backend does not answer: 502 UPSTREAM_UNAVAILABLE', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))

    const res = await list()

    expect(res.status).toBe(502)
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'UPSTREAM_UNAVAILABLE' } })
  })
})
