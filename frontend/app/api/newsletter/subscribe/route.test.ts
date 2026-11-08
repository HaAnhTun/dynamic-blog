// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from './route'

const ORIGIN = 'http://localhost:3000'
const ADDRESS = 'Doc.Gia+blog@Example.com'

/* Each request uses its own IP: the per-IP quota in lib/rate-limit.ts lives for the whole file. */
let ipCounter = 0
function freshIp(): string {
  ipCounter += 1
  return `198.51.100.${ipCounter}`
}

/** A same-origin fetch as callBff sends it from the form at /newsletter, with a reader session cookie. */
function subscribe({
  body = JSON.stringify({ email: ADDRESS }),
  headers = {},
  ip = freshIp(),
}: { body?: string; headers?: Record<string, string>; ip?: string } = {}) {
  return POST(
    new NextRequest(`${ORIGIN}/api/newsletter/subscribe`, {
      method: 'POST',
      headers: {
        host: 'localhost:3000',
        origin: ORIGIN,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
        cookie: 'access_token=reader-access; refresh_token=reader-refresh',
        'x-forwarded-for': ip,
        ...headers,
      },
      body,
    }),
  )
}

function backendAnswers(status: number, body: unknown = { data: { status: 'PENDING_CONFIRMATION' } }) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => (status === 204 ? new Response(null, { status }) : Response.json(body, { status })))
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('POST /api/newsletter/subscribe', () => {
  it.each([
    ['a known locale is forwarded', 'en', { email: ADDRESS, locale: 'en' }],
    ['an unknown locale is left out', 'fr', { email: ADDRESS }],
    ['a non-string locale is left out', 7, { email: ADDRESS }],
  ])('%s', async (_label, locale, expected) => {
    vi.stubEnv('API_BASE_URL', 'http://backend.test:8080')
    const fetchSpy = backendAnswers(202)

    const res = await subscribe({ body: JSON.stringify({ email: ADDRESS, locale }) })

    expect(res.status).toBe(202)
    expect(fetchSpy.mock.calls[0]![1]).toMatchObject({ body: JSON.stringify(expected) })
  })

  it('forwards exactly the trimmed `{ email }` to the backend as a guest (no Bearer, no cookie); 202 private no-store', async () => {
    vi.stubEnv('API_BASE_URL', 'http://backend.test:8080')
    const fetchSpy = backendAnswers(202)

    const res = await subscribe({ body: JSON.stringify({ email: `  ${ADDRESS} `, role: 'ADMIN' }) })

    expect(res.status).toBe(202)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toEqual({ data: { status: 'PENDING_CONFIRMATION' } })
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(String(url)).toBe('http://backend.test:8080/api/v1/newsletter/subscriptions')
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ email: ADDRESS }), cache: 'no-store' })
    const headers = new Headers(init?.headers)
    expect(headers.has('authorization')).toBe(false)
    expect(headers.has('cookie')).toBe(false)
  })

  it('one answer for every address state: any backend 2xx gives the same status and body, carrying no address', async () => {
    const answers: string[] = []
    for (const [status, body] of [
      [202, { data: { status: 'PENDING_CONFIRMATION' } }],
      [202, { data: { status: 'ALREADY_CONFIRMED', email: ADDRESS } }],
      [200, {}],
      [204, null],
    ] as const) {
      backendAnswers(status, body)
      const res = await subscribe()
      expect(res.status, `backend ${status}`).toBe(202)
      answers.push(await res.text())
      vi.restoreAllMocks()
    }

    expect(new Set(answers).size).toBe(1)
    expect(answers[0]!.toLowerCase()).not.toContain(ADDRESS.toLowerCase())
  })

  it('backend 400: VALIDATION_ERROR with a generic sentence, not repeating the backend message (or address)', async () => {
    backendAnswers(400, { error: { code: 'VALIDATION_ERROR', message: `email ${ADDRESS} is not valid` } })

    const res = await subscribe()

    expect(res.status).toBe(400)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    const text = await res.text()
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
    expect(text).not.toContain(ADDRESS)
    expect(text).not.toContain('is not valid')
  })

  it.each([
    ['not JSON', 'email=a@b.c'],
    ['array', '[]'],
    ['missing email', '{}'],
    ['email that is not a string', '{"email":42}'],
    ['email of whitespace only', '{"email":"   "}'],
    ['email longer than 254 characters', JSON.stringify({ email: `${'a'.repeat(250)}@b.cd` })],
  ])('invalid body (%s): 400 VALIDATION_ERROR, the backend is not called', async (_label, body) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await subscribe({ body })

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each([
    ['Sec-Fetch-Site: cross-site', 403, { 'sec-fetch-site': 'cross-site' }],
    ['Origin of another site', 403, { origin: 'https://evil.example' }],
    ['form of another site (not JSON)', 415, { 'content-type': 'application/x-www-form-urlencoded' }],
  ])('%s: %i, the backend is not called', async (_label, status, headers) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await subscribe({ headers })

    expect(res.status).toBe(status)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('body over 1 KB (actually measured, or declared by content-length): 413, the backend is not called', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    expect((await subscribe({ body: JSON.stringify({ email: `${'a'.repeat(1100)}@b.cd` }) })).status).toBe(413)
    expect((await subscribe({ headers: { 'content-length': '5000' } })).status).toBe(413)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('5 per hour per IP: the 6th gets 429 RATE_LIMITED without calling the backend; another IP still works; the next hour works again', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(7_000_000)
    const fetchSpy = backendAnswers(202)
    const ip = '203.0.113.25'

    for (let i = 0; i < 5; i++) expect((await subscribe({ ip })).status, `attempt ${i + 1}`).toBe(202)
    const blocked = await subscribe({ ip })
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('cache-control')).toBe('private, no-store')
    expect(await blocked.text()).not.toContain(ADDRESS)
    expect(fetchSpy).toHaveBeenCalledTimes(5)

    expect((await subscribe({ ip: '203.0.113.26' })).status).toBe(202)
    now.mockReturnValue(7_000_000 + 60 * 60_000)
    expect((await subscribe({ ip })).status).toBe(202)
  })

  it.each([
    ['backend unreachable', null, 502],
    ['backend 500', 500, 502],
    ['backend without the endpoint (404)', 404, 502],
    ['backend 429', 429, 429],
  ])('%s: %i, nothing is logged', async (_label, status, expected) => {
    const logs = (['log', 'info', 'warn', 'error'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}))
    if (status === null) vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))
    else backendAnswers(status, { error: { code: 'X', message: `about ${ADDRESS}` } })

    const res = await subscribe()

    expect(res.status).toBe(expected)
    expect(await res.text()).not.toContain(ADDRESS)
    for (const spy of logs) expect(spy).not.toHaveBeenCalled()
  })
})

