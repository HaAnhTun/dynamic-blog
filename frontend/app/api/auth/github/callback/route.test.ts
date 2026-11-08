// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from './route'

const ORIGIN = 'http://localhost:3000'
const BLOB = 'eyJ2IjoxLCJzdGF0ZSI6InMxIn0.bWFj'
const TOKENS = { data: { accessToken: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.sig', refreshToken: 'r-new', expiresIn: 900 } }

/** One IP per request: the 20 per 10 minutes limit is module state that survives across tests. */
let ipCounter = 0
function freshIp(): string {
  ipCounter += 1
  return `10.3.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`
}

/** oauth_flow cookie value exactly as the start route builds it: base64url(returnTo) "." blob. */
function flow(returnTo: string, blob = BLOB): string {
  return `${Buffer.from(returnTo, 'utf8').toString('base64url')}.${blob}`
}

function callback(
  query: string,
  { cookies = {}, ip = freshIp() }: { cookies?: Record<string, string>; ip?: string } = {},
): NextRequest {
  const request = new NextRequest(`${ORIGIN}/api/auth/github/callback${query}`, {
    headers: { 'x-forwarded-for': ip },
  })
  for (const [name, value] of Object.entries(cookies)) request.cookies.set(name, value)
  return request
}

function flowCookieName(): string {
  return process.env.NODE_ENV === 'production' ? '__Host-oauth_flow' : 'oauth_flow'
}

/** An OAuth session in progress: the oauth_flow cookie carries this returnTo. */
function inFlight(returnTo = '/posts/bai-viet?x=1#binh-luan', extra: Record<string, string> = {}) {
  return { [flowCookieName()]: flow(returnTo), ...extra }
}

/** Fake backend by path: the callback returns `reply`, logout returns 204. */
function backend(reply: () => Response | Promise<Response>) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input) =>
      new URL(String(input)).pathname === '/api/v1/auth/logout' ? new Response(null, { status: 204 }) : reply(),
    )
}

function failure(code: string, status: number) {
  return () => Response.json({ error: { code, message: 'irrelevant', traceId: 't' } }, { status })
}

function setCookie(res: Response, name: string): string | undefined {
  return res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))
}

