// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { READ_LIMITS } from '@/lib/read-limit'
import { GET } from './route'

/*
 * The route handler is a plain async function: called directly with a Request and context, with fetch to the
 * backend mocked. No server is started.
 */

const ID = '0b9a5a4e-7c1d-4f7e-8f52-3c1e2d9a6b10'
const IMMUTABLE = 'public, max-age=31536000, s-maxage=31536000, immutable'

function call(file: string, init: RequestInit = {}) {
  const request = new Request(`http://localhost:3000/media/${encodeURIComponent(file)}`, init)
  return GET(request, { params: Promise.resolve({ file }) })
}

function upstreamImage(bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), headers: Record<string, string> = {}) {
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': 'image/jpeg',
      'content-length': String(bytes.byteLength),
      etag: '"abc123"',
      ...headers,
    },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GET /media/[file]: file name', () => {
  it.each([
    '../etc.jpg',
    '..%2Fetc.jpg',
    `${ID}.webp`,
    `${ID}.svg`,
    `${ID}.JPG`,
    `${ID.toUpperCase()}.jpg`,
    `${ID}.jpg?v=2`,
    `${ID}`,
    'abc.jpg',
  ])('rejects %s with a 404 no-store without calling the backend', async (file) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await call(file)

    expect(res.status).toBe(404)
    // A 404 cached for a year would outlive the error that caused it.
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('accepts a lowercase UUID with a jpg or png extension, building the backend URL from that name only', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => upstreamImage())

    expect((await call(`${ID}.jpg`)).status).toBe(200)
    expect((await call(`${ID}.png`)).status).toBe(200)

    const urls = fetchSpy.mock.calls.map((c) => new URL(String(c[0])))
    expect(urls.map((u) => u.pathname)).toEqual([`/api/v1/media/${ID}.jpg`, `/api/v1/media/${ID}.png`])
    expect(urls.every((u) => u.search === '')).toBe(true)
  })
})

describe('GET /media/[file]: 200 response', () => {
  it('returns the exact bytes with an immutable cache header, nosniff and a CSP sandbox', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => upstreamImage(new Uint8Array([1, 2, 3, 4, 5])))

    const res = await call(`${ID}.jpg`)

    expect(res.status).toBe(200)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(res.headers.get('cache-control')).toBe(IMMUTABLE)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toBe("script-src 'none'; frame-src 'none'; sandbox;")
    expect(res.headers.get('etag')).toBe('"abc123"')
  })

  it('Content-Type comes from the file extension via an allowlist, never copied from the backend', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => upstreamImage(undefined, { 'content-type': 'text/html' }))

    const jpg = await call(`${ID}.jpg`)
    const png = await call(`${ID}.png`)

    // An HTML content-type served from the site origin is stored XSS.
    expect(jpg.headers.get('content-type')).toBe('image/jpeg')
    expect(png.headers.get('content-type')).toBe('image/png')
  })

  it('does not forward the backend content-length or content-encoding', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      upstreamImage(new Uint8Array([9, 9]), { 'content-length': '999', 'content-encoding': 'gzip' }),
    )

    const res = await call(`${ID}.jpg`)

    // Node fetch has already decompressed the body but kept the original headers: copying them makes the browser truncate
    // or decompress a second time.
    expect(res.headers.get('content-length')).toBeNull()
    expect(res.headers.get('content-encoding')).toBeNull()
  })

  it('asks the backend without the Data Cache and forwards the request signal', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => upstreamImage())

    await call(`${ID}.jpg`)

    const init = fetchSpy.mock.calls[0]![1]!
    // The Data Cache limits an entry to 2 MB; images go up to 4 MB. Caching in the right place is the immutable header.
    expect(init.cache).toBe('no-store')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })
})

describe('GET /media/[file]: ETag and 304', () => {
  it('forwards the browser If-None-Match to the backend', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => upstreamImage())

    await call(`${ID}.jpg`, { headers: { 'if-none-match': '"abc123"' } })

    expect(new Headers(fetchSpy.mock.calls[0]![1]!.headers).get('if-none-match')).toBe('"abc123"')
  })

  it('does not add If-None-Match by itself when the browser sends none', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => upstreamImage())

    await call(`${ID}.jpg`)

    expect(new Headers(fetchSpy.mock.calls[0]![1]!.headers).has('if-none-match')).toBe(false)
  })

  it('a backend 304 gives a 304 with no body, with the ETag and immutable cache', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(null, { status: 304, headers: { etag: '"abc123"' } }),
    )

    const res = await call(`${ID}.jpg`, { headers: { 'if-none-match': '"abc123"' } })

    expect(res.status).toBe(304)
    expect(res.body).toBeNull()
    expect(res.headers.get('etag')).toBe('"abc123"')
    expect(res.headers.get('cache-control')).toBe(IMMUTABLE)
  })
})

