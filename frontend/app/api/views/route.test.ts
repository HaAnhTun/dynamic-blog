// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from './route'

/*
 * The real `after()` throws E468 outside a Next request, so it is replaced with a mock
 * that keeps the callback. Tests run the callback by hand to check the backend call — in the order
 * Next does it: return 204 first, count afterwards. (vi.mock and vi.hoisted are hoisted above imports by Vitest.)
 */
const { afterMock } = vi.hoisted(() => ({ afterMock: vi.fn() }))
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: afterMock,
}))

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

/** One IP per request, so the route's duplicate-count memory does not link tests together. */
let ipCounter = 0
function freshIp(): string {
  ipCounter += 1
  return `10.1.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`
}

function beacon(body: BodyInit | null, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:3000/api/views', {
    method: 'POST',
    body,
    headers: {
      'sec-fetch-site': 'same-origin',
      'user-agent': CHROME,
      'x-forwarded-for': freshIp(),
      ...headers,
    },
  })
}

/** Runs the callback the route handed to after() — the backend call lives in it. */
async function runAfter(index = 0): Promise<void> {
  const callback = afterMock.mock.calls[index]?.[0] as (() => unknown) | undefined
  if (!callback) throw new Error(`after() was not called for call number ${index + 1}`)
  await callback()
}

beforeEach(() => {
  afterMock.mockClear()
  vi.stubEnv('VIEWS_TOKEN', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('POST /api/views: blocked before counting', () => {
  it.each(['cross-site', 'same-site', 'none'])('Sec-Fetch-Site: %s gives 403 and is not counted', async (site) => {
    const res = await POST(beacon('bai-viet', { 'sec-fetch-site': site }))

    expect(res.status).toBe(403)
    expect(afterMock).not.toHaveBeenCalled()
  })

  it('a browser that does not send Sec-Fetch-Site (old Safari) is still counted', async () => {
    const request = beacon('bai-viet')
    request.headers.delete('sec-fetch-site')

    const res = await POST(request)

    expect(res.status).toBe(204)
    expect(afterMock).toHaveBeenCalledTimes(1)
  })

  it('a declared content-length over 512 bytes gives 413 without reading the body', async () => {
    const res = await POST(beacon('bai-viet', { 'content-length': '600' }))

    expect(res.status).toBe(413)
    expect(afterMock).not.toHaveBeenCalled()
  })

  it('a body actually over 512 bytes without a declared content-length is also 413', async () => {
    const request = beacon('a'.repeat(513))
    expect(request.headers.get('content-length')).toBeNull()

    const res = await POST(request)

    expect(res.status).toBe(413)
    expect(afterMock).not.toHaveBeenCalled()
  })

  it('a bot UA gets 204 but the backend is not called', async () => {
    const res = await POST(
      beacon('bai-viet', { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' }),
    )

    expect(res.status).toBe(204)
    expect(afterMock).not.toHaveBeenCalled()
  })

  it.each(['Bad Slug', '', '   ', '../admin', 'bai_viet', 'Bai-Viet', 'a'.repeat(256)])(
    'slug %j with a bad shape gives 400',
    async (slug) => {
      const res = await POST(beacon(slug))

      expect(res.status).toBe(400)
      expect(afterMock).not.toHaveBeenCalled()
    },
  )

  it('a slug of exactly 255 characters is still valid', async () => {
    const res = await POST(beacon('a'.repeat(255)))

    expect(res.status).toBe(204)
  })
})

describe('POST /api/views: counting', () => {
  it('a valid (trimmed) slug gives 204 no-store and after sends a POST to the backend', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 204 }))

    const res = await POST(beacon('  bai-viet-1 \n'))

    expect(res.status).toBe(204)
    expect(res.headers.get('cache-control')).toBe('no-store')
    // The backend has not been called yet when the response exists: the count runs afterwards and does not slow the page.
    expect(fetchSpy).not.toHaveBeenCalled()

    await runAfter()

    const [url, init] = fetchSpy.mock.calls[0]!
    expect(new URL(String(url)).pathname).toBe('/api/v1/posts/bai-viet-1/views')
    expect(init).toMatchObject({ method: 'POST', cache: 'no-store' })
    expect(new Headers(init!.headers).has('x-view-token')).toBe(false)
  })

  it('sends X-View-Token when VIEWS_TOKEN is set', async () => {
    vi.stubEnv('VIEWS_TOKEN', 'bi-mat-chung')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 204 }))

    await POST(beacon('bai-viet-2'))
    await runAfter()

    expect(new Headers(fetchSpy.mock.calls[0]![1]!.headers).get('x-view-token')).toBe('bi-mat-chung')
  })

  it('a whitespace-only VIEWS_TOKEN counts as unset', async () => {
    vi.stubEnv('VIEWS_TOKEN', '   ')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 204 }))

    await POST(beacon('bai-viet-3'))
    await runAfter()

    expect(new Headers(fetchSpy.mock.calls[0]![1]!.headers).has('x-view-token')).toBe(false)
  })

  it('the after callback does not throw when the backend has a network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))

    await POST(beacon('bai-viet-4'))

    await expect(runAfter()).resolves.toBeUndefined()
  })
})