/** Step 5: always clear the oauth_flow cookie, always no-referrer and private no-store. */
function expectAlwaysHeaders(res: Response) {
  expect(res.status).toBe(303)
  expect(res.headers.get('referrer-policy')).toBe('no-referrer')
  expect(res.headers.get('cache-control')).toBe('private, no-store')
  const cleared = setCookie(res, flowCookieName())
  expect(cleared, 'the oauth_flow cookie must be cleared on every response').toBeDefined()
  expect(cleared).toContain('Max-Age=0')
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('GET /api/auth/github/callback: success', () => {
  it('sets both session cookies and a relative 303 to returnTo; tokens never appear in Location', async () => {
    vi.stubEnv('API_BASE_URL', 'http://backend.test:8080')
    const fetchSpy = backend(() => Response.json(TOKENS))

    const res = await GET(callback('?code=c0de&state=s1', { cookies: inFlight() }))

    expectAlwaysHeaders(res)
    expect(res.headers.get('location')).toBe('/posts/bai-viet?x=1#binh-luan')
    expect(res.headers.get('location')).not.toContain('r-new')
    expect(res.headers.get('location')).not.toContain('eyJ')
    const access = setCookie(res, 'access_token')!
    const refresh = setCookie(res, 'refresh_token')!
    expect(access).toContain(TOKENS.data.accessToken)
    expect(refresh).toContain('r-new')
    for (const cookie of [access, refresh]) {
      expect(cookie).toContain('HttpOnly')
      expect(cookie).toContain('SameSite=lax')
      expect(cookie).toContain('Path=/')
    }
    expect(await res.text()).toBe('')

    // The query string is forwarded verbatim; the blob travels in the oauth2_auth_request cookie; read JSON, do not follow redirects.
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(String(url)).toBe('http://backend.test:8080/api/v1/auth/oauth2/callback/github?code=c0de&state=s1')
    const headers = new Headers(init!.headers)
    expect(headers.get('cookie')).toBe(`oauth2_auth_request=${BLOB}`)
    expect(headers.get('accept')).toBe('application/json')
    expect(init).toMatchObject({ redirect: 'manual', cache: 'no-store' })
    expect(init!.signal).toBeInstanceOf(AbortSignal)
  })

  it('production: session cookies are Secure, the flow cookie is __Host-oauth_flow and is cleared at Path=/', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    backend(() => Response.json(TOKENS))

    const res = await GET(callback('?code=c&state=s', { cookies: inFlight('/') }))

    expect(res.headers.get('location')).toBe('/')
    expect(setCookie(res, 'access_token')).toContain('Secure')
    expect(setCookie(res, 'refresh_token')).toContain('Secure')
    const cleared = setCookie(res, '__Host-oauth_flow')!
    expect(cleared).toContain('Max-Age=0')
    expect(cleared).toContain('Path=/;')
    expect(cleared).toContain('Secure')
  })

  it('development: session cookies are not Secure, the flow cookie is cleared at exactly Path=/api/auth/github', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    backend(() => Response.json(TOKENS))

    const res = await GET(callback('?code=c&state=s', { cookies: inFlight('/') }))

    expect(setCookie(res, 'access_token')).not.toContain('Secure')
    expect(setCookie(res, 'oauth_flow')).toContain('Path=/api/auth/github;')
  })

  it('revokes the old refresh token before setting the new pair when another session exists', async () => {
    const fetchSpy = backend(() => Response.json(TOKENS))

    const res = await GET(callback('?code=c&state=s', { cookies: inFlight('/', { refresh_token: 'r-old' }) }))

    expect(fetchSpy.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/api/v1/auth/oauth2/callback/github',
      '/api/v1/auth/logout',
    ])
    expect(JSON.parse(String(fetchSpy.mock.calls[1]![1]!.body))).toEqual({ refreshToken: 'r-old' })
    expect(setCookie(res, 'refresh_token')).toContain('r-new')
  })

  it('a failed revocation does not break the login', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (new URL(String(input)).pathname === '/api/v1/auth/logout') throw new TypeError('fetch failed')
      return Response.json(TOKENS)
    })

    const res = await GET(callback('?code=c&state=s', { cookies: inFlight('/', { refresh_token: 'r-old' }) }))

    expect(res.headers.get('location')).toBe('/')
    expect(setCookie(res, 'refresh_token')).toContain('r-new')
  })

  it('does not revoke when the refresh cookie equals the new token', async () => {
    const fetchSpy = backend(() => Response.json(TOKENS))

    await GET(callback('?code=c&state=s', { cookies: inFlight('/', { refresh_token: 'r-new' }) }))

    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it.each([
    '/..//evil.com',
    '/.//evil.com',
    '/a/..//evil.com',
    '/%2e%2e//evil.com',
    '/%2F%2Fevil.com',
    '/%5Cevil.com',
    '/\\evil.com',
    '//evil.com',
    'https://evil.com',
    '/\t/evil.com',
    '/api/x',
    '/login',
    '/login?x',
    '/admin/login',
    // Only becomes the login page or an API path after Next collapses `//` and percent-decodes.
    '/admin//login',
    '/ad%6din/login',
    '/%61pi/x',
    `/${'a'.repeat(600)}`,
  ])('returnTo %j in the (unsigned) cookie gives Location "/"', async (returnTo) => {
    backend(() => Response.json(TOKENS))

    const res = await GET(callback('?code=c&state=s', { cookies: inFlight(returnTo) }))

    expect(res.headers.get('location')).toBe('/')
  })
})

