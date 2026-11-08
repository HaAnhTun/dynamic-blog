// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { allowLoginAttempt } from '@/lib/rate-limit'
import { msg } from '@/test/render-intl'
import { POST } from './route'

const ORIGIN = 'http://localhost:3000'
const CHALLENGE = 'k9Xw3-Pq_7aB2cD4eF6gH8iJ0lM1nO5rS3tU7vW9yZA'
const CODE = '482913'
// As the browser sends from MfaForm: same origin, JSON. `host` because lib/same-origin.ts compares Origin with it.
const SAME_ORIGIN = { 'content-type': 'application/json', origin: ORIGIN, host: 'localhost:3000' }

type Options = { cookie?: string | null; xff?: string; headers?: Record<string, string> }

function submit(
  body: unknown,
  { cookie = `mfa_challenge=${CHALLENGE}`, xff = '198.51.100.201', headers = {} }: Options = {},
): Request {
  const all: Record<string, string> = { ...SAME_ORIGIN, 'x-forwarded-for': xff, ...headers }
  if (cookie !== null) all.cookie = cookie
  return new Request(`${ORIGIN}/admin/login/mfa/submit`, {
    method: 'POST',
    headers: all,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const VERIFIED = {
  data: {
    accessToken: 'access.jwt.value',
    refreshToken: 'refresh-opaque',
    expiresIn: 900,
    recoveryCodesRemaining: 9,
    usedRecoveryCode: false,
  },
}

/** A fresh Response per call: one instance's body can only be read once. */
function backendReturns(status: number, body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(body, { status }))
}

const refusal = (code: string, status: number, details?: Record<string, unknown>) => ({
  status,
  body: { error: { code, message: 'English text that must never be shown', traceId: 't', ...(details ? { details } : {}) } },
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('POST /admin/login/mfa/submit: a verified code ends the sign-in', () => {
  it('sends the challenge from the cookie with the code to the backend, and nothing else of the browser', async () => {
    const fetchSpy = backendReturns(200, VERIFIED)

    await POST(submit({ code: ` ${CODE} `, challenge: 'forged-by-the-page', extra: 1 }))

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(new URL(String(url)).pathname).toBe('/api/v1/auth/mfa/verify')
    expect(init?.method).toBe('POST')
    // The challenge is the cookie's, never a value of the page's body; the code is trimmed; the other fields are dropped.
    expect(JSON.parse(String(init?.body))).toEqual({ challenge: CHALLENGE, code: CODE })
  })

  it('writes both tokens as httpOnly session cookies and clears the challenge cookie on its own path', async () => {
    backendReturns(200, VERIFIED)

    const res = await POST(submit({ code: CODE }))
    const cookies = res.headers.getSetCookie()

    expect(res.status).toBe(200)
    const access = cookies.find((c) => c.startsWith('access_token='))
    const refresh = cookies.find((c) => c.startsWith('refresh_token='))
    expect(access).toContain('access.jwt.value')
    expect(access).toContain('HttpOnly')
    expect(refresh).toContain('refresh-opaque')
    expect(refresh).toContain('HttpOnly')
    const challenge = cookies.find((c) => c.startsWith('mfa_challenge='))
    expect(challenge).toMatch(/^mfa_challenge=;/)
    expect(challenge).toContain('Path=/admin/login')
    expect(challenge).toContain('Max-Age=0')
  })

  it('answers { ok: true } and the recovery codes left, never a token', async () => {
    backendReturns(200, { data: { ...VERIFIED.data, recoveryCodesRemaining: 2, usedRecoveryCode: true } })

    const res = await POST(submit({ code: 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ01' }))
    const text = await res.text()

    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(JSON.parse(text)).toEqual({ ok: true, recoveryCodesRemaining: 2, usedRecoveryCode: true })
    expect(text).not.toContain('access.jwt.value')
    expect(text).not.toContain('refresh-opaque')
    expect(text).not.toContain(CHALLENGE)
  })

  it('marks the cookies secure in production and not in development', async () => {
    backendReturns(200, VERIFIED)
    vi.stubEnv('NODE_ENV', 'production')
    const prod = (await POST(submit({ code: CODE }))).headers.getSetCookie()
    // The new pair under the __Host- names, the deletion of the two old plain names (audit 031), and the challenge cookie.
    expect(prod.map((c) => c.split('=')[0]).sort()).toEqual([
      '__Host-access_token',
      '__Host-refresh_token',
      'access_token',
      'mfa_challenge',
      'refresh_token',
    ])
    expect(prod.every((c) => c.includes('Secure'))).toBe(true)

    vi.stubEnv('NODE_ENV', 'development')
    const dev = (await POST(submit({ code: CODE }))).headers.getSetCookie()
    expect(dev.some((c) => c.includes('Secure'))).toBe(false)
  })

  it('revokes the refresh token this browser held before, which the new pair replaces', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) =>
        String(input).endsWith('/api/v1/auth/logout') ? new Response(null, { status: 204 }) : Response.json(VERIFIED),
      )

    const res = await POST(
      submit({ code: CODE }, { cookie: `mfa_challenge=${CHALLENGE}; refresh_token=refresh-old; access_token=old.jwt` }),
    )

    expect(res.status).toBe(200)
    expect(fetchSpy.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/api/v1/auth/mfa/verify',
      '/api/v1/auth/logout',
    ])
    expect(JSON.parse(String(fetchSpy.mock.calls[1]![1]!.body))).toEqual({ refreshToken: 'refresh-old' })
  })

  it('sends the visitor address (counted from the right of X-Forwarded-For) with the shared token for the backend per-address limit', async () => {
    vi.stubEnv('CLIENT_IP_TOKEN', '  mfa-token-for-tests  ')
    const fetchSpy = backendReturns(200, VERIFIED)

    await POST(submit({ code: CODE }, { xff: '6.6.6.6, 198.51.100.202' }))

    const headers = new Headers(fetchSpy.mock.calls[0]![1]?.headers)
    expect(headers.get('x-client-ip')).toBe('198.51.100.202')
    expect(headers.get('x-client-ip-token')).toBe('mfa-token-for-tests')
    expect([...headers.values()]).not.toContain('6.6.6.6')
  })

  it('a success answer without a usable token pair is a 502 and sets no cookie', async () => {
    backendReturns(200, { data: { recoveryCodesRemaining: 9 } })

    const res = await POST(submit({ code: CODE }))

    expect(res.status).toBe(502)
    expect(res.headers.getSetCookie()).toHaveLength(0)
    await expect(res.json()).resolves.toMatchObject({ error: msg('Admin.login.unusableSession') })
  })
})

describe('POST /admin/login/mfa/submit: what is refused before the backend is called', () => {
  it('without a challenge cookie there is no sign-in in progress: 401, the expired sentence, no backend call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await POST(submit({ code: CODE }, { cookie: null }))

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({ error: msg('Admin.login.mfa.expired'), code: 'MFA_CHALLENGE_INVALID' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each([
    ['an empty cookie', 'mfa_challenge='],
    ['a cookie with characters a challenge never has', 'mfa_challenge=a b;c'],
    ['a very long cookie', `mfa_challenge=${'a'.repeat(200)}`],
  ])('treats %s as no challenge and does not forward it', async (_name, cookie) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await POST(submit({ code: CODE }, { cookie }))

    expect(res.status).toBe(401)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refuses a cross-site POST with 403, no backend call and no cookie (the cookie is Lax, a form post could carry it)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await POST(
      submit({ code: CODE }, { headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' } }),
    )

    expect(res.status).toBe(403)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(res.headers.getSetCookie()).toHaveLength(0)
  })

  it('refuses a text/plain body that happens to parse as JSON with 415', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await POST(submit(`{"code":"${CODE}"}`, { headers: { 'content-type': 'text/plain' } }))

    expect(res.status).toBe(415)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each([
    ['not JSON', 'not json'],
    ['a JSON array', '[1]'],
    ['no code', '{}'],
    ['an empty code', '{"code":"   "}'],
    ['a code that is not a string', '{"code":482913}'],
    ['a code longer than the backend accepts', `{"code":"${'1'.repeat(65)}"}`],
  ])('answers 400 for %s, without calling the backend', async (_name, body) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await POST(submit(body))

    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('answers 413 for a body over 4 KB without calling the backend', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await POST(submit(JSON.stringify({ code: CODE, pad: 'x'.repeat(5000) })))

    expect(res.status).toBe(413)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('POST /admin/login/mfa/submit: the per-IP bucket', () => {
  it('the 11th call within 10 minutes from one IP is 429 with Retry-After and the wait in the sentence; the backend is not called', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(5_000_000)
    const fetchSpy = backendReturns(401, refusal('MFA_CODE_INVALID', 401).body)
    for (let i = 0; i < 10; i++)
      expect((await POST(submit({ code: CODE }, { xff: '198.51.100.210' }))).status, `attempt ${i + 1}`).toBe(401)

    const res = await POST(submit({ code: CODE }, { xff: '198.51.100.210' }))

    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('600')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toMatchObject({ error: msg('Admin.login.mfa.tooMany', { minutes: 10 }), retryAfter: 600 })
    expect(fetchSpy).toHaveBeenCalledTimes(10)
  })

  it('is separate from the password bucket: ten password attempts from the same IP do not use up the codes', async () => {
    for (let i = 0; i < 10; i++) allowLoginAttempt('198.51.100.211')
    expect(allowLoginAttempt('198.51.100.211')).toBe(false)
    const fetchSpy = backendReturns(200, VERIFIED)

    const res = await POST(submit({ code: CODE }, { xff: '198.51.100.211' }))

    expect(res.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('another IP is not affected by a guesser who hit the cap', async () => {
    backendReturns(401, refusal('MFA_CODE_INVALID', 401).body)
    for (let i = 0; i < 11; i++) await POST(submit({ code: CODE }, { xff: '198.51.100.212' }))
    expect((await POST(submit({ code: CODE }, { xff: '198.51.100.212' }))).status).toBe(429)

    backendReturns(200, VERIFIED)
    expect((await POST(submit({ code: CODE }, { xff: '198.51.100.213' }))).status).toBe(200)
  })

  it('a verified code clears the bucket of that IP', async () => {
    backendReturns(401, refusal('MFA_CODE_INVALID', 401).body)
    for (let i = 0; i < 9; i++) await POST(submit({ code: CODE }, { xff: '198.51.100.214' }))
    backendReturns(200, VERIFIED)
    expect((await POST(submit({ code: CODE }, { xff: '198.51.100.214' }))).status).toBe(200)

    backendReturns(401, refusal('MFA_CODE_INVALID', 401).body)
    for (let i = 0; i < 10; i++)
      expect((await POST(submit({ code: CODE }, { xff: '198.51.100.214' }))).status, `attempt ${i + 1}`).toBe(401)
    expect((await POST(submit({ code: CODE }, { xff: '198.51.100.214' }))).status).toBe(429)
  })
})

describe('POST /admin/login/mfa/submit: the backend refuses', () => {
  it('a wrong or replayed code is 401 with the invalid sentence, and the challenge cookie stays for the next try', async () => {
    backendReturns(401, refusal('MFA_CODE_INVALID', 401).body)

    const res = await POST(submit({ code: CODE }, { xff: '198.51.100.220' }))

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({ error: msg('Admin.login.mfa.invalid'), code: 'MFA_CODE_INVALID' })
    expect(res.headers.getSetCookie()).toHaveLength(0)
  })

  it('a challenge the backend calls dead is 401 with the expired sentence, and the cookie is cleared', async () => {
    backendReturns(401, refusal('MFA_CHALLENGE_INVALID', 401).body)

    const res = await POST(submit({ code: CODE }, { xff: '198.51.100.221' }))

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({ error: msg('Admin.login.mfa.expired'), code: 'MFA_CHALLENGE_INVALID' })
    const [cookie] = res.headers.getSetCookie()
    expect(cookie).toMatch(/^mfa_challenge=;/)
    expect(cookie).toContain('Max-Age=0')
  })

  it('a running delay is 429 with the wait in minutes (rounded up) and in Retry-After', async () => {
    backendReturns(429, refusal('MFA_RATE_LIMITED', 429, { retryAfterSeconds: 95 }).body)

    const res = await POST(submit({ code: CODE }, { xff: '198.51.100.222' }))

    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('95')
    await expect(res.json()).resolves.toMatchObject({
      error: msg('Admin.login.mfa.tooMany', { minutes: 2 }),
      code: 'MFA_RATE_LIMITED',
      retryAfter: 95,
    })
  })

  it.each([
    ['MFA_RATE_LIMITED without a known wait', 'MFA_RATE_LIMITED'],
    ['the backend per-address limit', 'RATE_LIMITED'],
  ])('%s is 429 with the sentence for "a moment" and no Retry-After', async (_name, code) => {
    backendReturns(429, refusal(code, 429).body)

    const res = await POST(submit({ code: CODE }, { xff: code === 'RATE_LIMITED' ? '198.51.100.223' : '198.51.100.224' }))

    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBeNull()
    await expect(res.json()).resolves.toMatchObject({ error: msg('Admin.login.mfa.busy'), code })
  })

  it('a frozen second step is 403 with its own sentence and no wait', async () => {
    backendReturns(403, refusal('MFA_FROZEN', 403).body)

    const res = await POST(submit({ code: CODE }, { xff: '198.51.100.225' }))

    expect(res.status).toBe(403)
    expect(res.headers.get('retry-after')).toBeNull()
    await expect(res.json()).resolves.toEqual({ error: msg('Admin.login.mfa.frozen'), code: 'MFA_FROZEN' })
  })

  it('a 503 keeps its meaning (wait and retry); any other failure is 502; neither shows the backend text', async () => {
    backendReturns(503, { error: { code: 'SERVICE_UNAVAILABLE', message: 'English text that must never be shown' } })
    const unavailable = await POST(submit({ code: CODE }, { xff: '198.51.100.226' }))
    expect(unavailable.status).toBe(503)
    await expect(unavailable.json()).resolves.toMatchObject({ error: msg('Admin.login.backendUnavailable') })

    backendReturns(500, { error: { code: 'INTERNAL_ERROR', message: 'English text that must never be shown' } })
    const broken = await POST(submit({ code: CODE }, { xff: '198.51.100.227' }))
    expect(broken.status).toBe(502)
    const text = await broken.text()
    expect(text).toContain(msg('Admin.login.failed'))
    expect(text).not.toContain('English text')
  })

  it('answers 502 rather than 500 when the backend is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))

    const res = await POST(submit({ code: CODE }, { xff: '198.51.100.228' }))

    expect(res.status).toBe(502)
    await expect(res.json()).resolves.toMatchObject({ error: msg('Admin.login.apiUnreachable') })
  })

  it('never logs the code or the challenge', async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'info'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')]
    backendReturns(401, refusal('MFA_CODE_INVALID', 401).body)
    await POST(submit({ code: CODE }, { xff: '198.51.100.229' }))
    backendReturns(200, VERIFIED)
    await POST(submit({ code: CODE }, { xff: '198.51.100.230' }))
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))
    await POST(submit({ code: CODE }, { xff: '198.51.100.231' }))

    for (const log of logs) expect(log).not.toHaveBeenCalled()
  })
})
