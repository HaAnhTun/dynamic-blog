// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from './route'

const ORIGIN = 'http://localhost:3000'
const VALID = {
  name: 'Reader Example',
  email: 'reader@example.test',
  subject: 'A question',
  message: 'Hello, I would like to ask a question.',
}

/* Each request uses its own IP: the per-IP quota in lib/rate-limit.ts lives for the whole file. */
let ipCounter = 0
function freshIp(): string {
  ipCounter += 1
  return `203.0.113.${ipCounter}`
}

function send({
  body = JSON.stringify(VALID),
  headers = {},
  ip = freshIp(),
}: { body?: string; headers?: Record<string, string>; ip?: string } = {}) {
  return POST(
    new NextRequest(`${ORIGIN}/api/contact`, {
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

function backendAnswers(status: number, body: unknown = { data: { status: 'RECEIVED' } }) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => (status === 204 ? new Response(null, { status }) : Response.json(body, { status })))
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('POST /api/contact', () => {
  it('forwards the trimmed fields to the backend as a guest, and answers a constant 202 private no-store', async () => {
    vi.stubEnv('API_BASE_URL', 'http://backend.test:8080')
    const fetchSpy = backendAnswers(202, { data: { status: 'RECEIVED', echoed: VALID.email } })

    const res = await send({
      body: JSON.stringify({
        name: `  ${VALID.name} `,
        email: ` ${VALID.email}  `,
        subject: ` ${VALID.subject} `,
        message: `  ${VALID.message}  `,
        locale: 'en',
        role: 'ADMIN',
      }),
    })

    expect(res.status).toBe(202)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(await res.json()).toEqual({ data: { status: 'RECEIVED' } })
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(String(url)).toBe('http://backend.test:8080/api/v1/contact/messages')
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ ...VALID, locale: 'en' }), cache: 'no-store' })
    const headers = new Headers(init?.headers)
    expect(headers.has('authorization')).toBe(false)
    expect(headers.has('cookie')).toBe(false)
  })

  it.each([
    ['an unknown locale is left out', 'fr'],
    ['a non-string locale is left out', 7],
  ])('%s', async (_label, locale) => {
    const fetchSpy = backendAnswers(202)

    const res = await send({ body: JSON.stringify({ ...VALID, locale }) })

    expect(res.status).toBe(202)
    expect(fetchSpy.mock.calls[0]![1]).toMatchObject({ body: JSON.stringify(VALID) })
  })

  it('a missing subject is sent as an empty string', async () => {
    const fetchSpy = backendAnswers(202)
    const res = await send({ body: JSON.stringify({ ...VALID, subject: undefined }) })

    expect(res.status).toBe(202)
    expect(fetchSpy.mock.calls[0]![1]).toMatchObject({ body: JSON.stringify({ ...VALID, subject: '' }) })
  })

  it.each([
    ['a text', 'https://spam.example'],
    ['a number', 1],
    ['a boolean', true],
  ])('honeypot filled with %s: the normal 202 and the backend is not called', async (_label, website) => {
    const fetchSpy = backendAnswers(202)

    const res = await send({ body: JSON.stringify({ ...VALID, website }) })

    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ data: { status: 'RECEIVED' } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['null', null],
  ])('honeypot %s: the message is forwarded', async (_label, website) => {
    const fetchSpy = backendAnswers(202)

    const res = await send({ body: JSON.stringify({ ...VALID, website }) })

    expect(res.status).toBe(202)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('a filled honeypot does not use up the quota of the IP', async () => {
    const fetchSpy = backendAnswers(202)
    const ip = freshIp()

    for (let i = 0; i < 8; i += 1) {
      expect((await send({ ip, body: JSON.stringify({ ...VALID, website: 'x' }) })).status).toBe(202)
    }
    expect((await send({ ip })).status).toBe(202)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['not JSON', 'name=a'],
    ['an array', '[]'],
    ['an empty object', '{}'],
    ['a name of blanks', JSON.stringify({ ...VALID, name: '   ' })],
    ['a name that is not a string', JSON.stringify({ ...VALID, name: 42 })],
    ['a name over 100 characters', JSON.stringify({ ...VALID, name: 'a'.repeat(101) })],
    ['an email without @', JSON.stringify({ ...VALID, email: 'reader.example.test' })],
    ['an email without a domain dot', JSON.stringify({ ...VALID, email: 'reader@example' })],
    ['an email with a space', JSON.stringify({ ...VALID, email: 'rea der@example.test' })],
    ['an email over 254 characters', JSON.stringify({ ...VALID, email: `${'a'.repeat(250)}@b.cd` })],
    ['a subject over 150 characters', JSON.stringify({ ...VALID, subject: 'a'.repeat(151) })],
    ['a subject that is not a string', JSON.stringify({ ...VALID, subject: ['x'] })],
    ['a message under 10 characters', JSON.stringify({ ...VALID, message: 'too short' })],
    ['a message of blanks', JSON.stringify({ ...VALID, message: ' '.repeat(40) })],
    ['a message over 5000 characters', JSON.stringify({ ...VALID, message: 'a'.repeat(5001) })],
    ['a message that is not a string', JSON.stringify({ ...VALID, message: { text: VALID.message } })],
  ])('%s: 400 VALIDATION_ERROR, nothing echoed, backend not called', async (_label, body) => {
    const fetchSpy = backendAnswers(202)

    const res = await send({ body })

    expect(res.status).toBe(400)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    const text = await res.text()
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
    expect(text).not.toContain(VALID.email)
    expect(text).not.toContain(VALID.name)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('accepts the limits exactly', async () => {
    backendAnswers(202)

    const res = await send({
      body: JSON.stringify({
        name: 'a'.repeat(100),
        email: `${'a'.repeat(240)}@example.test`,
        subject: 'b'.repeat(150),
        message: 'c'.repeat(5000),
      }),
    })

    expect(res.status).toBe(202)
    expect((await send({ body: JSON.stringify({ ...VALID, message: 'c'.repeat(10) }) })).status).toBe(202)
  })

  it('a body over 16 KB: 413 and the backend is not called', async () => {
    const fetchSpy = backendAnswers(202)

    const res = await send({ body: JSON.stringify({ ...VALID, message: 'a'.repeat(20_000) }) })

    expect(res.status).toBe(413)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each([
    ['a foreign Origin', { origin: 'https://evil.example' }],
    ['Sec-Fetch-Site cross-site', { 'sec-fetch-site': 'cross-site' }],
  ])('%s: refused with 403 and the backend is not called', async (_label, headers) => {
    const fetchSpy = backendAnswers(202)

    const res = await send({ headers })

    expect(res.status).toBe(403)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a body that is not JSON by content type: 415', async () => {
    const fetchSpy = backendAnswers(202)

    const res = await send({ headers: { 'content-type': 'text/plain' } })

    expect(res.status).toBe(415)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rate limit: the sixth valid message in an hour from one IP is 429 RATE_LIMITED without a backend call; another IP is not affected', async () => {
    const fetchSpy = backendAnswers(202)
    const ip = freshIp()

    for (let i = 0; i < 5; i += 1) expect((await send({ ip })).status, `attempt ${i + 1}`).toBe(202)
    const blocked = await send({ ip })

    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } })
    expect(fetchSpy).toHaveBeenCalledTimes(5)
    expect((await send()).status).toBe(202)
  })

  it('invalid messages do not use up the quota', async () => {
    backendAnswers(202)
    const ip = freshIp()

    for (let i = 0; i < 8; i += 1) expect((await send({ ip, body: '{}' })).status).toBe(400)
    expect((await send({ ip })).status).toBe(202)
  })

  it('backend 400: VALIDATION_ERROR with a generic sentence, not repeating the backend message', async () => {
    backendAnswers(400, { error: { code: 'VALIDATION_ERROR', message: `email ${VALID.email} is not valid` } })

    const res = await send()

    expect(res.status).toBe(400)
    const text = await res.text()
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
    expect(text).not.toContain(VALID.email)
    expect(text).not.toContain('is not valid')
  })

  it('backend 429: RATE_LIMITED', async () => {
    backendAnswers(429, { error: { code: 'RATE_LIMITED', message: 'Too many messages for reader@example.test' } })

    const res = await send()

    expect(res.status).toBe(429)
    const text = await res.text()
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'RATE_LIMITED' } })
    expect(text).not.toContain(VALID.email)
  })

  it.each([404, 500, 503])('backend %i: 502 UPSTREAM_UNAVAILABLE', async (status) => {
    backendAnswers(status, { error: { code: 'X', message: `secret ${VALID.email}` } })

    const res = await send()

    expect(res.status).toBe(502)
    const text = await res.text()
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'UPSTREAM_UNAVAILABLE' } })
    expect(text).not.toContain(VALID.email)
  })

  it('backend unreachable: the existing unreachable answer', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'))

    const res = await send()

    expect(res.status).toBe(502)
    expect(await res.text()).not.toContain(VALID.email)
  })

  it('logs nothing, whatever the outcome', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    )
    for (const status of [202, 400, 429, 500]) {
      backendAnswers(status)
      await send()
      vi.mocked(globalThis.fetch).mockRestore()
    }
    await send({ body: JSON.stringify({ ...VALID, website: 'x' }) })
    await send({ body: '{}' })

    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })
})