describe('GET /api/auth/github/callback: backend error code → /login?error=', () => {
  it.each([
    ['OAUTH_ACCESS_DENIED', 401, 'denied'],
    ['OAUTH_STATE_INVALID', 401, 'state'],
    ['OAUTH_PROVIDER_UNAVAILABLE', 502, 'unavailable'],
    ['USER_SUSPENDED', 403, 'suspended'],
    ['OAUTH_LOGIN_FAILED', 401, 'failed'],
    ['INTERNAL_ERROR', 500, 'failed'],
    ['ENDPOINT_NOT_FOUND', 404, 'failed'],
  ])('%s (%i) → %s, carrying returnTo', async (code, status, error) => {
    backend(failure(code, status))

    const res = await GET(callback('?code=c&state=s', { cookies: inFlight('/posts/a') }))

    expectAlwaysHeaders(res)
    expect(res.headers.get('location')).toBe(`/login?error=${error}&returnTo=%2Fposts%2Fa`)
    expect(setCookie(res, 'access_token')).toBeUndefined()
    expect(setCookie(res, 'refresh_token')).toBeUndefined()
  })

  it('OAUTH_STATE_INVALID with an existing refresh cookie goes to "/": the reader is already logged in', async () => {
    backend(failure('OAUTH_STATE_INVALID', 401))

    const res = await GET(callback('?code=c&state=s', { cookies: inFlight('/posts/a', { refresh_token: 'r' }) }))

    expectAlwaysHeaders(res)
    expect(res.headers.get('location')).toBe('/')
    // Leave the existing session untouched.
    expect(setCookie(res, 'refresh_token')).toBeUndefined()
  })

  it('unavailable when the backend does not answer', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('timed out', 'TimeoutError'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const res = await GET(callback('?code=c&state=s', { cookies: inFlight('/') }))

    expectAlwaysHeaders(res)
    expect(res.headers.get('location')).toBe('/login?error=unavailable')
  })

  it.each([
    ['200 without a token', () => Response.json({ data: { accessToken: 'a' } })],
    ['200 that is not JSON', () => new Response('<html></html>', { status: 200 })],
    ['unexpected 302', () => new Response(null, { status: 302, headers: { location: 'https://evil.com' } })],
  ])('%s gives failed and sets no session cookie', async (_label, reply) => {
    backend(reply)

    const res = await GET(callback('?code=c&state=s', { cookies: inFlight('/') }))

    expectAlwaysHeaders(res)
    expect(res.headers.get('location')).toBe('/login?error=failed')
    expect(setCookie(res, 'access_token')).toBeUndefined()
  })

  it('5xx without an envelope (proxy) gives unavailable', async () => {
    backend(() => new Response('Bad Gateway', { status: 502 }))

    const res = await GET(callback('?code=c&state=s', { cookies: inFlight('/') }))

    expect(res.headers.get('location')).toBe('/login?error=unavailable')
  })
})