describe('GET /media/[file]: errors', () => {
  it('backend 404 gives 404 no-store', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(JSON.stringify({ error: { code: 'MEDIA_NOT_FOUND' } }), { status: 404 }),
    )

    const res = await call(`${ID}.png`)

    expect(res.status).toBe(404)
    expect(res.headers.get('cache-control')).toBe('no-store')
    // Do not pass the backend JSON error body out under an image URL.
    expect(await res.text()).toBe('')
  })

  it.each([500, 400, 503])('backend %i gives 502 no-store', async (status) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status }))

    const res = await call(`${ID}.jpg`)

    expect(res.status).toBe(502)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('a network error to the backend gives 502 no-store', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))

    const res = await call(`${ID}.jpg`)

    expect(res.status).toBe(502)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
})

describe('HEAD /media/[file]', () => {
  it('Next runs GET for HEAD: returns the image headers, no body, and cancels the body being downloaded from the backend', async () => {
    const upstream = upstreamImage()
    const cancel = vi.spyOn(upstream.body!, 'cancel')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(upstream)

    const res = await call(`${ID}.jpg`, { method: 'HEAD' })

    expect(res.status).toBe(200)
    expect(res.body).toBeNull()
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(res.headers.get('etag')).toBe('"abc123"')
    expect(cancel).toHaveBeenCalled()
  })
})

/**
 * An image is read whole from the database and `/_next/image` asks for every size of every picture it has not optimized yet, so one
 * address may not ask without end (audit issue 18). The allowance is generous: a gallery page of a hundred pictures is far below it.
 */
describe('GET /media/[file]: allowance per address', () => {
  // A request that came over HTTP always has a Host header; the fetch of the image optimizer has none (lib/read-limit.ts).
  const from = (ip: string) => ({ headers: { host: 'localhost:3000', 'x-forwarded-for': ip } })

  it('answers 429 with Retry-After to the request past the allowance, and the backend is not asked for it', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => upstreamImage())
    for (let i = 0; i < READ_LIMITS.media.limit; i++) expect((await call(`${ID}.jpg`, from('203.0.113.50'))).status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(READ_LIMITS.media.limit)

    const refused = await call(`${ID}.jpg`, from('203.0.113.50'))

    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    expect(refused.headers.get('cache-control')).toBe('no-store')
    expect(fetchSpy).toHaveBeenCalledTimes(READ_LIMITS.media.limit)
    // Another reader is not affected.
    expect((await call(`${ID}.jpg`, from('203.0.113.51'))).status).toBe(200)
  })

  it('does not count a file name that cannot be an image: that answer costs nothing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => upstreamImage())
    for (let i = 0; i < READ_LIMITS.media.limit + 5; i++)
      expect((await call('not-an-image.jpg', from('203.0.113.52'))).status).toBe(404)

    expect((await call(`${ID}.jpg`, from('203.0.113.52'))).status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

/**
 * `/_next/image` fetches `/media/<id>` for itself with a request that has NO headers, on the socket of the reader's request, and Next
 * then writes the address of that socket (the proxy's) into `x-forwarded-for`. Counted, those fetches share one bucket and the allowance
 * becomes the whole site's: about 20 requests a second from one source answered 429 for every picture of every reader (audit issue 18,
 * measured on a production build). The reader is counted once, in proxy.ts.
 */
describe('GET /media/[file]: the fetch of the image optimizer', () => {
  const optimizer = (ip: string) => ({ headers: { 'x-forwarded-for': ip } })
  const reader = (ip: string) => ({ headers: { host: 'localhost:3000', 'x-forwarded-for': ip } })

  it('is not counted: the proxy address on its fetches never runs out, and a reader is still served', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => upstreamImage())
    for (let i = 0; i < READ_LIMITS.media.limit + 50; i++)
      expect((await call(`${ID}.png`, optimizer('127.0.0.1'))).status).toBe(200)

    expect((await call(`${ID}.png`, reader('203.0.113.60'))).status).toBe(200)
    expect((await call(`${ID}.png`, optimizer('127.0.0.1'))).status).toBe(200)
  })

  it('still counts a request that came over HTTP, and does not refuse the optimizer because a reader used the allowance', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => upstreamImage())
    for (let i = 0; i < READ_LIMITS.media.limit; i++) expect((await call(`${ID}.png`, reader('203.0.113.61'))).status).toBe(200)

    expect((await call(`${ID}.png`, reader('203.0.113.61'))).status).toBe(429)
    expect((await call(`${ID}.png`, optimizer('203.0.113.61'))).status).toBe(200)
  })
})
