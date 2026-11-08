// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { POST } from './route'
import { msg } from '@/test/render-intl'

const ORIGIN = 'http://localhost:3000'
// As the browser sends from LoginForm: same origin, JSON. `host` because lib/same-origin.ts compares Origin with it.
const SAME_ORIGIN = { 'content-type': 'application/json', origin: ORIGIN, host: 'localhost:3000' }

let nextIp = 1

/**
 * A fresh client address per request (the last entry of X-Forwarded-For is the one Next reads), so the per-IP counter of one test
 * never leaks into another. Without a readable address the request would count in the shared "unknown" key, whose allowance is
 * that of one address (10 per 10 minutes, issue 017).
 */
function loginRequest(body: unknown): Request {
  return new Request(`${ORIGIN}/admin/login`, {
    method: 'POST',
    headers: { ...SAME_ORIGIN, 'x-forwarded-for': `203.0.113.${nextIp++}` },
    body: JSON.stringify(body),
  })
}

// A fresh Response per call, not one shared instance. The plan wrote this as
// `mockResolvedValue(new Response(...))`, which hands the SAME Response to every call;
// the two-direction `secure` test below calls POST twice, and the handler's second
// `upstream.json()` died with "TypeError: Body is unusable: Body has already been read"
// at route.ts:52. Only the helper changed; no assertion was touched.
function backendReturns(status: number, body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  )
}