describe('POST /api/views: in-process duplicate suppression', () => {
  it('the same IP, same browser and same post within 30 minutes counts only once', async () => {
    const headers = { 'x-forwarded-for': '203.0.113.7' }

    const first = await POST(beacon('bai-lap', headers))
    const second = await POST(beacon('bai-lap', headers))

    expect(first.status).toBe(204)
    expect(second.status).toBe(204)
    expect(afterMock).toHaveBeenCalledTimes(1)
  })

  it('a different post or a different IP is a different view', async () => {
    await POST(beacon('bai-khac-1', { 'x-forwarded-for': '203.0.113.8' }))
    await POST(beacon('bai-khac-2', { 'x-forwarded-for': '203.0.113.8' }))
    await POST(beacon('bai-khac-1', { 'x-forwarded-for': '203.0.113.9' }))

    expect(afterMock).toHaveBeenCalledTimes(3)
  })

  // Recorded on purpose. The old version pinned "the FIRST IP of X-Forwarded-For is the key", which is exactly what
  // made fake views possible: nginx APPENDS the real address to the end of the client-sent chain, so the first entry is what the client
  // sets itself. Now the key is the trusted proxy's entry, counted from the right (lib/client-ip.ts).
  it('trusted proxy, `fake, real`: the last entry (written by nginx) is the key; changing the first entry does not evade duplicate suppression', async () => {
    await POST(beacon('bai-proxy', { 'x-forwarded-for': '10.0.0.1, 198.51.100.4' }))
    await POST(beacon('bai-proxy', { 'x-forwarded-for': '10.0.0.2, 198.51.100.4' }))
    await POST(beacon('bai-proxy', { 'x-forwarded-for': '198.51.100.4' }))

    expect(afterMock).toHaveBeenCalledTimes(1)
  })

  it('the reverse pair: the same fake first entry with a different last entry means two different readers', async () => {
    await POST(beacon('bai-proxy-2', { 'x-forwarded-for': '6.6.6.6, 198.51.100.5' }))
    await POST(beacon('bai-proxy-2', { 'x-forwarded-for': '6.6.6.6, 198.51.100.6' }))

    expect(afterMock).toHaveBeenCalledTimes(2)
  })

  it('a reader calling directly, no proxy: Next fills X-Forwarded-For with one entry from the socket, and that entry is the key', async () => {
    // IPv4 on a dual-stack socket: Next writes `::ffff:a.b.c.d`.
    await POST(beacon('bai-truc-tiep', { 'x-forwarded-for': '::ffff:203.0.113.20' }))
    await POST(beacon('bai-truc-tiep', { 'x-forwarded-for': '::ffff:203.0.113.20' }))

    expect(afterMock).toHaveBeenCalledTimes(1)
  })

  it('TRUSTED_PROXY_HOPS=2 (Cloudflare then nginx): the key is the second entry from the right, not the Cloudflare IP', async () => {
    vi.stubEnv('TRUSTED_PROXY_HOPS', '2')

    await POST(beacon('bai-cloudflare', { 'x-forwarded-for': 'x, 198.51.100.30, 172.68.0.1' }))
    await POST(beacon('bai-cloudflare', { 'x-forwarded-for': 'y, 198.51.100.30, 172.68.0.2' }))
    expect(afterMock).toHaveBeenCalledTimes(1)

    await POST(beacon('bai-cloudflare', { 'x-forwarded-for': 'x, 198.51.100.31, 172.68.0.1' }))
    expect(afterMock).toHaveBeenCalledTimes(2)
  })

  it.each(['', ' , ', ',', 'garbage', 'unknown', '198.51.100.40,', '198.51.100.41:5678'])(
    'malformed X-Forwarded-For %j: 204, does not throw, counts as an unknown IP',
    async (xff) => {
      const first = await POST(beacon('bai-xff-hong', { 'x-forwarded-for': xff }))
      const second = await POST(beacon('bai-xff-hong', { 'x-forwarded-for': xff }))

      expect(first.status).toBe(204)
      expect(second.status).toBe(204)
      // An unknown IP is not suppressed (test right below): a junk entry must not become its own key.
      expect(afterMock).toHaveBeenCalledTimes(2)
    },
  )

  it('after 30 minutes the same reader is counted again', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    const headers = { 'x-forwarded-for': '203.0.113.10' }

    await POST(beacon('bai-quay-lai', headers))
    now.mockReturnValue(1_000_000 + 29 * 60_000)
    await POST(beacon('bai-quay-lai', headers))
    now.mockReturnValue(1_000_000 + 31 * 60_000)
    await POST(beacon('bai-quay-lai', headers))

    expect(afterMock).toHaveBeenCalledTimes(2)
  })

  it('an unknown IP is not suppressed: if all readers shared one key the count would be too low', async () => {
    const a = beacon('bai-khong-ip')
    const b = beacon('bai-khong-ip')
    a.headers.delete('x-forwarded-for')
    b.headers.delete('x-forwarded-for')

    await POST(a)
    await POST(b)

    expect(afterMock).toHaveBeenCalledTimes(2)
  })
})

