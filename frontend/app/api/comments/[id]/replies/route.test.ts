// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from './route'

/*
 * The route handler is called directly with a NextRequest and context; the fetch to the backend is fake. Each test uses its own
 * refresh token: the memo in lib/session-refresh.ts survives across tests.
 */

const ORIGIN = 'http://localhost:3000'
const PARENT = '0b9a5a4e-7c1d-4f7e-8f52-3c1e2d9a6b10'

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
  return `r-reply-${counter}-${Math.random().toString(36).slice(2)}`
}

const REPLY = JSON.stringify({ content: 'I agree with you!' })

type Options = {
  id?: string
  /** Default: a session that is still valid. */
  cookies?: Record<string, string>
  headers?: Record<string, string>
  body?: string
}

/** A same-origin fetch as callBff sends it: Sec-Fetch-Site, Origin, JSON. */
function reply({ id = PARENT, cookies, headers = {}, body = REPLY }: Options = {}) {
  const request = new NextRequest(`${ORIGIN}/api/comments/${encodeURIComponent(id)}/replies`, {
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
  return POST(request, { params: Promise.resolve({ id }) })
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

describe('POST /api/comments/[id]/replies (auth required)', () => {
  it('201: forwards the body unchanged with Bearer to POST /api/v1/comments/{id}/replies', async () => {
    const created = { data: { id: 'c2', status: 'VISIBLE', content: 'I agree with you!', mine: true } }
    const fetchSpy = backend(() => Response.json(created, { status: 201 }))

    const res = await reply()

    expect(res.status).toBe(201)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toEqual(created)
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(new URL(String(url)).pathname).toBe(`/api/v1/comments/${PARENT}/replies`)
    expect(init).toMatchObject({ method: 'POST', body: REPLY })
    expect(authOf(init)).toBe(`Bearer ${FRESH}`)
  })

  it.each([
    ['Sec-Fetch-Site: cross-site', { 'sec-fetch-site': 'cross-site' }],
    ['Origin of another site', { origin: 'https://evil.example' }],
  ])('%s: 403 FORBIDDEN, the backend is not called, cookies unchanged', async (_label, headers) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await reply({ headers, cookies: { access_token: STALE, refresh_token: refreshToken() } })

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'FORBIDDEN' } })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(res.headers.getSetCookie()).toHaveLength(0)
  })

  it('content-type text/plain gives 415', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await reply({ headers: { 'content-type': 'text/plain' } })

    expect(res.status).toBe(415)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a 20 KB body gives 413 PAYLOAD_TOO_LARGE', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await reply({ body: JSON.stringify({ content: 'x'.repeat(20_000) }) })

    expect(res.status).toBe(413)
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each(['not-a-uuid', `${PARENT}/x`, '..'])('id %j: 400 VALIDATION_ERROR without calling the backend', async (id) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await reply({ id })

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('no session: 401 UNAUTHENTICATED without calling the backend', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await reply({ cookies: {} })

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'UNAUTHENTICATED' } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each([
    [400, 'VALIDATION_ERROR'],
    [403, 'USER_SUSPENDED'],
    [404, 'COMMENT_NOT_FOUND'],
    [409, 'COMMENT_DUPLICATE'],
    [422, 'COMMENT_NOT_REPLYABLE'],
    [429, 'RATE_LIMITED'],
  ])('backend %i %s: status and code pass through unchanged', async (status, code) => {
    backend(() => apiError(status, code))

    const res = await reply()

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

    const res = await reply()

    expect(res.status).toBe(401)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'UNAUTHENTICATED' } })
    expect(fetchSpy.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      `/api/v1/comments/${PARENT}/replies`,
      '/api/v1/auth/refresh',
      `/api/v1/comments/${PARENT}/replies`,
    ])
    expect(authOf(fetchSpy.mock.calls[0]![1])).toBe(`Bearer ${FRESH}`)
    expect(authOf(fetchSpy.mock.calls[2]![1])).toBe(`Bearer ${ROTATED}`)
    expect(fetchSpy.mock.calls[2]![1]).toMatchObject({ method: 'POST', body: REPLY })
    const cookies = res.headers.getSetCookie()
    expect(cookies.find((c) => c.startsWith('access_token='))).toContain(ROTATED)
    expect(cookies.find((c) => c.startsWith('refresh_token='))).toContain('r-rotated')
  })

  it('expired access token: refreshes then replies with the new token, sets the new cookie pair', async () => {
    const fetchSpy = backend((url) =>
      url.endsWith('/auth/refresh')
        ? Response.json({ data: { accessToken: ROTATED, refreshToken: 'r-rotated', expiresIn: 900 } })
        : Response.json({ data: { id: 'c2' } }, { status: 201 }),
    )

    const res = await reply({ cookies: { access_token: STALE, refresh_token: refreshToken() } })

    expect(res.status).toBe(201)
    expect(authOf(fetchSpy.mock.calls[1]![1])).toBe(`Bearer ${ROTATED}`)
    const cookies = res.headers.getSetCookie()
    expect(cookies.find((c) => c.startsWith('access_token='))).toContain(ROTATED)
    expect(cookies.find((c) => c.startsWith('refresh_token='))).toContain('r-rotated')
  })
})
