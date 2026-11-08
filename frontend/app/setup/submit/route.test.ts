// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { POST } from './route'

const ORIGIN = 'http://localhost:3000'
const SECRET_CODE = 'secret-setup-code-value'
const SECRET_PASSWORD = 'secret-password-value-123'
const VALID = { setupCode: SECRET_CODE, email: 'owner@example.test', password: SECRET_PASSWORD, displayName: 'Owner' }

let nextIp = 1
/** A fresh client IP per request so the per-IP counter of one test never leaks into another. */
function request(body: unknown, headers: Record<string, string> = {}, ip = `192.0.2.${nextIp++}`): Request {
  return new Request(`${ORIGIN}/setup/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, host: 'localhost:3000', 'x-forwarded-for': ip, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function backend(status: number, body: unknown) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(
      async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
    )
}

afterEach(() => vi.restoreAllMocks())

describe('POST /setup/submit', () => {
  it('answers { ok: true } on 201 and calls the backend once, with no auth header', async () => {
    const spy = backend(201, { data: { setupCompleted: true } })

    const res = await POST(request(VALID))

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toEqual({ ok: true })
    expect(spy).toHaveBeenCalledTimes(1)
    const [url, init] = spy.mock.calls[0] as [string, RequestInit]
    expect(url).toMatch(/\/api\/v1\/setup$/)
    expect(JSON.parse(String(init.body))).toEqual(VALID)
    expect(JSON.stringify(init.headers).toLowerCase()).not.toContain('authorization')
  })

  it('forwards only the four known fields', async () => {
    const spy = backend(201, {})

    await POST(request({ ...VALID, role: 'ADMIN', siteName: 'x' }))

    const init = spy.mock.calls[0]![1] as RequestInit
    expect(Object.keys(JSON.parse(String(init.body))).sort()).toEqual(['displayName', 'email', 'password', 'setupCode'])
  })

  it('refuses a cross-site request before anything else, without calling the backend', async () => {
    const spy = backend(201, {})

    const res = await POST(request(VALID, { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }))

    expect(res.status).toBe(403)
    expect(spy).not.toHaveBeenCalled()
  })

  it('refuses a non-JSON content type with 415', async () => {
    const spy = backend(201, {})

    const res = await POST(request(VALID, { 'content-type': 'text/plain' }))

    expect(res.status).toBe(415)
    expect(spy).not.toHaveBeenCalled()
  })

  it('limits each IP to 10 requests per window and does not call the backend past that', async () => {
    const spy = backend(403, { error: { code: 'SETUP_CODE_INVALID' } })
    const ip = '198.51.100.7'

    for (let i = 0; i < 10; i += 1) expect((await POST(request(VALID, {}, ip))).status).toBe(403)
    const blocked = await POST(request(VALID, {}, ip))

    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0)
    await expect(blocked.json()).resolves.toEqual({ ok: false, error: 'RATE_LIMITED' })
    expect(spy).toHaveBeenCalledTimes(10)
    // another IP is not affected
    expect((await POST(request(VALID, {}, '198.51.100.8'))).status).toBe(403)
  })

  it.each([
    [403, 'SETUP_CODE_INVALID', 403],
    [404, 'SETUP_CLOSED', 404],
    [400, 'VALIDATION_ERROR', 400],
    [429, 'RATE_LIMITED', 429],
  ])('maps backend %s %s to a stable code', async (status, code, expected) => {
    backend(status, { error: { code, message: 'backend message with the setup code secret-setup-code-value' } })

    const res = await POST(request(VALID))

    expect(res.status).toBe(expected)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ ok: false, error: code })
    expect(text).not.toContain('backend message')
  })

  it('answers 502 UNAVAILABLE when the backend is down or answers something unexpected', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))
    const down = await POST(request(VALID))
    expect(down.status).toBe(502)
    await expect(down.json()).resolves.toEqual({ ok: false, error: 'UNAVAILABLE' })

    vi.restoreAllMocks()
    backend(500, { error: { code: 'INTERNAL' } })
    expect((await POST(request(VALID))).status).toBe(502)
  })

  it.each([
    ['not json'],
    ['[]'],
    ['null'],
    [{ ...VALID, setupCode: '' }],
    [{ ...VALID, setupCode: 5 }],
    [{ ...VALID, email: 'x' }],
    [{ ...VALID, password: 'short' }],
    [{ ...VALID, password: 'p'.repeat(129) }],
    [{ ...VALID, displayName: '' }],
    [{ ...VALID, displayName: 'n'.repeat(61) }],
    [{ ...VALID, email: undefined }],
  ])('rejects the malformed body %j with VALIDATION_ERROR and no backend call', async (body) => {
    const spy = backend(201, {})

    const res = await POST(request(body))

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ ok: false, error: 'VALIDATION_ERROR' })
    expect(spy).not.toHaveBeenCalled()
  })

  it('rejects an oversized body with 413', async () => {
    const spy = backend(201, {})

    const res = await POST(request({ ...VALID, displayName: 'x'.repeat(20_000) }))

    expect(res.status).toBe(413)
    expect(spy).not.toHaveBeenCalled()
  })

  it('never writes the setup code or the password to the console', async () => {
    const consoles = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    )
    backend(403, { error: { code: 'SETUP_CODE_INVALID', message: SECRET_CODE } })
    await POST(request(VALID))
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error(`boom ${SECRET_PASSWORD}`))
    await POST(request(VALID))
    await POST(request('{broken'))

    const logged = JSON.stringify(consoles.flatMap((spy) => spy.mock.calls))
    expect(logged).not.toContain(SECRET_CODE)
    expect(logged).not.toContain(SECRET_PASSWORD)
  })
})

describe('POST /setup/submit: the visitor address for the backend', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('sends the address counted from the right of X-Forwarded-For with the shared token, never the first entry the visitor wrote', async () => {
    vi.stubEnv('CLIENT_IP_TOKEN', '  setup-token-for-tests  ')
    const spy = backend(201, {})

    await POST(request(VALID, { 'x-forwarded-for': '6.6.6.6, 192.0.2.201' }))

    const headers = new Headers((spy.mock.calls[0]![1] as RequestInit).headers)
    expect(headers.get('x-client-ip')).toBe('192.0.2.201')
    expect(headers.get('x-client-ip-token')).toBe('setup-token-for-tests')
    expect([...headers.values()]).not.toContain('6.6.6.6')
  })

  it('without CLIENT_IP_TOKEN (a dev stack) neither header is sent', async () => {
    vi.stubEnv('CLIENT_IP_TOKEN', '')
    const spy = backend(201, {})

    await POST(request(VALID, { 'x-forwarded-for': '192.0.2.202' }))

    const headers = new Headers((spy.mock.calls[0]![1] as RequestInit).headers)
    expect(headers.has('x-client-ip')).toBe(false)
    expect(headers.has('x-client-ip-token')).toBe(false)
  })
})
