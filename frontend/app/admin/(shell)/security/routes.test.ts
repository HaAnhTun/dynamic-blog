// @vitest-environment node
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ENDPOINTS } from '@/components/admin/security/endpoints'
import { msg } from '@/test/render-intl'

const { cookieStore } = vi.hoisted(() => ({ cookieStore: { get: vi.fn() } }))
vi.mock('next/headers', () => ({ cookies: () => Promise.resolve(cookieStore) }))

import { POST as disable } from './disable/route'
import { POST as enrollBegin } from './enroll/begin/route'
import { POST as enrollConfirm } from './enroll/confirm/route'
import { POST as password } from './password/route'
import { POST as recoveryCodes } from './recovery-codes/route'
import { POST as replaceBegin } from './replace/begin/route'
import { POST as replaceConfirm } from './replace/confirm/route'
import { POST as signOutEverywhere } from './sign-out-everywhere/route'

const ORIGIN = 'http://localhost:3000'
const CODES = ['ABCD-EFGH-JKMN-PQRS-TVWX-YZ01', 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ02']
const SECRET = {
  secretBase32: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
  otpauthUri: 'otpauth://totp/Blog:author?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Blog',
  issuer: 'Blog',
  account: 'author',
}
const REISSUED = { accessToken: 'access.jwt.new', refreshToken: 'refresh-new', expiresIn: 900 }

type Handler = (request: Request) => Promise<Response>
type Options = { xff?: string; headers?: Record<string, string>; raw?: string }

/** Distinct address per request: the Security bucket is module state that lives for the whole file. */
let counter = 0
function freshIp(): string {
  counter += 1
  return `10.7.${Math.floor(counter / 250)}.${counter % 250}`
}

function post(path: string, body: unknown, { xff = freshIp(), headers = {}, raw }: Options = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, host: 'localhost:3000', 'x-forwarded-for': xff, ...headers },
    body: raw ?? JSON.stringify(body),
  })
}

function backendReturns(status: number, body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(body, { status }))
}

const refusal = (
  code: string,
  status: number,
  message = 'English text that must never be shown',
  details?: Record<string, unknown>,
) => ({
  status,
  body: { error: { code, message, traceId: 't', ...(details ? { details } : {}) } },
})

const t = (key: string, values?: Record<string, string | number>) => msg(`Admin.security.${key}`, values)

beforeEach(() => {
  cookieStore.get.mockImplementation((name: string) => (name === 'access_token' ? { value: 'caller.access.jwt' } : undefined))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  cookieStore.get.mockReset()
})

