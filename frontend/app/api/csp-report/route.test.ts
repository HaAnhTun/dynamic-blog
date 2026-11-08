// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { POST } from './route'

/* Each test uses its own IP: the per-IP quota in lib/rate-limit.ts lives for the whole file. */
let ipCounter = 0
function freshIp(): string {
  ipCounter += 1
  return `198.51.100.${ipCounter}`
}

const LEGACY = 'application/csp-report'
const REPORTING_API = 'application/reports+json'

function legacyBody(report: Record<string, unknown> = {}): string {
  return JSON.stringify({
    'csp-report': {
      'document-uri': 'https://blog.example/search?q=my+private+search&token=abc',
      referrer: 'https://blog.example/login?next=/admin',
      'effective-directive': 'script-src-elem',
      'violated-directive': "script-src-elem 'self'",
      'blocked-uri': 'https://evil.example/steal.js?cookie=secret',
      'source-file': 'https://blog.example/posts/x?session=1',
      'script-sample': 'alert(document.cookie)',
      'original-policy': "default-src 'self'; report-uri /api/csp-report",
      ...report,
    },
  })
}

function send({
  body = legacyBody(),
  type = LEGACY,
  ip = freshIp(),
}: { body?: BodyInit | null; type?: string | null; ip?: string | null } = {}) {
  return POST(
    new Request('http://localhost:3000/api/csp-report', {
      method: 'POST',
      headers: {
        ...(type === null ? {} : { 'content-type': type }),
        ...(ip === null ? {} : { 'x-forwarded-for': ip }),
      },
      body,
    }),
  )
}

function logged(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.map((call) => call.join(' ')).join('\n')
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('POST /api/csp-report: accepted reports', () => {
  it('answers 204 with no body and logs the directive and the blocked origin only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const res = await send()

    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(logged(warn)).toBe('[csp] violation script-src-elem blocked=https://evil.example')
  })

  it('never logs a document address, a query, a script sample, a referrer or the policy', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    await send()

    const everything = [logged(warn), logged(log), logged(error)].join('\n')
    for (const secret of [
      'my+private+search',
      'token=abc',
      'next=/admin',
      'cookie=secret',
      'session=1',
      'alert(',
      'default-src',
      '/steal.js',
    ]) {
      expect(everything, secret).not.toContain(secret)
    }
  })

  it('reads an application/reports+json batch, one line per violation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const body = JSON.stringify([
      {
        type: 'csp-violation',
        url: 'https://blog.example/?q=x',
        body: { effectiveDirective: 'img-src', blockedURL: 'https://t.example/p.gif?id=7' },
      },
      { type: 'csp-violation', url: 'https://blog.example/', body: { effectiveDirective: 'object-src', blockedURL: 'inline' } },
    ])

    const res = await send({ body, type: REPORTING_API })

    expect(res.status).toBe(204)
    expect(logged(warn).split('\n')).toEqual([
      '[csp] violation img-src blocked=https://t.example',
      '[csp] violation object-src blocked=inline',
    ])
  })

  it('accepts a charset on the media type', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect((await send({ type: 'application/csp-report; charset=utf-8' })).status).toBe(204)
  })

  it('cannot be made to write a line of its own: only the first word of a directive and the origin of an address are kept', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const body = legacyBody({
      'effective-directive': 'img-src\n[csp] violation fake blocked=ok',
      'blocked-uri': 'https://cdn.example.org/\r\n[csp] violation fake blocked=ok',
    })

    await send({ body })

    expect(logged(warn)).toBe('[csp] violation img-src blocked=https://cdn.example.org')
  })

  it('writes "unknown" and "other" for a directive and an address that have no valid shape', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const body = legacyBody({ 'effective-directive': 'img-src;[csp]', 'blocked-uri': 'ftp://files.example.org/x' })

    await send({ body })

    expect(logged(warn)).toBe('[csp] violation unknown blocked=other')
  })

  it('answers 204 and logs nothing for a readable report that holds no violation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const body = JSON.stringify([{ type: 'network-error', body: {} }])

    expect((await send({ body, type: REPORTING_API })).status).toBe(204)
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('POST /api/csp-report: refused requests', () => {
  it.each(['application/json', 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x'])(
    'a %s body is 415, so a plain cross-site form cannot post here',
    async (type) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const res = await send({ type })

      expect(res.status).toBe(415)
      expect(warn).not.toHaveBeenCalled()
    },
  )

  it('a request with no Content-Type is 415', async () => {
    expect((await send({ type: null })).status).toBe(415)
  })

  it.each(['', 'not json', '{', '5', 'null'])('the body %j is 400', async (body) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect((await send({ body })).status).toBe(400)
    expect(warn).not.toHaveBeenCalled()
  })

  it('a body over 8 KiB is 413 and is not parsed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const big = legacyBody({ 'script-sample': 'x'.repeat(9 * 1024) })

    const res = await send({ body: big })

    expect(res.status).toBe(413)
    expect(warn).not.toHaveBeenCalled()
  })

  it('a body over the cap is refused even when its length is not declared', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const chunk = new TextEncoder().encode('x'.repeat(1024))
    let sent = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 20) controller.enqueue(chunk)
        else controller.close()
      },
    })

    const res = await POST(
      new Request('http://localhost:3000/api/csp-report', {
        method: 'POST',
        headers: { 'content-type': LEGACY, 'x-forwarded-for': freshIp() },
        body: stream,
        // @ts-expect-error Node's fetch needs the duplex mode for a streamed body.
        duplex: 'half',
      }),
    )

    expect(res.status).toBe(413)
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('POST /api/csp-report: per-IP limit', () => {
  it('lets 100 reports of an address through in a window, then answers 429 and logs nothing more', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ip = freshIp()

    for (let i = 0; i < 100; i += 1) expect((await send({ ip })).status).toBe(204)
    const refused = await send({ ip })

    expect(refused.status).toBe(429)
    expect(warn).toHaveBeenCalledTimes(100)
    // Another address is not affected.
    expect((await send({ ip: freshIp() })).status).toBe(204)
  })

  it('counts an unknown address in a bucket of its own, not as a free pass', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const answers: number[] = []
    for (let i = 0; i < 101; i += 1) answers.push((await send({ ip: null })).status)

    expect(answers.at(-1)).toBe(429)
  })
})
