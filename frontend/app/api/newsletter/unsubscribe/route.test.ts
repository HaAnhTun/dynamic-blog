// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import * as route from './route'

const ORIGIN = 'http://localhost:3000'
const TOKEN = 'u7Kd2Qm9Xa4Wn1Lp8Rt3Ys6Vb0Ce5Fg-Hj_Iz2Ok4Q'

let ipCounter = 0
function freshIp(): string {
  ipCounter += 1
  return `198.51.100.${ipCounter}`
}

/** The "Unsubscribe" button at /newsletter/unsubscribe: same-origin fetch, JSON, token in the body. */
function fromPage({ body = JSON.stringify({ token: TOKEN }), ip = freshIp(), query = '' } = {}) {
  return route.POST(
    new NextRequest(`${ORIGIN}/api/newsletter/unsubscribe${query}`, {
      method: 'POST',
      headers: {
        host: 'localhost:3000',
        origin: ORIGIN,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
        'x-forwarded-for': ip,
      },
      body,
    }),
  )
}

/**
 * One-click POST (RFC 8058) as a mail provider sends it from their own machine: cross-origin, token in the query, form body. It also carries
 * a reader session cookie, to show the route forwards it nowhere.
 */
function oneClick({
  token = TOKEN as string | null,
  body = new URLSearchParams({ 'List-Unsubscribe': 'One-Click' }) as BodyInit,
  headers = {} as Record<string, string>,
  ip = freshIp(),
} = {}) {
  const query = token === null ? '' : `?token=${encodeURIComponent(token)}`
  return route.POST(
    new NextRequest(`${ORIGIN}/api/newsletter/unsubscribe${query}`, {
      method: 'POST',
      headers: {
        host: 'localhost:3000',
        origin: 'https://mail.example.com',
        'sec-fetch-site': 'cross-site',
        cookie: 'access_token=reader-access; refresh_token=reader-refresh',
        'x-forwarded-for': ip,
        ...headers,
      },
      body,
    }),
  )
}

function backendAnswers(status: number, body: unknown = { data: { status: 'UNSUBSCRIBED' } }) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(body, { status }))
}