describe('the Security route handlers: what each one calls on the backend', () => {
  it.each<[string, Handler, string, string, unknown, Record<string, unknown>, boolean]>([
    [
      'enroll/begin',
      enrollBegin,
      'POST /api/v1/me/mfa/enroll/begin',
      ENDPOINTS.enrollBegin,
      {},
      { currentPassword: 'pw' },
      false,
    ],
    [
      'enroll/confirm',
      enrollConfirm,
      'POST /api/v1/me/mfa/enroll/confirm',
      ENDPOINTS.enrollConfirm,
      {},
      { code: '123456' },
      true,
    ],
    [
      'recovery-codes',
      recoveryCodes,
      'POST /api/v1/me/mfa/recovery-codes/regenerate',
      ENDPOINTS.recoveryCodes,
      {},
      { code: '123456', currentPassword: 'pw' },
      false,
    ],
    [
      'replace/begin',
      replaceBegin,
      'POST /api/v1/me/mfa/replace/begin',
      ENDPOINTS.replaceBegin,
      {},
      { code: '123456', currentPassword: 'pw' },
      false,
    ],
    [
      'replace/confirm',
      replaceConfirm,
      'POST /api/v1/me/mfa/replace/confirm',
      ENDPOINTS.replaceConfirm,
      {},
      { code: '123456' },
      true,
    ],
    ['disable', disable, 'DELETE /api/v1/me/mfa', ENDPOINTS.disable, {}, { code: '123456' }, true],
    [
      'password',
      password,
      'POST /api/v1/me/password',
      ENDPOINTS.password,
      {},
      { currentPassword: 'old pw', newPassword: 'new pw 123456', code: '123456' },
      true,
    ],
  ])(
    '%s calls %s with the caller token and only the fields it accepts',
    async (_name, handler, call, endpoint, _unused, sent, reissues) => {
      const data = endpoint.includes('begin')
        ? SECRET
        : endpoint === ENDPOINTS.recoveryCodes || endpoint.includes('confirm')
          ? { ...(reissues ? REISSUED : {}), recoveryCodes: CODES }
          : REISSUED
      const fetchSpy = backendReturns(200, { data })

      const res = await handler(post(endpoint, { ...sent, extra: 'dropped', challenge: 'dropped' }))

      expect(res.status).toBe(200)
      const [url, init] = fetchSpy.mock.calls[0]!
      const [method, path] = call.split(' ')
      expect(init?.method).toBe(method)
      expect(new URL(String(url)).pathname).toBe(path)
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer caller.access.jwt')
      expect(new Headers(init?.headers).get('content-type')).toBe('application/json')
      expect(JSON.parse(String(init?.body))).toEqual(sent)
    },
  )

  it('every endpoint constant has a route.ts of that path under the Security folder', () => {
    for (const path of Object.values(ENDPOINTS)) {
      const folder = path.replace('/admin/security/', '')
      expect(existsSync(join(__dirname, folder, 'route.ts')), path).toBe(true)
    }
  })
})

describe('the Security route handlers: the answers for the page', () => {
  it('a begin call answers the secret once, and no cookie changes', async () => {
    backendReturns(200, { data: SECRET })

    const res = await enrollBegin(post(ENDPOINTS.enrollBegin, {}))

    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toEqual({ ok: true, secret: SECRET })
    expect(res.headers.getSetCookie()).toHaveLength(0)
  })

  it('a confirm call puts the NEW session in the cookies and answers the recovery codes, never a token', async () => {
    backendReturns(200, { data: { ...REISSUED, recoveryCodes: CODES } })

    const res = await enrollConfirm(post(ENDPOINTS.enrollConfirm, { code: '123456' }))
    const text = await res.text()
    const cookies = res.headers.getSetCookie()

    expect(JSON.parse(text)).toEqual({ ok: true, recoveryCodes: CODES })
    expect(text).not.toContain('access.jwt.new')
    expect(text).not.toContain('refresh-new')
    expect(cookies.find((c) => c.startsWith('access_token='))).toContain('access.jwt.new')
    expect(cookies.find((c) => c.startsWith('access_token='))).toContain('HttpOnly')
    expect(cookies.find((c) => c.startsWith('refresh_token='))).toContain('refresh-new')
  })

  it('regenerating codes does not touch the session', async () => {
    backendReturns(200, { data: { recoveryCodes: CODES } })

    const res = await recoveryCodes(post(ENDPOINTS.recoveryCodes, { code: '123456' }))

    await expect(res.json()).resolves.toEqual({ ok: true, recoveryCodes: CODES })
    expect(res.headers.getSetCookie()).toHaveLength(0)
  })

  it('a change that should reissue the session but did not is reported as a lost session: the browser holds a dead pair', async () => {
    backendReturns(200, { data: {} })

    const res = await password(post(ENDPOINTS.password, { currentPassword: 'a', newPassword: 'b'.repeat(14) }))

    expect(res.status).toBe(502)
    await expect(res.json()).resolves.toMatchObject({ sessionExpired: true })
    expect(res.headers.getSetCookie()).toHaveLength(0)
  })

  it('an answer that breaks the contract (no secret, no codes) is a 502, not a success', async () => {
    backendReturns(200, { data: { issuer: 'Blog' } })
    expect((await enrollBegin(post(ENDPOINTS.enrollBegin, {}))).status).toBe(502)

    backendReturns(200, { data: { ...REISSUED, recoveryCodes: [] } })
    const res = await enrollConfirm(post(ENDPOINTS.enrollConfirm, { code: '123456' }))
    expect(res.status).toBe(502)
    expect(res.headers.getSetCookie()).toHaveLength(0)
  })

  it('the password is not trimmed, the code is', async () => {
    const fetchSpy = backendReturns(200, { data: REISSUED })

    await password(post(ENDPOINTS.password, { currentPassword: ' old ', newPassword: ' new password 123 ', code: ' 123456 ' }))

    expect(JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body))).toEqual({
      currentPassword: ' old ',
      newPassword: ' new password 123 ',
      code: '123456',
    })
  })
})

