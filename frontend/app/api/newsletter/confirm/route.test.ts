// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import * as route from './route'

const ORIGIN = 'http://localhost:3000'
/** The shape of 32 random bytes written as base64url. */
const TOKEN = 'q0Vx8bT3sJm2Lr5YwN1eK7uHcA9dGf4ZpXiOtUnB6yQ'

let ipCounter = 0
function freshIp(): string {
  ipCounter += 1
  return `198.51.100.${ipCounter}`
}

function confirm({
  body = JSON.stringify({ token: TOKEN }),
  headers = {},
  ip = freshIp(),
}: { body?: string; headers?: Record<string, string>; ip?: string } = {}) {
  return route.POST(
    new NextRequest(`${ORIGIN}/api/newsletter/confirm`, {
      method: 'POST',
      headers: {
        host: 'localhost:3000',
        origin: ORIGIN,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
        'x-forwarded-for': ip,
        ...headers,
      },
      body,
    }),
  )
}

function backendAnswers(status: number, body: unknown = { data: { status: 'CONFIRMED' } }) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(body, { status }))
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('POST /api/newsletter/confirm', () => {
  it('POST only: opening the link (a mail scanner opens it before the reader) calls nothing', () => {
    expect(Object.keys(route)).toEqual(['POST'])
  })

  it('a well-formed token: POST `{ token }` to the backend as a guest; 200 CONFIRMED, private no-store, no token in the response', async () => {
    vi.stubEnv('API_BASE_URL', 'http://backend.test:8080')
    const fetchSpy = backendAnswers(200, { data: { status: 'CONFIRMED', token: TOKEN } })

    const res = await confirm({ headers: { cookie: 'access_token=a; refresh_token=r' } })

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ data: { status: 'CONFIRMED' } })
    expect(text).not.toContain(TOKEN)
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(String(url)).toBe('http://backend.test:8080/api/v1/newsletter/confirm')
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ token: TOKEN }) })
    const headers = new Headers(init?.headers)
    expect(headers.has('authorization')).toBe(false)
    expect(headers.has('cookie')).toBe(false)
  })

  it.each([
    ['missing token', '{}'],
    ['token that is not a string', '{"token":12345678901234567890}'],
    ['19 characters', JSON.stringify({ token: 'a'.repeat(19) })],
    ['201 characters', JSON.stringify({ token: 'a'.repeat(201) })],
    ['with a space', JSON.stringify({ token: `${TOKEN.slice(0, 20)} ${TOKEN.slice(21)}` })],
    ['with / and + (plain base64)', JSON.stringify({ token: `${TOKEN.slice(0, 20)}/+${TOKEN.slice(22)}` })],
    ['with = padding', JSON.stringify({ token: `${TOKEN}=` })],
    ['with ../', JSON.stringify({ token: `../../admin/${TOKEN}` })],
    ['not JSON', `token=${TOKEN}`],
  ])('malformed token (%s): 400 NEWSLETTER_TOKEN_INVALID, the backend is not called', async (_label, body) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await confirm({ body })

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'NEWSLETTER_TOKEN_INVALID' } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('20 and 200 characters are the two accepted edges', async () => {
    const fetchSpy = backendAnswers(200)

    expect((await confirm({ body: JSON.stringify({ token: 'a'.repeat(20) }) })).status).toBe(200)
    expect((await confirm({ body: JSON.stringify({ token: 'Z_-9'.repeat(50) }) })).status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['backend 400 (wrong, expired or used)', 400, 400, 'NEWSLETTER_TOKEN_INVALID'],
    ['backend 429', 429, 429, 'RATE_LIMITED'],
    ['backend 500', 500, 502, 'UPSTREAM_UNAVAILABLE'],
  ])('%s: %i → %i %s, does not repeat the backend message', async (_label, status, expected, code) => {
    backendAnswers(status, { error: { code: 'TOKEN_REVOKED', message: `token ${TOKEN} was revoked` } })

    const res = await confirm()

    expect(res.status).toBe(expected)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    const text = await res.text()
    expect(JSON.parse(text)).toMatchObject({ error: { code } })
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain('revoked')
  })

  it.each([
    ['Sec-Fetch-Site: cross-site', 403, { 'sec-fetch-site': 'cross-site' }],
    ['Origin of another site', 403, { origin: 'https://evil.example' }],
    ['form of another site (not JSON)', 415, { 'content-type': 'application/x-www-form-urlencoded' }],
  ])('%s: %i, the backend is not called', async (_label, status, headers) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    expect((await confirm({ headers })).status).toBe(status)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('body over 1 KB: 413, the backend is not called', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    expect((await confirm({ body: JSON.stringify({ token: TOKEN, pad: 'x'.repeat(1100) }) })).status).toBe(413)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('20 per hour per IP: the 21st gets 429 without calling the backend; another IP still works', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(9_000_000)
    const fetchSpy = backendAnswers(400, { error: { code: 'NEWSLETTER_TOKEN_INVALID' } })
    const ip = '203.0.113.40'

    for (let i = 0; i < 20; i++) expect((await confirm({ ip })).status, `attempt ${i + 1}`).toBe(400)
    const blocked = await confirm({ ip })
    expect(blocked.status).toBe(429)
    await expect(blocked.json()).resolves.toMatchObject({ error: { code: 'RATE_LIMITED' } })
    expect(fetchSpy).toHaveBeenCalledTimes(20)

    expect((await confirm({ ip: '203.0.113.41' })).status).toBe(400)
  })

  it('backend unreachable: 502; nothing is logged (the token never enters a log)', async () => {
    const logs = (['log', 'info', 'warn', 'error'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}))
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))

    const res = await confirm()

    expect(res.status).toBe(502)
    for (const spy of logs) expect(spy).not.toHaveBeenCalled()
  })
})

