// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from './route'

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
  return `r-unread-${counter}-${Math.random().toString(36).slice(2)}`
}

function count(cookies: Record<string, string> = { access_token: FRESH, refresh_token: refreshToken() }) {
  const request = new NextRequest(`${ORIGIN}/api/notifications/unread-count?x=1`)
  for (const [name, value] of Object.entries(cookies)) request.cookies.set(name, value)
  return GET(request)
}

function apiError(status: number, code: string): Response {
  return Response.json({ error: { code, message: 'English text for API callers' } }, { status })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('GET /api/notifications/unread-count (auth required)', () => {
  it('GET /api/v1/notifications/unread-count with Bearer and no query, returns { count } unchanged', async () => {
    vi.stubEnv('API_BASE_URL', 'http://backend.test:8080')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: { count: 7 } }))

    const res = await count()

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toEqual({ data: { count: 7 } })
    const [url, init] = fetchSpy.mock.calls[0]!
    // The browser query never goes further.
    expect(String(url)).toBe('http://backend.test:8080/api/v1/notifications/unread-count')
    expect(init).toMatchObject({ method: 'GET', cache: 'no-store' })
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${FRESH}`)
  })

  it('no session: 401 UNAUTHENTICATED without calling the backend', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await count({})

    expect(res.status).toBe(401)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'UNAUTHENTICATED' } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each([
    [403, 'USER_SUSPENDED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
  ])('backend %i %s: status and code pass through unchanged (the bell stops asking by itself)', async (status, code) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(apiError(status, code))

    const res = await count()

    expect(res.status).toBe(status)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toMatchObject({ error: { code } })
  })

  it('backend returns HTML (a broken proxy): 502, a foreign body is never passed through to the browser', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>oops</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    )

    const res = await count()

    expect(res.status).toBe(502)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'UPSTREAM_UNAVAILABLE' } })
  })
})
