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
  return `r-comment-${counter}-${Math.random().toString(36).slice(2)}`
}

type Handler = typeof PUT
type Options = {
  id?: string
  /** Default: a session that is still valid. */
  cookies?: Record<string, string>
  headers?: Record<string, string>
  body?: string
}

const EDIT = JSON.stringify({ content: 'Edited to be clearer' })

/** A same-origin fetch as callBff sends it: Sec-Fetch-Site, Origin, and JSON for PUT. */
function call(handler: Handler, method: 'PUT' | 'DELETE', { id = ID, cookies, headers = {}, body }: Options = {}) {
  const request = new NextRequest(`${ORIGIN}/api/comments/${encodeURIComponent(id)}`, {
    method,
    headers: {
      host: 'localhost:3000',
      origin: ORIGIN,
      'sec-fetch-site': 'same-origin',
      ...(method === 'PUT' ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body ?? (method === 'PUT' ? EDIT : undefined),
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
})

describe('PUT /api/comments/[id] (edit your own comment)', () => {
  it('200: forwards the body unchanged with Bearer to PUT /api/v1/comments/{id}, returns the envelope unchanged', async () => {
    const updated = { data: { id: ID, status: 'VISIBLE', content: 'Edited to be clearer', edited: true, mine: true } }
    const fetchSpy = backend(() => Response.json(updated))

    const res = await call(PUT, 'PUT')

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toEqual(updated)
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(new URL(String(url)).pathname).toBe(`/api/v1/comments/${ID}`)
    expect(init).toMatchObject({ method: 'PUT', body: EDIT })
    expect(authOf(init)).toBe(`Bearer ${FRESH}`)
  })

  it('a non-JSON content-type gives 415', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await call(PUT, 'PUT', { headers: { 'content-type': 'text/plain' } })

    expect(res.status).toBe(415)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/comments/[id] (delete your own comment)', () => {
  it('204 with no body, no body is sent to the backend', async () => {
    const fetchSpy = backend(() => new Response(null, { status: 204 }))

    const res = await call(DELETE, 'DELETE')

    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(new URL(String(url)).pathname).toBe(`/api/v1/comments/${ID}`)
    expect(init).toMatchObject({ method: 'DELETE' })
    expect(init?.body).toBeUndefined()
  })
})

describe.each([
  ['PUT', PUT],
  ['DELETE', DELETE],
] as const)('%s /api/comments/[id]: shared checks', (method, handler) => {
  it.each([
    ['Sec-Fetch-Site: cross-site', { 'sec-fetch-site': 'cross-site' }],
    ['Origin of another site', { origin: 'https://evil.example' }],
  ])('%s: 403 FORBIDDEN, the backend is not called', async (_label, headers) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await call(handler, method, { headers })

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'FORBIDDEN' } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each(['abc', `${ID}x`, ID.replace(/-/g, ''), '..'])('id %j is not a UUID: 400 without calling the backend', async (id) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await call(handler, method, { id })

    expect(res.status).toBe(400)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a 20 KB body gives 413 PAYLOAD_TOO_LARGE and the backend is not called', async () => {
    // DELETE does not forward a body but still reads it under the 16 KB cap: every write route gives the same 413.
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await call(handler, method, { body: JSON.stringify({ content: 'x'.repeat(20_000) }) })

    expect(res.status).toBe(413)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('no session: 401 UNAUTHENTICATED without calling the backend', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await call(handler, method, { cookies: {} })

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'UNAUTHENTICATED' } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each([
    [400, 'VALIDATION_ERROR'],
    [403, 'FORBIDDEN'],
    [403, 'USER_SUSPENDED'],
    [404, 'COMMENT_NOT_FOUND'],
    [429, 'RATE_LIMITED'],
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
      `/api/v1/comments/${ID}`,
      '/api/v1/auth/refresh',
      `/api/v1/comments/${ID}`,
    ])
    expect(authOf(fetchSpy.mock.calls[0]![1])).toBe(`Bearer ${FRESH}`)
    const retry = fetchSpy.mock.calls[2]![1]
    expect(authOf(retry)).toBe(`Bearer ${ROTATED}`)
    // The retry is identical to the first attempt: PUT carries the same body again, DELETE still has none.
    expect(retry).toMatchObject({ method })
    expect(retry?.body).toBe(method === 'PUT' ? EDIT : undefined)
    const cookies = res.headers.getSetCookie()
    expect(cookies.find((c) => c.startsWith('access_token='))).toContain(ROTATED)
    expect(cookies.find((c) => c.startsWith('refresh_token='))).toContain('r-rotated')
  })

  it('expired access token: refreshes then calls with the new token, sets the new cookie pair', async () => {
    const fetchSpy = backend((url) => {
      if (url.endsWith('/auth/refresh')) {
        return Response.json({ data: { accessToken: ROTATED, refreshToken: 'r-rotated', expiresIn: 900 } })
      }
      return method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({ data: { id: ID } })
    })

    const res = await call(handler, method, { cookies: { access_token: STALE, refresh_token: refreshToken() } })

    expect(res.ok).toBe(true)
    expect(authOf(fetchSpy.mock.calls[1]![1])).toBe(`Bearer ${ROTATED}`)
    const cookies = res.headers.getSetCookie()
    expect(cookies.find((c) => c.startsWith('access_token='))).toContain(ROTATED)
    expect(cookies.find((c) => c.startsWith('refresh_token='))).toContain('r-rotated')
  })
})
