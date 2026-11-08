// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { DELETE } from './route'

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

let counter = 0
function refreshToken(): string {
  counter += 1
  return `r-delete-${counter}-${Math.random().toString(36).slice(2)}`
}

type Options = {
  id?: string
  cookies?: Record<string, string>
  headers?: Record<string, string>
  body?: string
}

/** As callBff sends DELETE: same origin, no content-type (DELETE needs no JSON). */
function remove({ id = ID, cookies, headers = {}, body }: Options = {}) {
  const request = new NextRequest(`${ORIGIN}/api/notifications/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { host: 'localhost:3000', origin: ORIGIN, 'sec-fetch-site': 'same-origin', ...headers },
    body,
  })
  for (const [name, value] of Object.entries(cookies ?? { access_token: FRESH, refresh_token: refreshToken() })) {
    request.cookies.set(name, value)
  }
  return DELETE(request, { params: Promise.resolve({ id }) })
}

function apiError(status: number, code: string): Response {
  return Response.json({ error: { code, message: 'English text for API callers' } }, { status })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('DELETE /api/notifications/[id]', () => {
  it('DELETE /api/v1/notifications/{id} with Bearer and no body, returns { count } (200, not 204)', async () => {
    vi.stubEnv('API_BASE_URL', 'http://backend.test:8080')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: { count: 2 } }))

    const res = await remove({ body: JSON.stringify({ recipientId: 'someone-else' }) })

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toEqual({ data: { count: 2 } })
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(String(url)).toBe(`http://backend.test:8080/api/v1/notifications/${ID}`)
    expect(init).toMatchObject({ method: 'DELETE', cache: 'no-store' })
    expect(init?.body).toBeUndefined()
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${FRESH}`)
  })

  it.each(['abc', `${ID}x`, ID.replace(/-/g, ''), '..', `${ID}/read`])(
    'id %j is not a UUID: 400 VALIDATION_ERROR without calling the backend',
    async (id) => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')

      const res = await remove({ id })

      expect(res.status).toBe(400)
      expect(res.headers.get('cache-control')).toBe('private, no-store')
      await expect(res.json()).resolves.toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
      expect(fetchSpy).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['Sec-Fetch-Site: cross-site', { 'sec-fetch-site': 'cross-site' }],
    ['Sec-Fetch-Site: same-site', { 'sec-fetch-site': 'same-site' }],
    ['Origin of another site', { origin: 'https://evil.example' }],
  ])('%s: 403 FORBIDDEN, the backend is not called', async (_label, headers) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await remove({ headers })

    expect(res.status).toBe(403)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'FORBIDDEN' } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('no session: 401 UNAUTHENTICATED without calling the backend', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await remove({ cookies: {} })

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'UNAUTHENTICATED' } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each([
    // Already deleted in another tab, or belongs to someone else: 404, never 403.
    [404, 'NOTIFICATION_NOT_FOUND'],
    [403, 'USER_SUSPENDED'],
  ])('backend %i %s: status and code pass through unchanged', async (status, code) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(apiError(status, code))

    const res = await remove()

    expect(res.status).toBe(status)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toMatchObject({ error: { code } })
  })
})