/** One request with these headers on top of the usual ones (the helper's own X-Forwarded-For is replaced when given). */
function sendWith(headers: Record<string, string>) {
  return send({ headers })
}

describe('POST /api/contact: the visitor address for the backend', () => {
  const TOKEN_ENV = '  shared-token-for-tests  '

  it('sends the address counted from the right of X-Forwarded-For with the shared token, never the first entry the visitor wrote', async () => {
    vi.stubEnv('CLIENT_IP_TOKEN', TOKEN_ENV)
    const fetchSpy = backendAnswers(202)

    await sendWith({ 'x-forwarded-for': '6.6.6.6, 198.51.100.201' })

    const headers = new Headers(fetchSpy.mock.calls[0]![1]?.headers)
    expect(headers.get('x-client-ip')).toBe('198.51.100.201')
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

    await sendWith({ 'x-forwarded-for': '198.51.100.202' })

    const headers = new Headers(fetchSpy.mock.calls[0]![1]?.headers)
    expect(headers.has('x-client-ip')).toBe(false)
    expect(headers.has('x-client-ip-token')).toBe(false)
  })

  it('a visitor cannot choose what the backend is told: x-client-ip and x-client-ip-token written by the visitor are not forwarded', async () => {
    vi.stubEnv('CLIENT_IP_TOKEN', TOKEN_ENV)
    const fetchSpy = backendAnswers(202)

    await sendWith({
      'x-forwarded-for': '198.51.100.203',
      'x-client-ip': '203.0.113.99',
      'x-client-ip-token': 'a-guess',
    })

    const headers = new Headers(fetchSpy.mock.calls[0]![1]?.headers)
    expect(headers.get('x-client-ip')).toBe('198.51.100.203')
    expect(headers.get('x-client-ip-token')).toBe('shared-token-for-tests')
  })
})