/**
 * Quota of 30 beacons per minute per IP (lib/rate-limit.ts, bucket 'views'). The duplicate suppression above
 * keys on IP + browser + post, but the User-Agent and slug are chosen by the client: changing either one is a new
 * view. The quota keys only on IP, so a curl loop that changes slug or UA each time still stops at 30.
 */
describe('POST /api/views: per-IP quota', () => {
  it('one IP sending more than 30 beacons in 60 seconds: from the 31st on it gets 204 without counting; in the next window it counts again', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(5_000_000)
    const headers = { 'x-forwarded-for': '198.51.100.50' }

    for (let i = 0; i < 31; i++) {
      const res = await POST(beacon(`bai-han-muc-${i}`, headers))
      expect(res.status, `beacon ${i + 1}`).toBe(204)
    }
    expect(afterMock).toHaveBeenCalledTimes(30)

    now.mockReturnValue(5_000_000 + 59_999)
    const blocked = await POST(beacon('bai-han-muc-them', headers))
    // 204 like a bot, not 429: a beacon does not read the response, and a spammer does not need to know it was blocked.
    expect(blocked.status).toBe(204)
    expect(blocked.headers.get('cache-control')).toBe('no-store')
    expect(afterMock).toHaveBeenCalledTimes(30)

    now.mockReturnValue(5_000_000 + 60_000)
    await POST(beacon('bai-han-muc-phut-sau', headers))
    expect(afterMock).toHaveBeenCalledTimes(31)
  })

  it('changing the User-Agent and the first X-Forwarded-For entry each time still stops at 30: the quota keys only on the proxy IP', async () => {
    for (let i = 0; i < 40; i++) {
      await POST(
        beacon('cung-mot-bai', {
          'x-forwarded-for': `10.77.${i}.1, 198.51.100.51`,
          'user-agent': `${CHROME} lap/${i}`,
        }),
      )
    }

    expect(afterMock).toHaveBeenCalledTimes(30)
  })

  it('a reader with another IP has their own quota: one IP hitting the cap blocks nobody else', async () => {
    for (let i = 0; i < 31; i++) await POST(beacon(`bai-ip-a-${i}`, { 'x-forwarded-for': '198.51.100.52' }))
    expect(afterMock).toHaveBeenCalledTimes(30)

    await POST(beacon('bai-ip-a-0', { 'x-forwarded-for': '198.51.100.53' }))
    await POST(beacon('bai-ip-a-1', { 'x-forwarded-for': '10.0.0.9, 198.51.100.54' }))

    expect(afterMock).toHaveBeenCalledTimes(32)
  })

  it('unknown IP: no duplicate suppression but a quota still applies, the shared "unknown" bucket of 100 per 10 minutes', async () => {
    // A fresh copy of the module: the "unknown" bucket is one shared key for the whole file, and the tests above already spent
    // part of it. The vi.mock of next/server still applies to this copy.
    vi.resetModules()
    const { POST: freshPost } = await import('./route')

    for (let i = 0; i < 101; i++) {
      const request = beacon(`bai-khong-ip-${i}`)
      request.headers.delete('x-forwarded-for')
      expect((await freshPost(request)).status).toBe(204)
    }

    expect(afterMock).toHaveBeenCalledTimes(100)
  })
})

