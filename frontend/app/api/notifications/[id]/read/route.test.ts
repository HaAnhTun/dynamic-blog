// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from './route'

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
const ROTATED = jwt(900, 'rotated')

let counter = 0
function refreshToken(): string {
  counter += 1
  return `r-read-${counter}-${Math.random().toString(36).slice(2)}`
}

type Options = {
  id?: string
  cookies?: Record<string, string>
  headers?: Record<string, string>
  body?: string
}

/** As callBff sends it when the reader opens a notification: a same-origin JSON POST, no body. */
function markRead({ id = ID, cookies, headers = {}, body }: Options = {}) {
  const request = new NextRequest(`${ORIGIN}/api/notifications/${encodeURIComponent(id)}/read`, {
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

function apiError(status: number, code: string): Response {
  return Response.json({ error: { code, message: 'English text for API callers' } }, { status })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('POST /api/notifications/[id]/read', () => {
  it('POST /api/v1/notifications/{id}/read with Bearer and no body, returns the server { count }', async () => {
    vi.stubEnv('API_BASE_URL', 'http://backend.test:8080')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: { count: 4 } }))

    const res = await markRead({ body: JSON.stringify({ read: false }) })

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toEqual({ data: { count: 4 } })
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(String(url)).toBe(`http://backend.test:8080/api/v1/notifications/${ID}/read`)
    expect(init).toMatchObject({ method: 'POST', cache: 'no-store' })
    expect(init?.body).toBeUndefined()
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${FRESH}`)
  })

  it.each(['abc', `${ID}x`, ID.replace(/-/g, ''), '..', 'read-all', `${ID}/../../comments/x`])(
    'id %j is not a UUID: 400 VALIDATION_ERROR without calling the backend',
    async (id) => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')

      const res = await markRead({ id })

      expect(res.status).toBe(400)
      expect(res.headers.get('cache-control')).toBe('private, no-store')
      await expect(res.json()).resolves.toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
      expect(fetchSpy).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['Sec-Fetch-Site: cross-site', { 'sec-fetch-site': 'cross-site' }],
    ['Origin of another site', { origin: 'https://evil.example' }],
  ])('%s: 403 FORBIDDEN before even the id check, the backend is not called', async (_label, headers) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await markRead({ id: '..', headers })

    expect(res.status).toBe(403)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a non-JSON POST: 415, the backend is not called', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await markRead({ headers: { 'content-type': 'text/plain' }, body: 'x' })

    expect(res.status).toBe(415)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('no session: 401 UNAUTHENTICATED without calling the backend', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await markRead({ cookies: {} })

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'UNAUTHENTICATED' } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each([
    // The notification does not exist, or belongs to someone else: the backend never says 403 here.
    [404, 'NOTIFICATION_NOT_FOUND'],
    [403, 'USER_SUSPENDED'],
  ])('backend %i %s: status and code pass through unchanged', async (status, code) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(apiError(status, code))

    const res = await markRead()

    expect(res.status).toBe(status)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toMatchObject({ error: { code } })
  })

  it('backend 401 even though the token is valid: refreshes once, retries exactly once, with the new cookie pair', async () => {
    let marks = 0
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).endsWith('/auth/refresh')) {
        return Response.json({ data: { accessToken: ROTATED, refreshToken: 'r-rotated', expiresIn: 900 } })
      }
      marks += 1
      return marks === 1 ? apiError(401, 'UNAUTHENTICATED') : Response.json({ data: { count: 1 } })
    })

    const res = await markRead()

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ data: { count: 1 } })
    expect(fetchSpy.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      `/api/v1/notifications/${ID}/read`,
      '/api/v1/auth/refresh',
      `/api/v1/notifications/${ID}/read`,
    ])
    const cookies = res.headers.getSetCookie()
    expect(cookies.find((c) => c.startsWith('access_token='))).toContain(ROTATED)
  })
})
