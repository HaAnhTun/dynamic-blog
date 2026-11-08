import { afterEach, describe, expect, it, vi } from 'vitest'
import { isSetupRequired, postSetup } from './setup-api'

const INPUT = { setupCode: 'code-value', email: 'owner@example.test', password: 'a-long-enough-password', displayName: 'Owner' }

function reply(status: number, body: unknown) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(
      async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
    )
}

afterEach(() => vi.restoreAllMocks())

describe('isSetupRequired', () => {
  it('is true only for a 200 with setupRequired true, read without caching', async () => {
    const spy = reply(200, { data: { setupRequired: true } })

    await expect(isSetupRequired()).resolves.toBe(true)

    const [url, init] = spy.mock.calls[0] as [string, RequestInit]
    expect(url).toMatch(/\/api\/v1\/setup\/status$/)
    expect(init.cache).toBe('no-store')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(init.headers).toBeUndefined()
  })

  it.each([
    [200, { data: { setupRequired: false } }],
    [200, { data: {} }],
    [200, { data: { setupRequired: 'true' } }],
    [404, { data: { setupRequired: true } }],
    [500, {}],
  ])('is false for status %s with body %j', async (status, body) => {
    reply(status, body)
    await expect(isSetupRequired()).resolves.toBe(false)
  })

  it('is false when the backend is unreachable or the body is not JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))
    await expect(isSetupRequired()).resolves.toBe(false)

    vi.restoreAllMocks()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('<html>', { status: 200 }))
    await expect(isSetupRequired()).resolves.toBe(false)
  })
})

describe('postSetup', () => {
  it('posts the four fields without an auth header and answers ok on 201', async () => {
    const spy = reply(201, { data: { setupCompleted: true } })

    await expect(postSetup(INPUT)).resolves.toEqual({ ok: true })

    const [url, init] = spy.mock.calls[0] as [string, RequestInit]
    expect(url).toMatch(/\/api\/v1\/setup$/)
    expect(init.method).toBe('POST')
    expect(init.cache).toBe('no-store')
    expect(Object.keys(init.headers as Record<string, string>).map((h) => h.toLowerCase())).toEqual(['content-type'])
    expect(JSON.parse(String(init.body))).toEqual(INPUT)
  })

  it.each([
    [403, 'SETUP_CODE_INVALID', 403],
    [404, 'SETUP_CLOSED', 404],
    [400, 'VALIDATION_ERROR', 400],
    [429, 'RATE_LIMITED', 429],
  ])('maps backend %s %s to a stable code and status', async (status, code, expected) => {
    reply(status, { error: { code, message: 'backend words that must not be forwarded' } })

    await expect(postSetup(INPUT)).resolves.toEqual({ ok: false, code, status: expected })
  })

  it('maps an unknown code, an unreadable body and a network failure to UNAVAILABLE', async () => {
    reply(500, { error: { code: 'SOMETHING_ELSE' } })
    await expect(postSetup(INPUT)).resolves.toEqual({ ok: false, code: 'UNAVAILABLE', status: 502 })

    vi.restoreAllMocks()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('<html>', { status: 502 }))
    await expect(postSetup(INPUT)).resolves.toEqual({ ok: false, code: 'UNAVAILABLE', status: 502 })

    vi.restoreAllMocks()
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))
    await expect(postSetup(INPUT)).resolves.toEqual({ ok: false, code: 'UNAVAILABLE', status: 502 })
  })
})