/** One request with these headers on top of the usual ones (the helper's own X-Forwarded-For is replaced when given). */
function sendWith(headers: Record<string, string>) {
  return subscribe({ headers })
}

describe('POST /api/newsletter/subscribe: the visitor address for the backend', () => {
  const TOKEN_ENV = '  shared-token-for-tests  '

  it('sends the address counted from the right of X-Forwarded-For with the shared token, never the first entry the visitor wrote', async () => {
    vi.stubEnv('CLIENT_IP_TOKEN', TOKEN_ENV)
    const fetchSpy = backendAnswers(202)

    await sendWith({ 'x-forwarded-for': '6.6.6.6, 198.51.100.211' })

    const headers = new Headers(fetchSpy.mock.calls[0]![1]?.headers)
    expect(headers.get('x-client-ip')).toBe('198.51.100.211')
    expect(headers.get('x-client-ip-token')).toBe('shared-token-for-tests')
    expect([...headers.values()]).not.toContain('6.6.6.6')
  })

  it('an address nobody vouches for (a junk entry) sends only the token: the backend counts it as unknown', async () => {
    vi.stubEnv('CLIENT_IP_TOKEN', TOKEN_ENV)
    const fetchSpy = backendAnswers(202)

    await sendWith({ 'x-forwarded-for': 'not-an-ip' })

    const headers = new Headers(fetchSpy.mock.calls[0]![1]?.headers)
    expect(headers.has('x-client-ip')).toBe(false)
    expect(headers.get('x-client-ip-token')).toBe('shared-token-for-tests')
  })

  it('without CLIENT_IP_TOKEN (a dev stack) neither header is sent', async () => {
    vi.stubEnv('CLIENT_IP_TOKEN', '   ')
    const fetchSpy = backendAnswers(202)

    await sendWith({ 'x-forwarded-for': '198.51.100.212' })

    const headers = new Headers(fetchSpy.mock.calls[0]![1]?.headers)
    expect(headers.has('x-client-ip')).toBe(false)
    expect(headers.has('x-client-ip-token')).toBe(false)
  })

  it('a visitor cannot choose what the backend is told: x-client-ip and x-client-ip-token written by the visitor are not forwarded', async () => {
    vi.stubEnv('CLIENT_IP_TOKEN', TOKEN_ENV)
    const fetchSpy = backendAnswers(202)

    await sendWith({
      'x-forwarded-for': '198.51.100.213',
      'x-client-ip': '203.0.113.99',
      'x-client-ip-token': 'a-guess',
    })

    const headers = new Headers(fetchSpy.mock.calls[0]![1]?.headers)
    expect(headers.get('x-client-ip')).toBe('198.51.100.213')
    expect(headers.get('x-client-ip-token')).toBe('shared-token-for-tests')
  })
})
