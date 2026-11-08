// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { logoutResponse, revokeRefreshToken } from './logout'

const ORIGIN = 'http://localhost:3000'

function logoutRequest(headers: Record<string, string>): Request {
  return new Request(`${ORIGIN}/api/auth/logout`, {
    method: 'POST',
    headers: { host: 'localhost:3000', ...headers },
  })
}

/** As callBff sends: every POST carries `content-type: application/json`. */
const JSON_TYPE = { 'content-type': 'application/json' }

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('revokeRefreshToken', () => {
  it('POST /api/v1/auth/logout with the refresh token, with a 3 second timeout', async () => {
    vi.stubEnv('API_BASE_URL', 'http://backend.test:8080')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))

    await revokeRefreshToken('r-old')

    const [url, init] = fetchSpy.mock.calls[0]!
    expect(String(url)).toBe('http://backend.test:8080/api/v1/auth/logout')
    expect(init).toMatchObject({ method: 'POST', cache: 'no-store', body: JSON.stringify({ refreshToken: 'r-old' }) })
    expect(new Headers(init!.headers).get('content-type')).toBe('application/json')
    expect(init!.signal).toBeInstanceOf(AbortSignal)
  })

  it("says 'revoked' for a 204", async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))

    await expect(revokeRefreshToken('r')).resolves.toBe('revoked')
  })

  it("says 'already-dead' for a 401 and does not retry it: there is nothing left to end", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ error: { code: 'REFRESH_TOKEN_REVOKED' } }, { status: 401 }))

    await expect(revokeRefreshToken('r')).resolves.toBe('already-dead')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a network error', () => Promise.reject(new TypeError('fetch failed'))],
    ['a timeout', () => Promise.reject(new DOMException('timed out', 'TimeoutError'))],
    ['a 502', () => Promise.resolve(new Response(null, { status: 502 }))],
    ['a 503', () => Promise.resolve(new Response(null, { status: 503 }))],
    ['a 429', () => Promise.resolve(new Response(null, { status: 429 }))],
  ])('tries once more after %s, and says revoked when the second try works', async (_label, firstAttempt) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(firstAttempt)
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }))

    await expect(revokeRefreshToken('r')).resolves.toBe('revoked')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it("says 'failed' when both tries get no answer, and the warning names the status but nothing of the token", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))
    const token = 'r-very-secret-refresh-token-value'

    await expect(revokeRefreshToken(token)).resolves.toBe('failed')

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledTimes(1)
    const line = String(warn.mock.calls[0]!.join(' '))
    expect(line).toContain('revoke failed')
    expect(line).not.toContain(token)
    expect(line).not.toContain('r-very')
  })

  it("says 'failed' for a 5xx that stays a 5xx, with the status in the warning", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 503 }))

    await expect(revokeRefreshToken('r')).resolves.toBe('failed')

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(String(warn.mock.calls[0]!.join(' '))).toContain('status=503')
  })

  it("says 'failed' for another 4xx without a second try: a definitive refusal", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 400 }))

    await expect(revokeRefreshToken('r')).resolves.toBe('failed')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('never throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('anything'))

    await expect(revokeRefreshToken('r')).resolves.toBe('failed')
  })
})

