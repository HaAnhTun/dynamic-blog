// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { msg } from '@/test/render-intl'
import { POST } from './route'

const ORIGIN = 'http://localhost:3000'
const CHALLENGE = 'k9Xw3-Pq_7aB2cD4eF6gH8iJ0lM1nO5rS3tU7vW9yZA'
const SECRET = {
  secretBase32: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
  otpauthUri: 'otpauth://totp/Blog:admin?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Blog',
  issuer: 'Blog',
  account: 'admin',
}

type Options = { cookie?: string | null; xff?: string; headers?: Record<string, string> }

function begin(
  body: unknown,
  { cookie = `mfa_challenge=${CHALLENGE}`, xff = '198.51.100.240', headers = {} }: Options = {},
): Request {
  const all: Record<string, string> = {
    'content-type': 'application/json',
    origin: ORIGIN,
    host: 'localhost:3000',
    'x-forwarded-for': xff,
    ...headers,
  }
  if (cookie !== null) all.cookie = cookie
  return new Request(`${ORIGIN}/admin/login/enroll/begin`, { method: 'POST', headers: all, body: JSON.stringify(body) })
}

function backendReturns(status: number, body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(body, { status }))
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('POST /admin/login/enroll/begin', () => {
  it('sends the challenge of the cookie and the enrollment code, and answers the secret once with no cookie change', async () => {
    const fetchSpy = backendReturns(200, { data: SECRET })

    const res = await POST(begin({ enrollmentCode: ' operator-code ' }))

    const [url, init] = fetchSpy.mock.calls[0]!
    expect(new URL(String(url)).pathname).toBe('/api/v1/auth/mfa/enroll/begin')
    expect(JSON.parse(String(init?.body))).toEqual({ challenge: CHALLENGE, enrollmentCode: 'operator-code' })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toEqual({ ok: true, secret: SECRET })
    // The sign-in is not over: neither a session nor a change of the challenge cookie.
    expect(res.headers.getSetCookie()).toHaveLength(0)
  })

  it('sends no enrollment code when the window is open and the page has none', async () => {
    const fetchSpy = backendReturns(200, { data: SECRET })

    await POST(begin({}, { xff: '198.51.100.241' }))

    expect(JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body))).toEqual({ challenge: CHALLENGE })
  })

  it('a wrong or missing enrollment code is 403 with its own sentence (the page then shows the field)', async () => {
    backendReturns(403, { error: { code: 'ENROLLMENT_CODE_INVALID', message: 'English text that must never be shown' } })

    const res = await POST(begin({}, { xff: '198.51.100.242' }))

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toEqual({ error: msg('Admin.login.enroll.codeInvalid'), code: 'ENROLLMENT_CODE_INVALID' })
  })

  it('an answer without a secret is a 502', async () => {
    backendReturns(200, { data: { issuer: 'Blog' } })

    const res = await POST(begin({}, { xff: '198.51.100.243' }))

    expect(res.status).toBe(502)
  })

  it('does not call the backend without a challenge cookie, for another origin or for an enrollment code that is not a string', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    expect((await POST(begin({}, { cookie: null }))).status).toBe(401)
    expect((await POST(begin({}, { headers: { 'sec-fetch-site': 'cross-site' } }))).status).toBe(403)
    expect((await POST(begin({ enrollmentCode: 7 }, { xff: '198.51.100.244' }))).status).toBe(400)
    expect((await POST(begin({ enrollmentCode: 'x'.repeat(513) }, { xff: '198.51.100.244' }))).status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('counts into the second-step bucket of the IP: the 11th call is 429', async () => {
    const fetchSpy = backendReturns(200, { data: SECRET })
    for (let i = 0; i < 10; i++) expect((await POST(begin({}, { xff: '198.51.100.245' }))).status).toBe(200)

    expect((await POST(begin({}, { xff: '198.51.100.245' }))).status).toBe(429)
    expect(fetchSpy).toHaveBeenCalledTimes(10)
  })

  it('never logs the enrollment code or the challenge', async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'info'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')]
    backendReturns(403, { error: { code: 'ENROLLMENT_CODE_INVALID', message: 'x' } })
    await POST(begin({ enrollmentCode: 'operator-code' }, { xff: '198.51.100.246' }))

    for (const log of logs) expect(log).not.toHaveBeenCalled()
  })
})