describe('POST /admin/login', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('writes both tokens as httpOnly cookies', async () => {
    backendReturns(200, { data: { accessToken: 'access.jwt.value', refreshToken: 'refresh-opaque', expiresIn: 900 } })

    const res = await POST(loginRequest({ email: 'admin@blog.local', password: 'pw' }))
    const cookies = res.headers.getSetCookie()

    expect(res.status).toBe(200)
    // Read the Set-Cookie header, never document.cookie: an httpOnly cookie is
    // invisible there by design, so a document.cookie assertion passes identically
    // whether the cookie was set or never existed.
    const access = cookies.find((c) => c.startsWith('access_token='))
    const refresh = cookies.find((c) => c.startsWith('refresh_token='))
    expect(access).toContain('access.jwt.value')
    expect(access).toContain('HttpOnly')
    expect(access).toContain('SameSite=lax')
    expect(access).toContain('Path=/')
    expect(refresh).toContain('refresh-opaque')
    expect(refresh).toContain('HttpOnly')
  })

  it('does not put either token in the response body', async () => {
    backendReturns(200, { data: { accessToken: 'access.jwt.value', refreshToken: 'refresh-opaque', expiresIn: 900 } })

    const res = await POST(loginRequest({ email: 'admin@blog.local', password: 'pw' }))
    const text = await res.text()

    // This absence assertion is only worth anything because the same two strings are
    // asserted PRESENT in the Set-Cookie header in the test above. Without that pair,
    // an empty response and a handler that never ran look the same.
    expect(res.headers.getSetCookie().join(';')).toContain('access.jwt.value')
    expect(text).not.toContain('access.jwt.value')
    expect(text).not.toContain('refresh-opaque')
  })

  it('marks the cookies secure in production and not in development', async () => {
    // `secure` cannot be detected behaviourally on localhost — an insecure cookie works
    // identically over HTTP. The flag has to be read off the header string, and in BOTH
    // directions, or the test only proves one branch of the conditional exists.
    backendReturns(200, { data: { accessToken: 'a', refreshToken: 'r', expiresIn: 900 } })
    vi.stubEnv('NODE_ENV', 'production')
    const prod = (await POST(loginRequest({ email: 'a@b.c', password: 'pw' }))).headers.getSetCookie()
    expect(prod.every((c) => c.includes('Secure'))).toBe(true)

    vi.stubEnv('NODE_ENV', 'development')
    const dev = (await POST(loginRequest({ email: 'a@b.c', password: 'pw' }))).headers.getSetCookie()
    expect(dev.some((c) => c.includes('Secure'))).toBe(false)
  })

  it('reports a wrong password as 401 without echoing the backend message', async () => {
    backendReturns(401, { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password', traceId: 't' } })

    const res = await POST(loginRequest({ email: 'admin@blog.local', password: 'wrong' }))

    expect(res.status).toBe(401)
    expect(res.headers.getSetCookie()).toHaveLength(0)
    await expect(res.json()).resolves.toEqual({ error: 'Invalid email or password' })
  })

  it('answers 400 for a malformed body instead of throwing', async () => {
    const res = await POST(
      new Request(`${ORIGIN}/admin/login`, {
        method: 'POST',
        headers: SAME_ORIGIN,
        body: 'not json',
      }),
    )
    expect(res.status).toBe(400)
  })

  it('refuses a cross-site POST with 403 without calling the backend (login CSRF)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await POST(
      new Request(`${ORIGIN}/admin/login`, {
        method: 'POST',
        headers: { ...SAME_ORIGIN, 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' },
        body: JSON.stringify({ email: 'author@x', password: 'pw' }),
      }),
    )

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'FORBIDDEN' } })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(res.headers.getSetCookie()).toHaveLength(0)
  })

  it('refuses a text/plain form body that happens to parse as JSON with 415, without calling the backend', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    // What `<form enctype="text/plain">` with a crafted field name sends. No Sec-Fetch-Site and
    // no Origin (an older browser): the JSON content-type check is the layer that stops it.
    const res = await POST(
      new Request(`${ORIGIN}/admin/login`, {
        method: 'POST',
        headers: { host: 'localhost:3000', 'content-type': 'text/plain' },
        body: '{"email":"author@x","password":"pw","z":"="}',
      }),
    )

    expect(res.status).toBe(415)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(res.headers.getSetCookie()).toHaveLength(0)
  })

  it('refuses the native post of the form before the script has loaded, keeps the password out of the backend and costs no attempt', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    // What the browser sends when the form is submitted without JavaScript: same origin, urlencoded.
    const nativePost = () =>
      POST(
        new Request(`${ORIGIN}/admin/login/submit`, {
          method: 'POST',
          headers: {
            host: 'localhost:3000',
            origin: ORIGIN,
            'sec-fetch-site': 'same-origin',
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: 'email=admin%40blog.local&password=pw',
        }),
      )
    // More than the 10 attempts a window allows: if the refusal counted, the real login below would be answered 429.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const res = await nativePost()
      expect(res.status).toBe(415)
      expect(res.headers.getSetCookie()).toHaveLength(0)
    }
    expect(fetchSpy).not.toHaveBeenCalled()

    backendReturns(200, { data: { accessToken: 'access.jwt.value', refreshToken: 'refresh-opaque', expiresIn: 900 } })
    const res = await POST(loginRequest({ email: 'admin@blog.local', password: 'pw' }))
    expect(res.status).toBe(200)
  })

  it('answers 502 rather than 500 when the backend is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))

    const res = await POST(loginRequest({ email: 'a@b.c', password: 'pw' }))

    // A dev whose backend is not running should see "the API is down", not a Next
    // error page that looks like a bug in the login form.
    expect(res.status).toBe(502)
  })
})

/**
 * Per-IP attempt limit right in Next, before the backend hashes with Argon2 (16 MiB per attempt, even
 * for a non-existent email). The counter is a module-level Map (lib/rate-limit.ts) that lives for
 * this whole file, so each test uses its own IP. The tests above send a fresh address with every request (`loginRequest`), far
 * from the threshold.
 */