describe('logoutResponse', () => {
  it('revokes the refresh token then clears both cookies; default 204, no cache', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))

    const res = await logoutResponse(
      logoutRequest({
        ...JSON_TYPE,
        'sec-fetch-site': 'same-origin',
        origin: ORIGIN,
        cookie: 'access_token=a; refresh_token=r-1',
      }),
    )

    expect(res.status).toBe(204)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(JSON.parse(String(fetchSpy.mock.calls[0]![1]!.body))).toEqual({ refreshToken: 'r-1' })
    const cookies = res.headers.getSetCookie()
    expect(cookies.map((c) => c.split('=')[0]).sort()).toEqual(['access_token', 'mfa_challenge', 'refresh_token'])
    expect(cookies.every((c) => c.includes('Max-Age=0'))).toBe(true)
  })

  it("'ok-json' returns 200 { ok: true, revoked: true } when the backend ended the session", async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))

    const res = await logoutResponse(logoutRequest({ ...JSON_TYPE, cookie: 'refresh_token=r' }), { success: 'ok-json' })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true, revoked: true })
  })

  it("'ok-json' says revoked: false when the backend could not end the session, and still clears every cookie (audit 038)", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))

    const res = await logoutResponse(logoutRequest({ ...JSON_TYPE, cookie: 'refresh_token=r; access_token=a' }), {
      success: 'ok-json',
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true, revoked: false })
    const cookies = res.headers.getSetCookie()
    expect(cookies.map((c) => c.split('=')[0]).sort()).toEqual(['access_token', 'mfa_challenge', 'refresh_token'])
    expect(cookies.every((c) => c.includes('Max-Age=0'))).toBe(true)
  })

  it("'ok-json' with a token that was already dead is a clean sign-out: revoked is true", async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: { code: 'REFRESH_TOKEN_EXPIRED' } }, { status: 401 }))

    const res = await logoutResponse(logoutRequest({ ...JSON_TYPE, cookie: 'refresh_token=r' }), { success: 'ok-json' })

    await expect(res.json()).resolves.toEqual({ ok: true, revoked: true })
  })

  it("'ok-json' without a refresh cookie has nothing to end: revoked is true", async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await logoutResponse(logoutRequest({ ...JSON_TYPE, cookie: 'access_token=a' }), { success: 'ok-json' })

    await expect(res.json()).resolves.toEqual({ ok: true, revoked: true })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('without a refresh cookie it does not call the backend, still clears the cookies', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await logoutResponse(logoutRequest({ ...JSON_TYPE, cookie: 'access_token=a' }))

    expect(fetchSpy).not.toHaveBeenCalled()
    // The two session cookies and the challenge cookie of a half-done sign-in.
    expect(res.headers.getSetCookie()).toHaveLength(3)
  })

  it('also ends a sign-in left half done: the challenge cookie is cleared on its own path', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))

    const res = await logoutResponse(logoutRequest({ ...JSON_TYPE, cookie: 'refresh_token=r-1; mfa_challenge=pending' }))
    const challenge = res.headers.getSetCookie().find((c) => c.startsWith('mfa_challenge='))

    expect(challenge).toMatch(/^mfa_challenge=;/)
    expect(challenge).toContain('Path=/admin/login')
    expect(challenge).toContain('Max-Age=0')
  })

  it('requireJson: false accepts a bare POST, no content-type (the admin sign-out button sends exactly that)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))

    const res = await logoutResponse(logoutRequest({ 'sec-fetch-site': 'same-origin', cookie: 'refresh_token=r' }), {
      requireJson: false,
    })

    expect(res.status).toBe(204)
  })

  it.each<[string, Record<string, string>]>([
    ['bare POST, no content-type', {}],
    ['forged form', { 'content-type': 'application/x-www-form-urlencoded' }],
    ['text/plain', { 'content-type': 'text/plain;charset=UTF-8' }],
  ])('requires JSON by default: %s gives 415, does not call the backend, does not touch cookies', async (_label, headers) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    // The browser sends neither Sec-Fetch-Site nor Origin: only the JSON layer is left to block another site's form.
    const res = await logoutResponse(logoutRequest({ ...headers, cookie: 'access_token=a; refresh_token=r' }))

    expect(res.status).toBe(415)
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'UNSUPPORTED_MEDIA_TYPE' } })
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(res.headers.getSetCookie()).toHaveLength(0)
  })

  it.each<Record<string, string>>([{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }])(
    'from another site (%j) gives 403: does not call the backend, does not touch cookies',
    async (headers) => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')

      const res = await logoutResponse(logoutRequest({ ...JSON_TYPE, ...headers, cookie: 'refresh_token=r' }))

      expect(res.status).toBe(403)
      expect(res.headers.get('cache-control')).toBe('private, no-store')
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(res.headers.getSetCookie()).toHaveLength(0)
    },
  )

  it('backend error still clears the cookies: the user clicked sign out', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))

    const res = await logoutResponse(logoutRequest({ ...JSON_TYPE, cookie: 'refresh_token=r' }))

    expect(res.status).toBe(204)
    expect(res.headers.getSetCookie().every((c) => c.includes('Max-Age=0'))).toBe(true)
  })
})
