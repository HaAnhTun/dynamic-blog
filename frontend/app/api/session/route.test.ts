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
const STALE = jwt(-60, 'stale')
const ROTATED_ACCESS = jwt(900, 'rotated')

/** Each test uses its own refresh token: the memo in lib/session-refresh.ts survives across tests. */
let counter = 0
function refreshToken(): string {
  counter += 1
  return `r-session-${counter}-${Math.random().toString(36).slice(2)}`
}

function sessionRequest(cookies: Record<string, string>): NextRequest {
  const request = new NextRequest(`${ORIGIN}/api/session`)
  for (const [name, value] of Object.entries(cookies)) request.cookies.set(name, value)
  return request
}

/** The backend `CurrentUserResponse`, with every field that must NOT leak to the browser. */
function me(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      id: '7d1e2f3a-0000-4000-8000-000000000001',
      email: 'secret@example.com',
      displayName: 'Alex Reader',
      role: 'USER',
      githubLogin: 'nva',
      avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
      status: 'ACTIVE',
      createdAt: '2026-10-01T08:00:00Z',
      ...overrides,
    },
  }
}

type Route = (url: string, init: RequestInit) => Response | Promise<Response>

function backend(route: Route) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => route(String(input), init ?? {}))
}

function authOf(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get('authorization')
}

