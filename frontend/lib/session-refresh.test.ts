// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { refreshSession } from './session-refresh'

/** One refresh token per test: the memo is module state, living across the tests in the file. */
let counter = 0
function freshToken(): string {
  counter += 1
  return `refresh-${counter}-${Math.random().toString(36).slice(2)}`
}

const TOKENS = { data: { accessToken: 'eyJ.new.access', refreshToken: 'refresh-rotated', expiresIn: 900 } }

function backend(status: number, body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(body, { status }))
}

let now: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe("refreshSession: classifying the backend's answer", () => {
  it('200 with both tokens gives ok, with the new pair', async () => {
    vi.stubEnv('API_BASE_URL', 'http://backend.test:8080')
    const fetchSpy = backend(200, TOKENS)
    const token = freshToken()

    await expect(refreshSession(token)).resolves.toEqual({
      kind: 'ok',
      accessToken: 'eyJ.new.access',
      refreshToken: 'refresh-rotated',
    })
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(String(url)).toBe('http://backend.test:8080/api/v1/auth/refresh')
    expect(init).toMatchObject({ method: 'POST', cache: 'no-store', body: JSON.stringify({ refreshToken: token }) })
    expect(init!.signal).toBeInstanceOf(AbortSignal)
  })

  it('carries the life of the new refresh token when the backend says it, so the cookie can follow (audit 007)', async () => {
    backend(200, { data: { ...TOKENS.data, refreshExpiresIn: 604_800 } })

    await expect(refreshSession(freshToken())).resolves.toEqual({
      kind: 'ok',
      accessToken: 'eyJ.new.access',
      refreshToken: 'refresh-rotated',
      refreshExpiresIn: 604_800,
    })
  })

  it('401 REFRESH_TOKEN_REVOKED gives revoked: probably just lost a rotation race', async () => {
    backend(401, { error: { code: 'REFRESH_TOKEN_REVOKED', message: 'used' } })
    await expect(refreshSession(freshToken())).resolves.toEqual({ kind: 'revoked' })
  })

  it.each([
    [401, 'REFRESH_TOKEN_EXPIRED'],
    [401, 'REFRESH_TOKEN_INVALID'],
    [403, 'USER_SUSPENDED'],
    [400, 'VALIDATION_ERROR'],
  ])('%i %s gives rejected', async (status, code) => {
    backend(status, { error: { code, message: 'no' } })
    await expect(refreshSession(freshToken())).resolves.toEqual({ kind: 'rejected' })
  })

  it.each([500, 502, 503, 429, 408])('%i gives unavailable', async (status) => {
    backend(status, { error: { code: 'INTERNAL_ERROR', message: 'x' } })
    await expect(refreshSession(freshToken())).resolves.toEqual({ kind: 'unavailable' })
  })

  it('a network error or timeout gives unavailable, does not throw', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))
    await expect(refreshSession(freshToken())).resolves.toEqual({ kind: 'unavailable' })
  })

  it('200 with a missing token gives unavailable: the cookie is not cleared because of an answer off the contract', async () => {
    backend(200, { data: { accessToken: 'only-one' } })
    await expect(refreshSession(freshToken())).resolves.toEqual({ kind: 'unavailable' })
  })
})