describe('POST /admin/login: per-IP attempt limit', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  const TOO_MANY = msg('Admin.login.tooManyAttempts', { minutes: '10' })

  function attempt(xff: string, password = 'sai-mat-khau'): Request {
    return new Request(`${ORIGIN}/admin/login`, {
      method: 'POST',
      headers: { ...SAME_ORIGIN, 'x-forwarded-for': xff },
      body: JSON.stringify({ email: 'admin@blog.local', password }),
    })
  }

  /** Fake backend: exactly `dung-mat-khau` gets the token pair, any other password gets 401. A fresh Response on every call. */
  function backend() {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const { password } = JSON.parse(String(init?.body)) as { password: string }
      return password === 'dung-mat-khau'
        ? Response.json({ data: { accessToken: 'access.jwt.value', refreshToken: 'refresh-opaque', expiresIn: 900 } })
        : Response.json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } }, { status: 401 })
    })
  }

  /** The first ten wrong attempts of an IP all reach the backend and get 401. */
  async function failTenTimes(xff: string): Promise<void> {
    for (let i = 0; i < 10; i++) expect((await POST(attempt(xff))).status, `attempt ${i + 1}`).toBe(401)
  }

  it('11th attempt within 10 minutes from one IP: 429 with Retry-After, no-store, the Vietnamese message, and the backend is not called', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(3_000_000)
    const fetchSpy = backend()
    await failTenTimes('198.51.100.70')

    const res = await POST(attempt('198.51.100.70'))

    expect(res.status).toBe(429)
    // The whole 10-minute window remains: the 11th attempt arrives at the same moment as the first (Date.now is frozen).
    expect(res.headers.get('retry-after')).toBe('600')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toEqual({ error: TOO_MANY })
    expect(res.headers.getSetCookie()).toHaveLength(0)
    expect(fetchSpy).toHaveBeenCalledTimes(10)
  })

  it('Retry-After is the seconds left in the window; once the window ends attempts are allowed again', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(4_000_000)
    const fetchSpy = backend()
    await failTenTimes('198.51.100.71')

    now.mockReturnValue(4_000_000 + 7 * 60_000)
    const blocked = await POST(attempt('198.51.100.71'))
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('retry-after')).toBe('180')
    await expect(blocked.json()).resolves.toEqual({ error: msg('Admin.login.tooManyAttempts', { minutes: '3' }) })

    now.mockReturnValue(4_000_000 + 10 * 60_000)
    expect((await POST(attempt('198.51.100.71'))).status).toBe(401)
    expect(fetchSpy).toHaveBeenCalledTimes(11)
  })

  it('another IP can still try: a password guesser hitting the cap does not lock out the site owner elsewhere', async () => {
    const fetchSpy = backend()
    await failTenTimes('198.51.100.72')
    expect((await POST(attempt('198.51.100.72'))).status).toBe(429)

    const owner = await POST(attempt('198.51.100.73', 'dung-mat-khau'))

    expect(owner.status).toBe(200)
    expect(owner.headers.getSetCookie().find((c) => c.startsWith('access_token='))).toContain('access.jwt.value')
    expect(fetchSpy).toHaveBeenCalledTimes(11)
  })

  it('the first X-Forwarded-For entry is client-set: changing it each time still counts into the bucket of the last entry, written by nginx', async () => {
    const fetchSpy = backend()
    for (let i = 0; i < 10; i++) expect((await POST(attempt(`10.66.${i}.1, 198.51.100.74`))).status).toBe(401)

    const res = await POST(attempt('10.66.99.1, 198.51.100.74'))

    expect(res.status).toBe(429)
    expect(fetchSpy).toHaveBeenCalledTimes(10)
  })

  it('a successful login clears the counter of that IP: 9 wrong then a right one, afterwards all 10 attempts are still available', async () => {
    const fetchSpy = backend()
    for (let i = 0; i < 9; i++) expect((await POST(attempt('198.51.100.75'))).status).toBe(401)
    expect((await POST(attempt('198.51.100.75', 'dung-mat-khau'))).status).toBe(200)

    // Without the reset, this IP's 11th attempt (the first one below) would already be 429.
    await failTenTimes('198.51.100.75')
    expect((await POST(attempt('198.51.100.75'))).status).toBe(429)
    expect(fetchSpy).toHaveBeenCalledTimes(20)
  })

  it('only a truly successful login clears it: a backend 200 missing tokens (502) still counts', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ data: {} }))
    for (let i = 0; i < 10; i++) expect((await POST(attempt('198.51.100.76', 'dung-mat-khau'))).status).toBe(502)

    expect((await POST(attempt('198.51.100.76', 'dung-mat-khau'))).status).toBe(429)
    expect(fetchSpy).toHaveBeenCalledTimes(10)
  })

  it.each([
    [429, 'RATE_LIMITED', msg('Admin.login.backendBusy')],
    [503, 'SERVICE_UNAVAILABLE', msg('Admin.login.backendUnavailable')],
  ])(
    'backend returns %i (%s): keeps the code instead of 502, a Vietnamese message for LoginForm, no cookie',
    async (status, code, message) => {
      // The backend blocks when too many password hashes run at once (429): a legitimate attempt by the
      // site owner landing at that moment must read "wait and retry", not "API broken".
      backendReturns(status, { error: { code, message: 'English text that must never be shown', traceId: 't' } })

      const res = await POST(attempt(`198.51.100.${status === 429 ? 77 : 78}`))

      expect(res.status).toBe(status)
      expect(res.headers.get('cache-control')).toBe('private, no-store')
      await expect(res.json()).resolves.toEqual({ error: message })
      expect(res.headers.getSetCookie()).toHaveLength(0)
    },
  )
})