function sentTo(fetchSpy: ReturnType<typeof backendAnswers>, n = 0) {
  const [url, init] = fetchSpy.mock.calls[n]!
  return { path: new URL(String(url)).pathname, init: init!, headers: new Headers(init?.headers) }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('POST /api/newsletter/unsubscribe', () => {
  it('POST only: opening the unsubscribe link (a mail scanner opens it before the reader) cancels nothing', () => {
    expect(Object.keys(route)).toEqual(['POST'])
  })

  it('from the page: JSON `{ token }` to the backend as a guest; 200 UNSUBSCRIBED, private no-store', async () => {
    const fetchSpy = backendAnswers(200)

    const res = await fromPage()

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toEqual({ data: { status: 'UNSUBSCRIBED' } })
    const sent = sentTo(fetchSpy)
    expect(sent.path).toBe('/api/v1/newsletter/unsubscribe')
    expect(sent.init).toMatchObject({ method: 'POST', body: JSON.stringify({ token: TOKEN }) })
  })

  it.each([
    ['urlencoded', new URLSearchParams({ 'List-Unsubscribe': 'One-Click' })],
    [
      'multipart/form-data',
      (() => {
        const form = new FormData()
        form.append('List-Unsubscribe', 'One-Click')
        return form
      })(),
    ],
  ])(
    'one click, body %s, cross-origin: no 403/415; the query token reaches the backend, with no cookie or Bearer following',
    async (_label, body) => {
      const fetchSpy = backendAnswers(200)

      const res = await oneClick({ body })

      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual({ data: { status: 'UNSUBSCRIBED' } })
      const sent = sentTo(fetchSpy)
      expect(sent.path).toBe('/api/v1/newsletter/unsubscribe')
      expect(sent.init.body).toBe(JSON.stringify({ token: TOKEN }))
      expect(sent.headers.has('cookie')).toBe(false)
      expect(sent.headers.has('authorization')).toBe(false)
    },
  )

  it('repeated: always 200, the same body', async () => {
    backendAnswers(200)

    const first = await oneClick()
    const second = await oneClick()

    expect([first.status, second.status]).toEqual([200, 200])
    expect(await second.text()).toBe(await first.text())
  })

  it.each([
    ['missing List-Unsubscribe=One-Click pair', new URLSearchParams({ foo: 'bar' })],
    ['a value other than One-Click', new URLSearchParams({ 'List-Unsubscribe': 'Yes' })],
  ])('form %s: 400, the backend is not called', async (_label, body) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await oneClick({ body })

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each([
    ['text/plain', { 'content-type': 'text/plain' }],
    ['no Content-Type', { 'content-type': '' }],
  ])('body %s: 415, the backend is not called', async (_label, headers) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await oneClick({ body: 'List-Unsubscribe=One-Click', headers })

    expect(res.status).toBe(415)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('checks the token shape before building the backend call: missing or malformed query; JSON does not take the token from the query', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    for (const res of [
      await oneClick({ token: null }),
      await oneClick({ token: 'ngan' }),
      await oneClick({ token: `../admin/${TOKEN}` }),
      await fromPage({ body: '{}', query: `?token=${TOKEN}` }),
    ]) {
      expect(res.status).toBe(400)
      await expect(res.json()).resolves.toMatchObject({ error: { code: 'NEWSLETTER_TOKEN_INVALID' } })
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('backend 400: one generic sentence, repeating neither message nor token; backend 429: 429', async () => {
    backendAnswers(400, { error: { code: 'NEWSLETTER_TOKEN_INVALID', message: `bad signature for ${TOKEN}` } })
    const invalid = await oneClick()
    expect(invalid.status).toBe(400)
    const text = await invalid.text()
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'NEWSLETTER_TOKEN_INVALID' } })
    expect(text).not.toContain(TOKEN)

    vi.restoreAllMocks()
    backendAnswers(429, { error: { code: 'RATE_LIMITED' } })
    expect((await oneClick()).status).toBe(429)
  })

  it('body over 1 KB: 413, the backend is not called', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await oneClick({ body: new URLSearchParams({ 'List-Unsubscribe': 'One-Click', pad: 'x'.repeat(1100) }) })

    expect(res.status).toBe(413)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('20 per hour per IP: the 21st gets 429 without calling the backend', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(11_000_000)
    const fetchSpy = backendAnswers(200)
    const ip = '203.0.113.60'

    for (let i = 0; i < 20; i++) expect((await oneClick({ ip })).status, `attempt ${i + 1}`).toBe(200)
    const blocked = await oneClick({ ip })
    expect(blocked.status).toBe(429)
    await expect(blocked.json()).resolves.toMatchObject({ error: { code: 'RATE_LIMITED' } })
    expect(fetchSpy).toHaveBeenCalledTimes(20)
  })

  it('nothing is logged, even when the backend is unreachable: the URL and token never enter a log', async () => {
    const logs = (['log', 'info', 'warn', 'error'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}))
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))

    expect((await oneClick()).status).toBe(502)
    expect((await fromPage()).status).toBe(502)
    for (const spy of logs) expect(spy).not.toHaveBeenCalled()
  })
})

/** One one-click request with these headers on top of the usual ones (the helper's own X-Forwarded-For is replaced when given). */
function sendWith(headers: Record<string, string>) {
  return oneClick({ headers })
}

describe('POST /api/newsletter/unsubscribe: the visitor address for the backend', () => {
  const TOKEN_ENV = '  shared-token-for-tests  '

  it('sends the address counted from the right of X-Forwarded-For with the shared token, never the first entry the visitor wrote', async () => {
    vi.stubEnv('CLIENT_IP_TOKEN', TOKEN_ENV)
    const fetchSpy = backendAnswers(200)

    await sendWith({ 'x-forwarded-for': '6.6.6.6, 198.51.100.231' })

    const headers = new Headers(fetchSpy.mock.calls[0]![1]?.headers)
    expect(headers.get('x-client-ip')).toBe('198.51.100.231')
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

    await sendWith({ 'x-forwarded-for': '198.51.100.232' })

    const headers = new Headers(fetchSpy.mock.calls[0]![1]?.headers)
    expect(headers.has('x-client-ip')).toBe(false)
    expect(headers.has('x-client-ip-token')).toBe(false)
  })

  it('a visitor cannot choose what the backend is told: x-client-ip and x-client-ip-token written by the visitor are not forwarded', async () => {
    vi.stubEnv('CLIENT_IP_TOKEN', TOKEN_ENV)
    const fetchSpy = backendAnswers(200)

    await sendWith({
      'x-forwarded-for': '198.51.100.233',
      'x-client-ip': '203.0.113.99',
      'x-client-ip-token': 'a-guess',
    })

    const headers = new Headers(fetchSpy.mock.calls[0]![1]?.headers)
    expect(headers.get('x-client-ip')).toBe('198.51.100.233')
    expect(headers.get('x-client-ip-token')).toBe('shared-token-for-tests')
  })
})