describe('refreshSession: single-flight and memo', () => {
  it('two concurrent calls with the same token cost one backend call, both get the same pair', async () => {
    let release: (value: Response) => void = () => {}
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => new Promise<Response>((resolve) => (release = resolve)))
    const token = freshToken()

    const first = refreshSession(token)
    const second = refreshSession(token)
    release(Response.json(TOKENS))

    const [a, b] = await Promise.all([first, second])
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(a).toEqual(b)
    expect(a.kind).toBe('ok')
  })

  it('a new pair is not replayed: a request carrying the retired token after the call resolved gets revoked, never the pair (audit 078)', async () => {
    const fetchSpy = backend(200, TOKENS)
    const token = freshToken()

    await expect(refreshSession(token)).resolves.toMatchObject({ kind: 'ok', refreshToken: 'refresh-rotated' })

    // One second later, ten seconds later, a minute later: always what the backend says about a token it rotated (REVOKED).
    for (const later of [1_000, 9_999, 30_000, 59_999]) {
      now.mockReturnValue(1_000_000 + later)
      const outcome = await refreshSession(token)
      expect(outcome, `${later} ms later`).toEqual({ kind: 'revoked' })
      expect(outcome).not.toHaveProperty('refreshToken')
    }
    // Remembered as revoked, so it did not even reach the backend again.
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    // After the memo of a dead token ends, the backend is asked again (and answers for itself, including its reuse detection).
    now.mockReturnValue(1_000_000 + 60_001)
    await refreshSession(token)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('callers that arrive while the call is in flight still share its one new pair, those after it do not', async () => {
    let release: (value: Response) => void = () => {}
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => new Promise<Response>((resolve) => (release = resolve)))
    const token = freshToken()

    const first = refreshSession(token)
    const second = refreshSession(token)
    const third = refreshSession(token)
    release(Response.json(TOKENS))

    await expect(Promise.all([first, second, third])).resolves.toEqual([
      { kind: 'ok', accessToken: 'eyJ.new.access', refreshToken: 'refresh-rotated' },
      { kind: 'ok', accessToken: 'eyJ.new.access', refreshToken: 'refresh-rotated' },
      { kind: 'ok', accessToken: 'eyJ.new.access', refreshToken: 'refresh-rotated' },
    ])
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    await expect(refreshSession(token)).resolves.toEqual({ kind: 'revoked' })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('rejected is remembered for 60 seconds: a dead token does not hit the backend on every request', async () => {
    const fetchSpy = backend(401, { error: { code: 'REFRESH_TOKEN_EXPIRED', message: 'x' } })
    const token = freshToken()

    await refreshSession(token)
    now.mockReturnValue(1_000_000 + 59_000)
    await expect(refreshSession(token)).resolves.toEqual({ kind: 'rejected' })
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    now.mockReturnValue(1_000_000 + 60_001)
    await refreshSession(token)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('revoked is also remembered for 60 seconds', async () => {
    const fetchSpy = backend(401, { error: { code: 'REFRESH_TOKEN_REVOKED', message: 'x' } })
    const token = freshToken()

    await refreshSession(token)
    now.mockReturnValue(1_000_000 + 30_000)
    await expect(refreshSession(token)).resolves.toEqual({ kind: 'revoked' })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('unavailable is NOT remembered: the next request retries at once', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('fetch failed'))
    fetchSpy.mockImplementationOnce(async () => Response.json(TOKENS))
    const token = freshToken()

    await expect(refreshSession(token)).resolves.toEqual({ kind: 'unavailable' })
    await expect(refreshSession(token)).resolves.toMatchObject({ kind: 'ok' })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('keyed by token: a different token calls the backend separately', async () => {
    const fetchSpy = backend(200, TOKENS)

    await refreshSession(freshToken())
    await refreshSession(freshToken())

    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('keeps at most 1000 entries: the oldest token is forgotten when exceeded', async () => {
    const fetchSpy = backend(401, { error: { code: 'REFRESH_TOKEN_EXPIRED', message: 'x' } })
    const oldest = freshToken()
    await refreshSession(oldest)

    for (let i = 0; i < 1000; i++) await refreshSession(freshToken())
    const before = fetchSpy.mock.calls.length

    // The oldest entry was dropped so it must ask the backend again; the entry just added is still remembered.
    await refreshSession(oldest)
    expect(fetchSpy.mock.calls.length).toBe(before + 1)
  })
})

describe('refreshSession: the visitor address for the backend', () => {
  it('sends the address and the shared token with the call that reaches the backend', async () => {
    vi.stubEnv('CLIENT_IP_TOKEN', '  refresh-token-for-tests  ')
    const fetchSpy = backend(200, TOKENS)

    await refreshSession(freshToken(), '203.0.113.55')

    const headers = new Headers(fetchSpy.mock.calls[0]![1]?.headers)
    expect(headers.get('x-client-ip')).toBe('203.0.113.55')
    expect(headers.get('x-client-ip-token')).toBe('refresh-token-for-tests')
  })

  it('an unknown visitor (null, or not given) sends only the token', async () => {
    vi.stubEnv('CLIENT_IP_TOKEN', 'refresh-token-for-tests')
    const fetchSpy = backend(200, TOKENS)

    await refreshSession(freshToken(), null)
    await refreshSession(freshToken())

    for (const call of fetchSpy.mock.calls) {
      const headers = new Headers(call[1]?.headers)
      expect(headers.has('x-client-ip')).toBe(false)
      expect(headers.get('x-client-ip-token')).toBe('refresh-token-for-tests')
    }
  })

  it('without CLIENT_IP_TOKEN (a dev stack) neither header is sent', async () => {
    vi.stubEnv('CLIENT_IP_TOKEN', '')
    const fetchSpy = backend(200, TOKENS)

    await refreshSession(freshToken(), '203.0.113.56')

    const headers = new Headers(fetchSpy.mock.calls[0]![1]?.headers)
    expect(headers.has('x-client-ip')).toBe(false)
    expect(headers.has('x-client-ip-token')).toBe(false)
  })
})