/** The headers of the backend call that after() sent (fetch call number `index`). */
function forwardedHeaders(fetchSpy: { mock: { calls: unknown[][] } }, index = 0): Headers {
  return new Headers((fetchSpy.mock.calls[index]?.[1] as RequestInit | undefined)?.headers)
}

/** The second line of the body is the previous page host, passed to the backend as `x-view-referrer`. */
describe('POST /api/views: previous page host', () => {
  it('a bare slug (a beacon from before the referrer line existed) is still counted, with no x-view-referrer', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 204 }))

    expect((await POST(beacon('bai-tran'))).status).toBe(204)
    await runAfter()

    expect(forwardedHeaders(fetchSpy).has('x-view-referrer')).toBe(false)
  })

  it('slug + host: counts the right post, the host travels in x-view-referrer; the reader IP and UA do not follow', async () => {
    vi.stubEnv('VIEWS_TOKEN', 'bi-mat-chung')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 204 }))

    expect((await POST(beacon('bai-co-nguon\nwww.google.com'))).status).toBe(204)
    await runAfter()

    expect(new URL(String(fetchSpy.mock.calls[0]![0])).pathname).toBe('/api/v1/posts/bai-co-nguon/views')
    const headers = forwardedHeaders(fetchSpy)
    expect([...headers.keys()].sort()).toEqual(['x-view-referrer', 'x-view-token'])
    expect(headers.get('x-view-referrer')).toBe('www.google.com')
  })

  it.each([
    'WWW.GOOGLE.COM',
    'https://www.google.com/search?q=x',
    'google.com/search',
    'goo gle.com',
    'a..b',
    '.google.com',
    'google.com.',
    '[::1]',
    'xn--bcher-kva.de:443',
    `${'a'.repeat(63)}.`.repeat(4).slice(0, 254),
  ])('a malformed host %j is dropped, the view is still counted (as direct)', async (host) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 204 }))

    expect((await POST(beacon(`bai-host-hong\n${host}`))).status).toBe(204)
    expect(afterMock).toHaveBeenCalledTimes(1)
    await runAfter()

    expect(forwardedHeaders(fetchSpy).has('x-view-referrer')).toBe(false)
  })

  it.each(['localhost', '127.0.0.1', 'xn--bcher-kva.de', 'm.facebook.com', `${`${'a'.repeat(63)}.`.repeat(3)}${'a'.repeat(61)}`])(
    'a well-formed host %j is forwarded verbatim (even exactly 253 characters long)',
    async (host) => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 204 }))

      await POST(beacon(`bai-host-dung\n${host}`))
      await runAfter()

      expect(forwardedHeaders(fetchSpy).get('x-view-referrer')).toBe(host)
    },
  )

  it.each(['bai-viet\nwww.google.com\nthua', 'bai-viet\n\nwww.google.com'])(
    'adding a third line %j gives 400 and is not counted',
    async (body) => {
      const res = await POST(beacon(body))

      expect(res.status).toBe(400)
      expect(afterMock).not.toHaveBeenCalled()
    },
  )

  it('the host is not part of the duplicate key: changing the host each time does not make a new view', async () => {
    const headers = { 'x-forwarded-for': '203.0.113.60' }

    await POST(beacon('bai-doi-host\nwww.google.com', headers))
    await POST(beacon('bai-doi-host\nm.facebook.com', headers))
    await POST(beacon('bai-doi-host', headers))

    expect(afterMock).toHaveBeenCalledTimes(1)
  })
})