describe('GET /api/auth/github/callback: no oauth_flow cookie (backend is not called)', () => {
  it('a missing cookie gives state', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await GET(callback('?code=c&state=s'))

    expectAlwaysHeaders(res)
    expect(res.headers.get('location')).toBe('/login?error=state')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a missing cookie with GitHub access_denied gives denied: the reader cancelled, not a session error', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await GET(callback('?error=access_denied&state=s'))

    expect(res.headers.get('location')).toBe('/login?error=denied')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a missing cookie but an existing refresh cookie goes to "/": Back button after login, or a stale tab', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await GET(callback('?code=c&state=s', { cookies: { refresh_token: 'r' } }))

    expectAlwaysHeaders(res)
    expect(res.headers.get('location')).toBe('/')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a malformed flow cookie behaves like a missing cookie', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await GET(callback('?code=c&state=s', { cookies: { [flowCookieName()]: 'khong-dung-dang' } }))

    expect(res.headers.get('location')).toBe('/login?error=state')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a query string longer than 2048 characters gives state and is not sent to the backend', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await GET(callback(`?code=c&state=${'s'.repeat(2048)}`, { cookies: inFlight('/') }))

    expectAlwaysHeaders(res)
    expect(res.headers.get('location')).toBe('/login?error=state')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('GET /api/auth/github/callback: attempt rate limit', () => {
  it('more than 20 per 10 minutes from one IP gives rate, skips the backend, still clears the flow cookie', async () => {
    const fetchSpy = backend(failure('OAUTH_STATE_INVALID', 401))
    const ip = '198.51.100.88'

    for (let i = 0; i < 20; i++) await GET(callback('?code=c&state=s', { cookies: inFlight('/'), ip }))
    const res = await GET(callback('?code=c&state=s', { cookies: inFlight('/posts/a'), ip }))

    expectAlwaysHeaders(res)
    expect(res.headers.get('location')).toBe('/login?error=rate&returnTo=%2Fposts%2Fa')
    expect(fetchSpy).toHaveBeenCalledTimes(20)
  })
})

/**
 * `202` from the backend callback: the account (every administrator, an author who turned on two-step verification) needs a second
 * step. The page of that step is under /admin/login, not the reader's /login; only the challenge cookie is set; no session exists.
 */
describe('GET /api/auth/github/callback: a second step is due (202)', () => {
  const CHALLENGE = 'k9Xw3-Pq_7aB2cD4eF6gH8iJ0lM1nO5rS3tU7vW9yZA'
  const challenge =
    (extra: Record<string, unknown> = {}) =>
    () =>
      Response.json(
        {
          data: {
            challenge: CHALLENGE,
            purpose: 'VERIFY',
            methods: ['TOTP', 'RECOVERY_CODE'],
            expiresIn: 300,
            enrollmentCodeRequired: false,
            ...extra,
          },
        },
        { status: 202 },
      )

  it('redirects a VERIFY challenge to /admin/login/mfa and sets only the challenge cookie', async () => {
    backend(challenge())

    const res = await GET(callback('?code=c0de&state=s1', { cookies: inFlight('/admin') }))

    expectAlwaysHeaders(res)
    expect(res.headers.get('location')).toBe('/admin/login/mfa')
    expect(setCookie(res, 'access_token')).toBeUndefined()
    expect(setCookie(res, 'refresh_token')).toBeUndefined()
    const cookie = setCookie(res, 'mfa_challenge')!
    expect(cookie).toContain(CHALLENGE)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=lax')
    expect(cookie).toContain('Path=/admin/login')
    expect(cookie).toContain('Max-Age=300')
    expect(res.headers.get('location')).not.toContain(CHALLENGE)
    expect(await res.text()).toBe('')
  })

  it('redirects an ENROLL challenge to /admin/login/enroll, with ?code=1 when the enrollment code is asked first', async () => {
    backend(challenge({ purpose: 'ENROLL', methods: ['TOTP'], enrollmentCodeRequired: true }))
    const asked = await GET(callback('?code=c&state=s', { cookies: inFlight('/admin') }))
    expect(asked.headers.get('location')).toBe('/admin/login/enroll?code=1')

    backend(challenge({ purpose: 'ENROLL', methods: ['TOTP'], enrollmentCodeRequired: false }))
    const open = await GET(callback('?code=c&state=s', { cookies: inFlight('/admin') }))
    expect(open.headers.get('location')).toBe('/admin/login/enroll')
  })

  it('keeps a return target inside the admin area through the second step, and drops a public one', async () => {
    backend(challenge())
    const admin = await GET(callback('?code=c&state=s', { cookies: inFlight('/admin/security') }))
    expect(admin.headers.get('location')).toBe('/admin/login/mfa?next=/admin/security')

    backend(challenge())
    const reader = await GET(callback('?code=c&state=s', { cookies: inFlight('/en/posts/bai-viet') }))
    expect(reader.headers.get('location')).toBe('/admin/login/mfa')
  })

  it('does not revoke the older session of this browser: that happens when the second step succeeds', async () => {
    const fetchSpy = backend(challenge())

    const res = await GET(callback('?code=c&state=s', { cookies: inFlight('/admin', { refresh_token: 'r-old' }) }))

    expect(res.headers.get('location')).toBe('/admin/login/mfa')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('a 202 without a challenge is a failure on /login, not a sign-in', async () => {
    backend(() => Response.json({ data: { purpose: 'VERIFY' } }, { status: 202 }))

    const res = await GET(callback('?code=c&state=s', { cookies: inFlight('/admin') }))

    expectAlwaysHeaders(res)
    expect(res.headers.get('location')).toContain('/login?error=failed')
    expect(setCookie(res, 'mfa_challenge')).toBeUndefined()
  })
})
