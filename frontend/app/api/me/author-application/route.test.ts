// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET, POST } from './route'

const ORIGIN = 'http://localhost:3000'
const URL_PATH = `${ORIGIN}/api/me/author-application`

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function jwt(secondsFromNow: number): string {
  const exp = Math.floor(Date.now() / 1000) + secondsFromNow
  return `${b64url({ alg: 'HS256' })}.${b64url({ sub: 'u1', role: 'USER', exp })}.sig`
}

const FRESH = jwt(600)

/* Each test uses its own refresh token: the memo in lib/session-refresh.ts survives across tests. */
let counter = 0
function refreshToken(): string {
  counter += 1
  return `r-author-application-${counter}-${Math.random().toString(36).slice(2)}`
}

function withCookies(request: NextRequest, cookies?: Record<string, string>): NextRequest {
  for (const [name, value] of Object.entries(cookies ?? { access_token: FRESH, refresh_token: refreshToken() })) {
    request.cookies.set(name, value)
  }
  return request
}

function read({ query = '', cookies }: { query?: string; cookies?: Record<string, string> } = {}) {
  return GET(withCookies(new NextRequest(`${URL_PATH}${query}`), cookies))
}

/** A same-origin fetch as callBff sends it: Sec-Fetch-Site, Origin, and JSON. */
function apply({ body, headers = {} }: { body?: string; headers?: Record<string, string> } = {}) {
  const request = new NextRequest(URL_PATH, {
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
  return POST(withCookies(request))
}

function apiError(status: number, code: string): Response {
  return Response.json({ error: { code, message: 'English text for API callers' } }, { status })
}

const STATE = { data: { application: null, canApply: true, reapplyAfter: null } }

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('GET /api/me/author-application', () => {
  it('forwards to the backend with Bearer and carries no parameters; private no-store', async () => {
    vi.stubEnv('API_BASE_URL', 'http://backend.test:8080')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(STATE))

    const res = await read({ query: '?userId=someone-else' })

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toEqual(STATE)
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(String(url)).toBe('http://backend.test:8080/api/v1/me/author-application')
    expect(init).toMatchObject({ method: 'GET', cache: 'no-store' })
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${FRESH}`)
  })

  it('no session: 401 UNAUTHENTICATED without calling the backend', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await read({ cookies: {} })

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'UNAUTHENTICATED' } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('POST /api/me/author-application', () => {
  it('the JSON body goes verbatim to the backend with Bearer; the 201 and the new application pass through intact', async () => {
    const created = { data: { id: 'a1', status: 'PENDING', motivation: 'Writing about Go', createdAt: 'x', decidedAt: null } }
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(created, { status: 201 }))
    const body = JSON.stringify({ motivation: 'Writing about Go' })

    const res = await apply({ body })

    expect(res.status).toBe(201)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toEqual(created)
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(new URL(String(url)).pathname).toBe('/api/v1/me/author-application')
    expect(init).toMatchObject({ method: 'POST', body })
    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBe(`Bearer ${FRESH}`)
    expect(headers.get('content-type')).toBe('application/json')
  })

  it.each([
    ['Sec-Fetch-Site: cross-site', 403, { 'sec-fetch-site': 'cross-site' }],
    ['Origin of another site', 403, { origin: 'https://evil.example' }],
    ['form of another site (not JSON)', 415, { 'content-type': 'application/x-www-form-urlencoded' }],
  ])('%s: %i, the backend is not called', async (_label, status, headers) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await apply({ headers, body: 'motivation=x' })

    expect(res.status).toBe(status)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('20 KB body: 413 PAYLOAD_TOO_LARGE, the backend is not called', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await apply({ body: JSON.stringify({ motivation: 'x'.repeat(20_000) }) })

    expect(res.status).toBe(413)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each([
    [409, 'AUTHOR_APPLICATION_PENDING'],
    [409, 'AUTHOR_APPLICATION_COOLDOWN'],
    [409, 'AUTHOR_APPLICATION_NOT_ALLOWED'],
    [429, 'RATE_LIMITED'],
    [403, 'USER_SUSPENDED'],
    [400, 'VALIDATION_ERROR'],
  ])('backend %i %s: status and code pass through unchanged', async (status, code) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(apiError(status, code))

    const res = await apply({ body: JSON.stringify({ motivation: null }) })

    expect(res.status).toBe(status)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toMatchObject({ error: { code } })
  })
})