/** An extra list on top of Next's `isBot`, checked before reading the body. */
describe('POST /api/views: UA is not a reader', () => {
  it.each([
    '',
    'curl/8.7.1',
    'Wget/1.24.5',
    'python-requests/2.32.3',
    'Python-urllib/3.12',
    'Python/3.12 aiohttp/3.10.10',
    'python-httpx/0.27.2',
    'Go-http-client/2.0',
    'Java/21.0.5',
    'okhttp/4.12.0',
    'Apache-HttpClient/5.4 (Java/21.0.5)',
    'node-fetch/1.0 (+https://github.com/bitinn/node-fetch)',
    'axios/1.7.7',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Unknown; Linux x86_64) AppleWebKit/538.1 (KHTML, like Gecko) PhantomJS/2.1.1 Safari/538.1',
    'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36 Chrome-Lighthouse',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.36 Google Page Speed Insights',
    'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
    'Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)',
    'Mozilla/5.0 (compatible; MJ12bot/v1.4.8; http://mj12bot.com/)',
    'Mozilla/5.0 (compatible; DotBot/1.2; +https://opensiteexplorer.org/dotbot)',
    'Mozilla/5.0 (Linux; Android 7.0;) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; PetalBot;+https://webmaster.petalsearch.com/site/petalbot)',
    'Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
    'CCBot/2.0 (https://commoncrawl.org/faq/)',
    'anthropic-ai',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_10_1) AppleWebKit/600.2.5 (KHTML, like Gecko) Version/8.0.2 Safari/600.2.5 (Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot)',
    'Mozilla/5.0 (compatible; SomeCrawler/1.0)',
    'Mozilla/5.0 (compatible; site-spider/2.1)',
  ])('UA %j: 204, the backend is not called', async (ua) => {
    const res = await POST(beacon('bai-viet', { 'user-agent': ua }))

    expect(res.status).toBe(204)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(afterMock).not.toHaveBeenCalled()
  })

  it('a missing User-Agent header: 204, the backend is not called', async () => {
    const request = beacon('bai-viet')
    request.headers.delete('user-agent')

    expect((await POST(request)).status).toBe(204)
    expect(afterMock).not.toHaveBeenCalled()
  })

  it.each([
    CHROME,
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) coc_coc_browser/141.0.200 Chrome/135.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/22G86 [FBAN/FBIOS;FBAV/521.0.0.37.97;FBDV/iPhone15,2;FBMD/iPhone;FBSN/iOS;FBSV/18.6;FBLC/vi_VN]',
    'Mozilla/5.0 (Linux; Android 11; CUBOT_X30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  ])('real browser %j is still counted', async (ua) => {
    expect((await POST(beacon('bai-trinh-duyet', { 'user-agent': ua }))).status).toBe(204)
    expect(afterMock).toHaveBeenCalledTimes(1)
  })
})