describe('POST /admin/login: old session is revoked', () => {
  afterEach(() => vi.restoreAllMocks())

  const NEW_PAIR = { data: { accessToken: 'access.jwt.new', refreshToken: 'refresh-new', expiresIn: 900 } }

  function loginWithCookie(cookie: string | null): Request {
    const headers: Record<string, string> = { ...SAME_ORIGIN }
    if (cookie !== null) headers.cookie = cookie
    return new Request(`${ORIGIN}/admin/login`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email: 'admin@blog.local', password: 'pw' }),
    })
  }

  /** Fake backend by path: login returns a new pair, logout returns 204. */
  function backend(logout: () => Response | Promise<Response> = () => new Response(null, { status: 204 })) {
    return vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) => (String(input).endsWith('/api/v1/auth/logout') ? logout() : Response.json(NEW_PAIR)))
  }

  it('logging in over an existing session revokes the old refresh token, then sets the new pair', async () => {
    const fetchSpy = backend()

    const res = await POST(loginWithCookie('access_token=old.jwt; refresh_token=refresh-old'))

    expect(res.status).toBe(200)
    expect(fetchSpy.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/api/v1/auth/login',
      '/api/v1/auth/logout',
    ])
    expect(JSON.parse(String(fetchSpy.mock.calls[1]![1]!.body))).toEqual({ refreshToken: 'refresh-old' })
    // The old token is dead at the backend; the browser receives the new pair.
    expect(res.headers.getSetCookie().find((c) => c.startsWith('refresh_token='))).toContain('refresh-new')
  })

  it('without an old session logout is not called', async () => {
    const fetchSpy = backend()

    await POST(loginWithCookie(null))

    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('an old cookie equal to the new token does not revoke itself', async () => {
    const fetchSpy = backend()

    await POST(loginWithCookie('refresh_token=refresh-new'))

    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('a failed revocation does not break the login', async () => {
    backend(() => {
      throw new TypeError('fetch failed')
    })

    const res = await POST(loginWithCookie('refresh_token=refresh-old'))

    expect(res.status).toBe(200)
    expect(res.headers.getSetCookie().find((c) => c.startsWith('access_token='))).toContain('access.jwt.new')
  })

  it('a wrong login leaves the old session alone', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () =>
        Response.json({ error: { code: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect' } }, { status: 401 }),
      )

    const res = await POST(loginWithCookie('refresh_token=refresh-old'))

    expect(res.status).toBe(401)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

describe('POST /admin/login: the visitor address for the backend', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  function loginFrom(forwardedFor: string): Request {
    return new Request(`${ORIGIN}/admin/login`, {
      method: 'POST',
      headers: { ...SAME_ORIGIN, 'x-forwarded-for': forwardedFor },
      body: JSON.stringify({ email: 'admin@blog.local', password: 'pw' }),
    })
  }

  it('sends the address counted from the right of X-Forwarded-For with the shared token, never the first entry the visitor wrote', async () => {
    vi.stubEnv('CLIENT_IP_TOKEN', '  login-token-for-tests  ')
    const fetchSpy = backendReturns(401, { error: { code: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect' } })

    await POST(loginFrom('6.6.6.6, 198.51.100.151'))

    const headers = new Headers(fetchSpy.mock.calls[0]![1]?.headers)
    expect(headers.get('x-client-ip')).toBe('198.51.100.151')
    expect(headers.get('x-client-ip-token')).toBe('login-token-for-tests')
    expect([...headers.values()]).not.toContain('6.6.6.6')
  })

  it('without CLIENT_IP_TOKEN (a dev stack) neither header is sent', async () => {
    vi.stubEnv('CLIENT_IP_TOKEN', '')
    const fetchSpy = backendReturns(401, { error: { code: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect' } })

    await POST(loginFrom('198.51.100.152'))

    const headers = new Headers(fetchSpy.mock.calls[0]![1]?.headers)
    expect(headers.has('x-client-ip')).toBe(false)
    expect(headers.has('x-client-ip-token')).toBe(false)
  })
})

/**
 * `202 Accepted` from the backend: the password was right but a second step is due (every administrator, an author who turned it
 * on). No session exists yet. The challenge goes into its own httpOnly cookie, and the body only names the step.
 */
describe('POST /admin/login: a second step is due (202)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  const CHALLENGE = 'k9Xw3-Pq_7aB2cD4eF6gH8iJ0lM1nO5rS3tU7vW9yZA'
  const verify = (extra: Record<string, unknown> = {}) => ({
    data: {
      challenge: CHALLENGE,
      purpose: 'VERIFY',
      methods: ['TOTP', 'RECOVERY_CODE'],
      expiresIn: 300,
      enrollmentCodeRequired: false,
      ...extra,
    },
  })

  function loginFrom(xff: string, cookie?: string): Request {
    const headers: Record<string, string> = { ...SAME_ORIGIN, 'x-forwarded-for': xff }
    if (cookie !== undefined) headers.cookie = cookie
    return new Request(`${ORIGIN}/admin/login`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email: 'admin@blog.local', password: 'pw' }),
    })
  }

  it('sets only the challenge cookie (httpOnly, Lax, five minutes, Path=/admin/login) and no session cookie', async () => {
    backendReturns(202, verify())

    const res = await POST(loginFrom('198.51.100.160'))
    const cookies = res.headers.getSetCookie()

    expect(res.status).toBe(200)
    expect(cookies).toHaveLength(1)
    const [challenge] = cookies
    expect(challenge).toMatch(new RegExp(`^mfa_challenge=${CHALLENGE};`))
    expect(challenge).toContain('HttpOnly')
    expect(challenge).toContain('SameSite=lax')
    expect(challenge).toContain('Path=/admin/login')
    expect(challenge).toContain('Max-Age=300')
  })

  it('answers which step to show and nothing else: no token, no challenge, in the body', async () => {
    backendReturns(202, verify())

    const res = await POST(loginFrom('198.51.100.161'))
    const text = await res.text()

    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(JSON.parse(text)).toEqual({ ok: true, next: 'mfa', enrollmentCodeRequired: false })
    expect(text).not.toContain(CHALLENGE)
  })

  it('an ENROLL challenge sends the page to the enrollment, with the hint that the enrollment code is asked first', async () => {
    backendReturns(202, verify({ purpose: 'ENROLL', methods: ['TOTP'], enrollmentCodeRequired: true }))

    const res = await POST(loginFrom('198.51.100.162'))

    await expect(res.json()).resolves.toEqual({ ok: true, next: 'enroll', enrollmentCodeRequired: true })
  })

  it('leaves an older session alone: nothing is revoked or cleared until the second step succeeds', async () => {
    const fetchSpy = backendReturns(202, verify())

    const res = await POST(loginFrom('198.51.100.163', 'access_token=old.jwt; refresh_token=refresh-old'))

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(res.headers.getSetCookie().some((c) => c.startsWith('refresh_token=') || c.startsWith('access_token='))).toBe(false)
  })

  it('marks the challenge cookie secure in production and not in development', async () => {
    backendReturns(202, verify())
    vi.stubEnv('NODE_ENV', 'production')
    const prod = (await POST(loginFrom('198.51.100.164'))).headers.getSetCookie()
    expect(prod[0]).toContain('Secure')

    vi.stubEnv('NODE_ENV', 'development')
    const dev = (await POST(loginFrom('198.51.100.165'))).headers.getSetCookie()
    expect(dev[0]).not.toContain('Secure')
  })

  it('a 202 without a challenge is unusable: 502 and no cookie', async () => {
    backendReturns(202, { data: { purpose: 'VERIFY' } })

    const res = await POST(loginFrom('198.51.100.166'))

    expect(res.status).toBe(502)
    await expect(res.json()).resolves.toEqual({ error: msg('Admin.login.unusableSession') })
    expect(res.headers.getSetCookie()).toHaveLength(0)
  })

  it('a right password clears the attempts of that IP, as a login that ends here would', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const { password } = JSON.parse(String(init?.body)) as { password: string }
      return password === 'dung-mat-khau'
        ? Response.json(verify(), { status: 202 })
        : Response.json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } }, { status: 401 })
    })
    const attempt = (password: string) =>
      new Request(`${ORIGIN}/admin/login`, {
        method: 'POST',
        headers: { ...SAME_ORIGIN, 'x-forwarded-for': '198.51.100.167' },
        body: JSON.stringify({ email: 'admin@blog.local', password }),
      })
    for (let i = 0; i < 9; i++) expect((await POST(attempt('sai'))).status).toBe(401)
    expect((await POST(attempt('dung-mat-khau'))).status).toBe(200)

    for (let i = 0; i < 10; i++) expect((await POST(attempt('sai'))).status, `attempt ${i + 1}`).toBe(401)
    expect((await POST(attempt('sai'))).status).toBe(429)
    expect(fetchSpy).toHaveBeenCalledTimes(20)
  })
})

/**
 * Every other public BFF write reads at most 16 KB (`readSmallBody`); the login read the whole body, whatever its size, on an anonymous
 * call (a 30 MB body was accepted in a test). A body over the limit is refused before it is parsed and before the backend is called, and
 * a field no real account can hold is refused without a password hash (audit issue 35).
 */
describe('POST /admin/login: size of the body and of its fields', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  let nextIp = 1
  function post(body: BodyInit, headers: Record<string, string> = {}, init: RequestInit = {}): Promise<Response> {
    return POST(
      new Request(`${ORIGIN}/admin/login`, {
        method: 'POST',
        headers: { ...SAME_ORIGIN, 'x-forwarded-for': `198.51.100.${200 + nextIp++}`, ...headers },
        body,
        ...init,
      }),
    )
  }

  it('refuses a body over 16 KB that declares its length, with 413 and no backend call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const big = JSON.stringify({ email: 'admin@blog.local', password: 'x'.repeat(100 * 1024) })

    const res = await post(big)

    expect(res.status).toBe(413)
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } })
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refuses a chunked body over 16 KB too, which has no content-length to reject it up front', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const chunk = new TextEncoder().encode('x'.repeat(8 * 1024))
    let sent = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        // 64 KB in all; the reader must stop after the limit, not drain the stream.
        if (sent++ < 8) controller.enqueue(chunk)
        else controller.close()
      },
    })

    const res = await post(stream, {}, { duplex: 'half' } as RequestInit)

    expect(res.status).toBe(413)
    expect(sent).toBeLessThan(8)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refuses a password longer than 256 characters and an address longer than 254 with 400, without calling the backend', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    expect((await post(JSON.stringify({ email: 'admin@blog.local', password: 'p'.repeat(257) }))).status).toBe(400)
    expect((await post(JSON.stringify({ email: `${'a'.repeat(250)}@b.cc`, password: 'pw' }))).status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('still passes the longest password and address a real account can have', async () => {
    const fetchSpy = backendReturns(200, { data: { accessToken: 'a', refreshToken: 'r', expiresIn: 900 } })

    const email = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(53)}.example`
    expect(email.length).toBeLessThanOrEqual(254)
    const res = await post(JSON.stringify({ email, password: 'p'.repeat(256) }))

    expect(res.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})