describe('the Security route handlers: what is refused before the backend', () => {
  it('a cross-site POST is 403 and a text/plain body is 415, with no backend call and no cookie', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const cross = await password(
      post(ENDPOINTS.password, {}, { headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' } }),
    )
    const plain = await password(post(ENDPOINTS.password, {}, { headers: { 'content-type': 'text/plain' } }))

    expect(cross.status).toBe(403)
    expect(plain.status).toBe(415)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(cross.headers.getSetCookie()).toHaveLength(0)
  })

  it('no access cookie: 401 sessionExpired, the backend is not called', async () => {
    cookieStore.get.mockReturnValue(undefined)
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await password(post(ENDPOINTS.password, { currentPassword: 'a', newPassword: 'b' }))

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toMatchObject({ error: t('errors.sessionExpired'), sessionExpired: true })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each([
    ['not JSON', undefined, 'not json'],
    ['a JSON array', undefined, '[1]'],
    ['a missing code', ENDPOINTS.enrollConfirm, '{}'],
    ['a code that is not a string', ENDPOINTS.enrollConfirm, '{"code":123456}'],
    ['a code longer than the backend accepts', ENDPOINTS.enrollConfirm, `{"code":"${'1'.repeat(65)}"}`],
    ['a missing new password', ENDPOINTS.password, '{"currentPassword":"a"}'],
    [
      'a password longer than the backend accepts',
      ENDPOINTS.password,
      `{"currentPassword":"a","newPassword":"${'x'.repeat(513)}"}`,
    ],
  ])('%s is 400 and the backend is not called', async (_name, endpoint, raw) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const handler = endpoint === ENDPOINTS.password ? password : enrollConfirm

    const res = await handler(post(endpoint ?? ENDPOINTS.enrollConfirm, null, { raw }))

    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a body over 4 KB is 413', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await password(post(ENDPOINTS.password, { currentPassword: 'a', newPassword: 'b', pad: 'x'.repeat(5000) }))

    expect(res.status).toBe(413)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('the 21st call within 10 minutes from one IP is 429 with Retry-After; the backend is not called', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(9_000_000)
    const fetchSpy = backendReturns(200, { data: SECRET })
    for (let i = 0; i < 20; i++)
      expect((await enrollBegin(post(ENDPOINTS.enrollBegin, {}, { xff: '198.51.100.99' }))).status, `call ${i + 1}`).toBe(200)

    const res = await enrollBegin(post(ENDPOINTS.enrollBegin, {}, { xff: '198.51.100.99' }))

    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('600')
    await expect(res.json()).resolves.toMatchObject({ error: t('errors.tooMany', { minutes: 10 }), retryAfter: 600 })
    expect(fetchSpy).toHaveBeenCalledTimes(20)
  })
})

describe('the Security route handlers: the backend refuses', () => {
  async function refused(handler: Handler, endpoint: string, body: unknown, answer: { status: number; body: unknown }) {
    backendReturns(answer.status, answer.body)
    return handler(post(endpoint, body))
  }

  it('REAUTHENTICATION_REQUIRED is 401 with reauthenticate: true, and it does NOT clear the cookies: the session is alive', async () => {
    const res = await refused(enrollBegin, ENDPOINTS.enrollBegin, {}, refusal('REAUTHENTICATION_REQUIRED', 401))

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({ error: t('reauth'), code: 'REAUTHENTICATION_REQUIRED', reauthenticate: true })
    expect(res.headers.getSetCookie()).toHaveLength(0)
  })

  it('a wrong code is 401 with its sentence and keeps the cookies; a wrong current password has its own', async () => {
    const wrongCode = await refused(disable, ENDPOINTS.disable, { code: '000000' }, refusal('MFA_CODE_INVALID', 401))
    expect(wrongCode.status).toBe(401)
    await expect(wrongCode.json()).resolves.toEqual({ error: t('errors.codeInvalid'), code: 'MFA_CODE_INVALID' })
    expect(wrongCode.headers.getSetCookie()).toHaveLength(0)

    const wrongPassword = await refused(
      password,
      ENDPOINTS.password,
      { currentPassword: 'x', newPassword: 'y'.repeat(14) },
      refusal('INVALID_CREDENTIALS', 401),
    )
    await expect(wrongPassword.json()).resolves.toEqual({ error: t('errors.passwordInvalid'), code: 'INVALID_CREDENTIALS' })
  })

  it('any other 401 is a session that is gone: sessionExpired, so the page goes to the sign-in', async () => {
    const res = await refused(
      password,
      ENDPOINTS.password,
      { currentPassword: 'x', newPassword: 'y'.repeat(14) },
      refusal('UNAUTHENTICATED', 401),
    )

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toMatchObject({ error: t('errors.sessionExpired'), sessionExpired: true })
  })

  it('an administrator asking to turn it off: 403 MFA_REQUIRED, with the sentence that says why', async () => {
    const res = await refused(disable, ENDPOINTS.disable, { code: '123456' }, refusal('MFA_REQUIRED', 403))

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toEqual({ error: t('adminRequired'), code: 'MFA_REQUIRED' })
  })

  it('a frozen second step is 403 with its own sentence', async () => {
    const res = await refused(
      password,
      ENDPOINTS.password,
      { currentPassword: 'x', newPassword: 'y'.repeat(14) },
      refusal('MFA_FROZEN', 403),
    )

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toEqual({ error: t('errors.frozen'), code: 'MFA_FROZEN' })
  })

  it('ADMIN_PASSWORD set on the server: 409 with the sentence that says how to change it', async () => {
    const res = await refused(
      password,
      ENDPOINTS.password,
      { currentPassword: 'x', newPassword: 'y'.repeat(14) },
      refusal('PASSWORD_MANAGED_BY_ENVIRONMENT', 409),
    )

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual({
      error: t('password.managedByEnvironment'),
      code: 'PASSWORD_MANAGED_BY_ENVIRONMENT',
    })
  })

  it('a running delay is 429 with the wait in minutes (rounded up) and in Retry-After; an unknown wait has the "a moment" sentence', async () => {
    const timed = await refused(
      recoveryCodes,
      ENDPOINTS.recoveryCodes,
      { code: '000000' },
      refusal('MFA_RATE_LIMITED', 429, 'x', { retryAfterSeconds: 61 }),
    )
    expect(timed.status).toBe(429)
    expect(timed.headers.get('retry-after')).toBe('61')
    await expect(timed.json()).resolves.toMatchObject({ error: t('errors.tooMany', { minutes: 2 }), retryAfter: 61 })

    const unknown = await refused(recoveryCodes, ENDPOINTS.recoveryCodes, { code: '000000' }, refusal('RATE_LIMITED', 429))
    expect(unknown.headers.get('retry-after')).toBeNull()
    await expect(unknown.json()).resolves.toMatchObject({ error: t('errors.busy') })
  })

  it.each([
    ['a new password on the common list', 'newPassword: is too common or too easy to guess', 'password.weak'],
    ['a new password equal to the current one', 'newPassword: must be different from the current password', 'password.same'],
    ['any other validation failure', 'code: must not be blank', 'errors.invalid'],
  ])('%s: the stable backend message picks the translated sentence, never its text', async (_name, message, key) => {
    const res = await refused(
      password,
      ENDPOINTS.password,
      { currentPassword: 'x', newPassword: 'y'.repeat(14) },
      refusal('VALIDATION_ERROR', 400, message),
    )

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe(t(key))
    expect(body.error).not.toContain('newPassword')
  })

  it('a 5xx is 502 with the generic sentence; an unreachable backend says so', async () => {
    const broken = await refused(
      password,
      ENDPOINTS.password,
      { currentPassword: 'x', newPassword: 'y'.repeat(14) },
      refusal('INTERNAL_ERROR', 500),
    )
    expect(broken.status).toBe(502)
    const text = await broken.text()
    expect(text).toContain(t('errors.failed'))
    expect(text).not.toContain('English text')

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))
    const down = await password(post(ENDPOINTS.password, { currentPassword: 'x', newPassword: 'y'.repeat(14) }))
    expect(down.status).toBe(502)
    await expect(down.json()).resolves.toMatchObject({ error: t('errors.unreachable') })
  })

  it('never logs a code, a password or a recovery code', async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'info'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')]
    backendReturns(401, refusal('MFA_CODE_INVALID', 401).body)
    await password(post(ENDPOINTS.password, { currentPassword: 'old secret', newPassword: 'new secret 123456', code: '123456' }))
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))
    await recoveryCodes(post(ENDPOINTS.recoveryCodes, { code: 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ01' }))

    for (const log of logs) expect(log).not.toHaveBeenCalled()
  })
})

describe('POST /admin/security/sign-out-everywhere', () => {
  it('calls revoke-all with the caller token, clears both session cookies and the challenge cookie, and answers the sign-in path', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 204 }))

    const res = await signOutEverywhere(post(ENDPOINTS.signOutEverywhere, {}))
    const cookies = res.headers.getSetCookie()

    const [url, init] = fetchSpy.mock.calls[0]!
    expect(new URL(String(url)).pathname).toBe('/api/v1/auth/sessions/revoke-all')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer caller.access.jwt')
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true, next: '/admin/login' })
    expect(cookies.map((c) => c.split('=')[0]).sort()).toEqual(['access_token', 'mfa_challenge', 'refresh_token'])
    expect(cookies.every((c) => c.includes('Max-Age=0'))).toBe(true)
  })

  it('a session that is already dead at the backend (401) is the same outcome: the cookies are cleared', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json(refusal('UNAUTHENTICATED', 401).body, { status: 401 }),
    )

    const res = await signOutEverywhere(post(ENDPOINTS.signOutEverywhere, {}))

    expect(res.status).toBe(200)
    expect(res.headers.getSetCookie().every((c) => c.includes('Max-Age=0'))).toBe(true)
  })

  it('a backend that fails or does not answer keeps the cookies: the person is still signed in and can try again', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json(refusal('INTERNAL_ERROR', 500).body, { status: 500 }),
    )
    const failed = await signOutEverywhere(post(ENDPOINTS.signOutEverywhere, {}))
    expect(failed.status).toBe(502)
    expect(failed.headers.getSetCookie()).toHaveLength(0)

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))
    const down = await signOutEverywhere(post(ENDPOINTS.signOutEverywhere, {}))
    expect(down.status).toBe(502)
    expect(down.headers.getSetCookie()).toHaveLength(0)
  })

  it('refuses a cross-site POST and does not call the backend', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await signOutEverywhere(post(ENDPOINTS.signOutEverywhere, {}, { headers: { 'sec-fetch-site': 'cross-site' } }))

    expect(res.status).toBe(403)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