function expectCleared(res: Response) {
  const cookies = res.headers.getSetCookie()
  expect(cookies.map((c) => c.split('=')[0]).sort()).toEqual(['access_token', 'refresh_token'])
  expect(cookies.every((c) => c.includes('Max-Age=0'))).toBe(true)
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('GET /api/session', () => {
  it('no refresh cookie gives { data: null } without calling the backend', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await GET(sessionRequest({ access_token: FRESH }))

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toEqual({ data: null })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('maps CurrentUserResponse to SessionUser: drops id, email, status; tokens are never in the body', async () => {
    vi.stubEnv('API_BASE_URL', 'http://backend.test:8080')
    const fetchSpy = backend(() => Response.json(me()))

    const res = await GET(sessionRequest({ access_token: FRESH, refresh_token: refreshToken() }))

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({
      data: {
        displayName: 'Alex Reader',
        githubLogin: 'nva',
        avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
        role: 'USER',
        joinedAt: '2026-10-01T08:00:00Z',
        canAccessAdmin: false,
      },
    })
    for (const leaked of ['secret@example.com', '7d1e2f3a', 'ACTIVE', FRESH, 'eyJ']) {
      expect(text).not.toContain(leaked)
    }
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(String(url)).toBe('http://backend.test:8080/api/v1/auth/me')
    expect(authOf(init)).toBe(`Bearer ${FRESH}`)
    expect(res.headers.getSetCookie()).toHaveLength(0)
  })

  it.each([
    ['ADMIN', true],
    ['AUTHOR', true],
    ['USER', false],
  ])('canAccessAdmin for %s is %s', async (role, expected) => {
    backend(() => Response.json(me({ role })))

    const res = await GET(sessionRequest({ access_token: FRESH, refresh_token: refreshToken() }))

    await expect(res.json()).resolves.toMatchObject({ data: { role, canAccessAdmin: expected } })
  })

  it('a password-only account: githubLogin and avatarUrl are null, not the string "null"', async () => {
    backend(() => Response.json(me({ role: 'ADMIN', githubLogin: null, avatarUrl: null })))

    const res = await GET(sessionRequest({ access_token: FRESH, refresh_token: refreshToken() }))

    await expect(res.json()).resolves.toMatchObject({ data: { githubLogin: null, avatarUrl: null } })
  })

  it('403 USER_SUSPENDED clears the cookies and gives { data: null }', async () => {
    backend(() => Response.json({ error: { code: 'USER_SUSPENDED', message: 'x' } }, { status: 403 }))

    const res = await GET(sessionRequest({ access_token: FRESH, refresh_token: refreshToken() }))

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ data: null })
    expectCleared(res)
  })

  it('401 with a valid access token: refreshes once; a rejected refresh clears the cookies and gives { data: null }', async () => {
    const fetchSpy = backend((url) =>
      url.endsWith('/auth/refresh')
        ? Response.json({ error: { code: 'REFRESH_TOKEN_INVALID', message: 'x' } }, { status: 401 })
        : Response.json({ error: { code: 'UNAUTHENTICATED', message: 'x' } }, { status: 401 }),
    )

    const res = await GET(sessionRequest({ access_token: FRESH, refresh_token: refreshToken() }))

    await expect(res.json()).resolves.toEqual({ data: null })
    expectCleared(res)
    expect(fetchSpy.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/api/v1/auth/me', '/api/v1/auth/refresh'])
  })

  it('401 then refresh ok: asks again with the new token, returns the user and sets the new pair', async () => {
    const fetchSpy = backend((url, init) => {
      if (url.endsWith('/auth/refresh')) {
        return Response.json({ data: { accessToken: ROTATED_ACCESS, refreshToken: 'r-rotated', expiresIn: 900 } })
      }
      return authOf(init) === `Bearer ${ROTATED_ACCESS}`
        ? Response.json(me())
        : Response.json({ error: { code: 'UNAUTHENTICATED', message: 'x' } }, { status: 401 })
    })

    const res = await GET(sessionRequest({ access_token: FRESH, refresh_token: refreshToken() }))

    await expect(res.json()).resolves.toMatchObject({ data: { displayName: 'Alex Reader' } })
    expect(fetchSpy).toHaveBeenCalledTimes(3)
    expect(res.headers.getSetCookie().find((c) => c.startsWith('refresh_token='))).toContain('r-rotated')
  })

  it('401 even with the freshly refreshed token means the session is dead: clears the cookies', async () => {
    backend((url) =>
      url.endsWith('/auth/refresh')
        ? Response.json({ data: { accessToken: ROTATED_ACCESS, refreshToken: 'r-rotated', expiresIn: 900 } })
        : Response.json({ error: { code: 'UNAUTHENTICATED', message: 'gone' } }, { status: 401 }),
    )

    const res = await GET(sessionRequest({ access_token: STALE, refresh_token: refreshToken() }))

    await expect(res.json()).resolves.toEqual({ data: null })
    expectCleared(res)
  })

  it('access expired, refresh ok: uses the new token and sets both cookies', async () => {
    const fetchSpy = backend((url) =>
      url.endsWith('/auth/refresh')
        ? Response.json({ data: { accessToken: ROTATED_ACCESS, refreshToken: 'r-rotated', expiresIn: 900 } })
        : Response.json(me()),
    )

    const res = await GET(sessionRequest({ access_token: STALE, refresh_token: refreshToken() }))

    await expect(res.json()).resolves.toMatchObject({ data: { githubLogin: 'nva' } })
    expect(authOf(fetchSpy.mock.calls[1]![1])).toBe(`Bearer ${ROTATED_ACCESS}`)
    const cookies = res.headers.getSetCookie()
    expect(cookies.find((c) => c.startsWith('access_token='))).toContain(ROTATED_ACCESS)
    expect(cookies.find((c) => c.startsWith('refresh_token='))).toContain('r-rotated')
  })

  it('refresh revoked (lost the rotation race): { data: null } and the cookies are NOT touched', async () => {
    const fetchSpy = backend(() => Response.json({ error: { code: 'REFRESH_TOKEN_REVOKED', message: 'x' } }, { status: 401 }))

    const res = await GET(sessionRequest({ access_token: STALE, refresh_token: refreshToken() }))

    await expect(res.json()).resolves.toEqual({ data: null })
    expect(res.headers.getSetCookie()).toHaveLength(0)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('refresh rejected: clears the cookies and gives { data: null }, without asking /auth/me', async () => {
    const fetchSpy = backend(() => Response.json({ error: { code: 'REFRESH_TOKEN_EXPIRED', message: 'x' } }, { status: 401 }))

    const res = await GET(sessionRequest({ refresh_token: refreshToken() }))

    await expect(res.json()).resolves.toEqual({ data: null })
    expectCleared(res)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('502 when the backend does not answer, and the cookies stay as they are', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))

    const refreshDown = await GET(sessionRequest({ access_token: STALE, refresh_token: refreshToken() }))
    expect(refreshDown.status).toBe(502)
    expect(refreshDown.headers.getSetCookie()).toHaveLength(0)

    const meDown = await GET(sessionRequest({ access_token: FRESH, refresh_token: refreshToken() }))
    expect(meDown.status).toBe(502)
    expect(meDown.headers.getSetCookie()).toHaveLength(0)
  })

  it('a 5xx from /auth/me after a successful refresh still sets the new pair: the old token was revoked', async () => {
    backend((url) =>
      url.endsWith('/auth/refresh')
        ? Response.json({ data: { accessToken: ROTATED_ACCESS, refreshToken: 'r-rotated', expiresIn: 900 } })
        : Response.json({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, { status: 500 }),
    )

    const res = await GET(sessionRequest({ access_token: STALE, refresh_token: refreshToken() }))

    expect(res.status).toBe(502)
    expect(res.headers.getSetCookie().find((c) => c.startsWith('refresh_token='))).toContain('r-rotated')
  })

  it('a response that breaks the contract (missing displayName, unknown role) gives 502, no user is invented', async () => {
    backend(() => Response.json(me({ role: 'SUPERUSER' })))
    const badRole = await GET(sessionRequest({ access_token: FRESH, refresh_token: refreshToken() }))
    expect(badRole.status).toBe(502)

    backend(() => Response.json({ data: { role: 'USER' } }))
    const missing = await GET(sessionRequest({ access_token: FRESH, refresh_token: refreshToken() }))
    expect(missing.status).toBe(502)
  })
})
