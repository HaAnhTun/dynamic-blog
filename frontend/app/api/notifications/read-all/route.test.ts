// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from './route'

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

let counter = 0
function refreshToken(): string {
  counter += 1
  return `r-read-all-${counter}-${Math.random().toString(36).slice(2)}`
}

type Options = {
  query?: string
  cookies?: Record<string, string>
  headers?: Record<string, string>
  body?: string
}

/** A same-origin fetch as callBff sends it: Sec-Fetch-Site, Origin, and JSON for POST. */
function markAll({ query = '', cookies, headers = {}, body }: Options = {}) {
  const request = new NextRequest(`${ORIGIN}/api/notifications/read-all${query}`, {
    method: 'POST',
    headers: {
      host: 'localhost:3000',
      origin: ORIGIN,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      ...headers,
    },
    body,
  })
  for (const [name, value] of Object.entries(cookies ?? { access_token: FRESH, refresh_token: refreshToken() })) {
    request.cookies.set(name, value)
  }
  return POST(request)
}

function apiError(status: number, code: string): Response {
  return Response.json({ error: { code, message: 'English text for API callers' } }, { status })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('POST /api/notifications/read-all', () => {
  it('no before: POST /api/v1/notifications/read-all with Bearer and no body, returns the server { count }', async () => {
    vi.stubEnv('API_BASE_URL', 'http://backend.test:8080')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: { count: 0 } }))

    const res = await markAll()

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toEqual({ data: { count: 0 } })
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(String(url)).toBe('http://backend.test:8080/api/v1/notifications/read-all')
    expect(init).toMatchObject({ method: 'POST', cache: 'no-store' })
    expect(init?.body).toBeUndefined()
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${FRESH}`)
  })

  it('a valid before is the ONLY query parameter forwarded', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: { count: 2 } }))

    const res = await markAll({ query: `?before=${CURSOR}&userId=someone-else&all=true` })

    expect(res.status).toBe(200)
    const url = new URL(String(fetchSpy.mock.calls[0]![0]))
    expect(url.pathname).toBe('/api/v1/notifications/read-all')
    expect([...url.searchParams]).toEqual([['before', CURSOR]])
  })

  it('a foreign body never reaches the backend', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: { count: 0 } }))

    await markAll({ body: JSON.stringify({ recipientId: 'someone-else' }) })

    expect(fetchSpy.mock.calls[0]![1]?.body).toBeUndefined()
  })

  it.each([
    ['empty', '?before='],
    ['characters outside base64url', '?before=abc%2Bdef'],
    ['injected extra parameter', '?before=abc%26x%3D1'],
    ['longer than 200', `?before=${'a'.repeat(201)}`],
  ])('before %s: 400 VALIDATION_ERROR without calling the backend', async (_label, query) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await markAll({ query })

    expect(res.status).toBe(400)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each([
    ['Sec-Fetch-Site: cross-site', { 'sec-fetch-site': 'cross-site' }],
    ['Origin of another site', { origin: 'https://evil.example' }],
  ])('%s: 403 FORBIDDEN, the backend is not called, cookies unchanged', async (_label, headers) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await markAll({ headers, cookies: { access_token: STALE, refresh_token: refreshToken() } })

    expect(res.status).toBe(403)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'FORBIDDEN' } })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(res.headers.getSetCookie()).toHaveLength(0)
  })

  it('a malformed before on a cross-site request: 403 first, nothing leaks about the parameter', async () => {
    const res = await markAll({ query: '?before=%2B', headers: { 'sec-fetch-site': 'cross-site' } })

    expect(res.status).toBe(403)
  })

  it('a non-JSON POST (a cross-site form): 415, the backend is not called', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await markAll({ headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1' })

    expect(res.status).toBe(415)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('20 KB body: 413 PAYLOAD_TOO_LARGE, the backend is not called', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await markAll({ body: JSON.stringify({ pad: 'x'.repeat(20_000) }) })

    expect(res.status).toBe(413)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('no session: 401 UNAUTHENTICATED without calling the backend', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await markAll({ cookies: {} })

    expect(res.status).toBe(401)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'UNAUTHENTICATED' } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each([
    [400, 'VALIDATION_ERROR'],
    [403, 'USER_SUSPENDED'],
  ])('backend %i %s: status and code pass through unchanged', async (status, code) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(apiError(status, code))

    const res = await markAll({ query: `?before=${CURSOR}` })

    expect(res.status).toBe(status)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toMatchObject({ error: { code } })
  })
})
