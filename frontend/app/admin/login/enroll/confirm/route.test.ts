// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { msg } from '@/test/render-intl'
import { POST } from './route'

const ORIGIN = 'http://localhost:3000'
const CHALLENGE = 'k9Xw3-Pq_7aB2cD4eF6gH8iJ0lM1nO5rS3tU7vW9yZA'
const CODES = ['ABCD-EFGH-JKMN-PQRS-TVWX-YZ01', 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ02']
const CONFIRMED = {
  data: { accessToken: 'access.jwt.value', refreshToken: 'refresh-opaque', expiresIn: 900, recoveryCodes: CODES },
}

function confirm(
  body: unknown,
  { cookie = `mfa_challenge=${CHALLENGE}`, xff = '198.51.100.250' }: { cookie?: string | null; xff?: string } = {},
): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    origin: ORIGIN,
    host: 'localhost:3000',
    'x-forwarded-for': xff,
  }
  if (cookie !== null) headers.cookie = cookie
  return new Request(`${ORIGIN}/admin/login/enroll/confirm`, { method: 'POST', headers, body: JSON.stringify(body) })
}

function backendReturns(status: number, body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(body, { status }))
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('POST /admin/login/enroll/confirm', () => {
  it('sends the first code with the challenge of the cookie', async () => {
    const fetchSpy = backendReturns(200, CONFIRMED)

    await POST(confirm({ code: '123456', challenge: 'forged' }))

    const [url, init] = fetchSpy.mock.calls[0]!
    expect(new URL(String(url)).pathname).toBe('/api/v1/auth/mfa/enroll/confirm')
    expect(JSON.parse(String(init?.body))).toEqual({ challenge: CHALLENGE, code: '123456' })
  })

  it('starts the session (httpOnly cookies), clears the challenge cookie and answers the recovery codes, never a token', async () => {
    backendReturns(200, CONFIRMED)

    const res = await POST(confirm({ code: '123456' }))
    const text = await res.text()
    const cookies = res.headers.getSetCookie()

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(JSON.parse(text)).toEqual({ ok: true, recoveryCodes: CODES })
    expect(text).not.toContain('access.jwt.value')
    expect(text).not.toContain('refresh-opaque')
    expect(cookies.find((c) => c.startsWith('access_token='))).toContain('HttpOnly')
    expect(cookies.find((c) => c.startsWith('refresh_token='))).toContain('refresh-opaque')
    const challenge = cookies.find((c) => c.startsWith('mfa_challenge='))
    expect(challenge).toContain('Path=/admin/login')
    expect(challenge).toContain('Max-Age=0')
  })

  it('a wrong first code is 401 with the invalid sentence and sets no cookie', async () => {
    backendReturns(401, { error: { code: 'MFA_CODE_INVALID', message: 'English text that must never be shown' } })

    const res = await POST(confirm({ code: '000000' }, { xff: '198.51.100.251' }))

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({ error: msg('Admin.login.mfa.invalid'), code: 'MFA_CODE_INVALID' })
    expect(res.headers.getSetCookie()).toHaveLength(0)
  })

  it('a challenge the backend calls dead is 401 and clears the cookie', async () => {
    backendReturns(401, { error: { code: 'MFA_CHALLENGE_INVALID', message: 'x' } })

    const res = await POST(confirm({ code: '123456' }, { xff: '198.51.100.252' }))

    expect(res.status).toBe(401)
    expect(res.headers.getSetCookie()[0]).toContain('Max-Age=0')
  })

  it('an answer without recovery codes is a 502 with no cookie: a session whose codes were lost must not start silently', async () => {
    backendReturns(200, { data: { accessToken: 'a', refreshToken: 'r' } })

    const res = await POST(confirm({ code: '123456' }, { xff: '198.51.100.253' }))

    expect(res.status).toBe(502)
    expect(res.headers.getSetCookie()).toHaveLength(0)
  })

  it('does not call the backend without a challenge cookie or a code', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    expect((await POST(confirm({ code: '123456' }, { cookie: null }))).status).toBe(401)
    expect((await POST(confirm({}, { xff: '198.51.100.254' }))).status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
