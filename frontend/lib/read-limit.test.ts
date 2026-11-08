// @vitest-environment node
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import { READ_LIMITS, isOptimizerFetch, limitReads, type ReadKind } from './read-limit'

function from(ip: string | null): Request {
  const headers = new Headers()
  if (ip !== null) headers.set('x-forwarded-for', ip)
  return new Request('http://localhost:3000/media/x.jpg', { headers })
}

describe('limitReads: a generous allowance per address for the reads that cost the most', () => {
  it.each(Object.keys(READ_LIMITS) as ReadKind[])(
    '%s: the allowed number of reads pass, the next one is a 429 with Retry-After',
    (kind) => {
      const ip = `203.0.113.${Object.keys(READ_LIMITS).indexOf(kind) + 1}`
      const { limit } = READ_LIMITS[kind]
      let refused: Response | null = null
      for (let i = 0; i < limit; i++) refused = limitReads(from('198.51.100.1, ' + ip), kind)
      expect(refused).toBeNull()

      const over = limitReads(from('198.51.100.1, ' + ip), kind)
      expect(over?.status).toBe(429)
      expect(over?.headers.get('cache-control')).toBe('no-store')
      expect(Number(over?.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
      expect(Number(over?.headers.get('retry-after'))).toBeLessThanOrEqual(60)
      expect(over?.body).toBeNull()
    },
  )

  it('counts each address and each kind separately', () => {
    const { limit } = READ_LIMITS.og
    for (let i = 0; i <= limit; i++) limitReads(from('192.0.2.10'), 'og')

    expect(limitReads(from('192.0.2.10'), 'og')?.status).toBe(429)
    expect(limitReads(from('192.0.2.10'), 'feed')).toBeNull()
    expect(limitReads(from('192.0.2.11'), 'og')).toBeNull()
  })

  it('reads the address the way every other limiter does: the entry the trusted proxy wrote, not the first one', () => {
    const { limit } = READ_LIMITS.og
    // The first entry changes with every request (the caller writes it); the last is the proxy's.
    for (let i = 0; i < limit; i++) limitReads(from(`10.66.${i % 250}.1, 192.0.2.20`), 'og')

    expect(limitReads(from('10.99.0.1, 192.0.2.20'), 'og')?.status).toBe(429)
  })

  it('does not limit a caller whose address cannot be read: one shared bucket would break every picture of the site', () => {
    const { limit } = READ_LIMITS.og
    for (let i = 0; i < limit * 3; i++) expect(limitReads(from(null), 'og')).toBeNull()
    expect(limitReads(from('not an address'), 'og')).toBeNull()
  })

  it('allows again when the window has passed', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(9_000_000)
    const { limit } = READ_LIMITS.og
    for (let i = 0; i <= limit; i++) limitReads(from('192.0.2.30'), 'og')
    expect(limitReads(from('192.0.2.30'), 'og')?.status).toBe(429)

    now.mockReturnValue(9_000_000 + READ_LIMITS.og.windowMs)
    expect(limitReads(from('192.0.2.30'), 'og')).toBeNull()
    now.mockRestore()
  })
})

describe('isOptimizerFetch: the request /_next/image makes to /media for itself', () => {
  it('is a request with no Host header, which no request over HTTP is', () => {
    expect(isOptimizerFetch(new Request('http://localhost:3000/media/x.png'))).toBe(true)
    const forwarded = { 'x-forwarded-for': '127.0.0.1' }
    expect(isOptimizerFetch(new Request('http://localhost:3000/media/x.png', { headers: forwarded }))).toBe(true)
    expect(isOptimizerFetch(new Request('http://localhost:3000/media/x.png', { headers: { host: 'blog.example.test' } }))).toBe(
      false,
    )
  })

  it('matches what the installed Next does: its internal request is built with an empty header object', () => {
    // Read from the source, because the behavior has no other seam: `fetchInternalImage` builds the request and calls the route in
    // process. If an upgrade of Next copies the reader's headers, or sets Host, the route would count the optimizer's fetches (or
    // the two could no longer be told apart): repeat the production probe of docs/DEVELOPMENT.md ("Measuring the image allowance").
    const optimizer = createRequire(import.meta.url).resolve('next/dist/server/image-optimizer.js')
    const source = readFileSync(optimizer, 'utf8')
    const body = source.slice(source.indexOf('async function fetchInternalImage'))
    const built = body.slice(0, body.indexOf('handleRequest(mocked.req')).replace(/\s+/g, ' ')
    expect(built).toContain('new _mockrequest.MockedRequest({ url: href, method, headers: {}, socket: _req.socket })')
  })
})