/** One request with these headers on top of the usual ones (the helper's own X-Forwarded-For is replaced when given). */
function sendWith(headers: Record<string, string>) {
  return confirm({ headers })
}

describe('POST /api/newsletter/confirm: the visitor address for the backend', () => {
  const TOKEN_ENV = '  shared-token-for-tests  '

  it('sends the address counted from the right of X-Forwarded-For with the shared token, never the first entry the visitor wrote', async () => {
    vi.stubEnv('CLIENT_IP_TOKEN', TOKEN_ENV)
    const fetchSpy = backendAnswers(200)

    await sendWith({ 'x-forwarded-for': '6.6.6.6, 198.51.100.221' })

    const headers = new Headers(fetchSpy.mock.calls[0]![1]?.headers)
    expect(headers.get('x-client-ip')).toBe('198.51.100.221')
    expect(headers.get('x-client-ip-token')).toBe('shared-token-for-tests')
    expect([...headers.values()]).not.toContain('6.6.6.6')
  })

  it('an address nobody vouches for (a junk entry) sends only the token: the backend counts it as unknown', async () => {
    vi.stubEnv('CLIENT_IP_TOKEN', TOKEN_ENV)
    const fetchSpy = backendAnswers(200)

    await sendWith({ 'x-forwarded-for': 'not-an-ip' })

    const headers = new Headers(fetchSpy.mock.calls[0]![1]?.headers)
    expect(headers.has('x-client-ip')).toBe(false)
    expect(headers.get('x-client-ip-token')).toBe('shared-token-for-tests')
  })

  it('without CLIENT_IP_TOKEN (a dev stack) neither header is sent', async () => {
    vi.stubEnv('CLIENT_IP_TOKEN', '   ')
    const fetchSpy = backendAnswers(200)

    await sendWith({ 'x-forwarded-for': '198.51.100.222' })

    const headers = new Headers(fetchSpy.mock.calls[0]![1]?.headers)
    expect(headers.has('x-client-ip')).toBe(false)
    expect(headers.has('x-client-ip-token')).toBe(false)
  })

  it('a visitor cannot choose what the backend is told: x-client-ip and x-client-ip-token written by the visitor are not forwarded', async () => {
    vi.stubEnv('CLIENT_IP_TOKEN', TOKEN_ENV)
    const fetchSpy = backendAnswers(200)

    await sendWith({
      'x-forwarded-for': '198.51.100.223',
      'x-client-ip': '203.0.113.99',
      'x-client-ip-token': 'a-guess',
    })

    const headers = new Headers(fetchSpy.mock.calls[0]![1]?.headers)
    expect(headers.get('x-client-ip')).toBe('198.51.100.223')
    expect(headers.get('x-client-ip-token')).toBe('shared-token-for-tests')
  })
})
