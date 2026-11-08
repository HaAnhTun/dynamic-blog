import { afterEach, describe, expect, it, vi } from 'vitest'
import { SECRET_QUERY } from '@/test/fixtures/vi/accented-text'
import { getPosts, searchContent } from './api'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
const emptyPage = () => jsonResponse({ data: [], pagination: { page: 0, size: 10, totalElements: 0, totalPages: 0 } })

afterEach(() => vi.unstubAllGlobals())

describe('getPosts featured', () => {
  it('appends featured=true only when true', async () => {
    const f = vi.fn().mockImplementation(() => Promise.resolve(emptyPage()))
    vi.stubGlobal('fetch', f)
    await getPosts({ page: 0, size: 3, featured: true })
    await getPosts({ page: 0, size: 3, featured: false })
    await getPosts({ page: 0, size: 3 })
    const q = (i: number) => new URL(f.mock.calls[i][0] as string).searchParams
    expect(q(0).get('featured')).toBe('true')
    expect(q(1).has('featured')).toBe(false)
    expect(q(2).has('featured')).toBe(false)
  })
  it('leaves the existing cache options untouched', async () => {
    const f = vi.fn().mockImplementation(() => Promise.resolve(emptyPage()))
    vi.stubGlobal('fetch', f)
    await getPosts({ page: 0, size: 3, featured: true })
    expect(f.mock.calls[0][1]).toEqual({ next: { revalidate: 300, tags: ['posts'] } })
  })
})

describe('getPosts language', () => {
  it('sends lang only when a language is given, and keeps it out of the cache tags', async () => {
    const f = vi.fn().mockImplementation(() => Promise.resolve(emptyPage()))
    vi.stubGlobal('fetch', f)
    await getPosts({ page: 0, size: 3, language: 'en' })
    await getPosts({ page: 0, size: 3 })
    const q = (i: number) => new URL(f.mock.calls[i][0] as string).searchParams
    expect(q(0).get('lang')).toBe('en')
    expect(q(1).has('lang')).toBe(false)
    expect(f.mock.calls[0][1]).toEqual({ next: { revalidate: 300, tags: ['posts'] } })
  })
})

describe('searchContent (shared client of the quick search palette and /search)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })
  const body = { data: { query: 'queue', engine: 'postgres', degraded: false, groups: [] } }

  it('GET /api/v1/search: q trimmed, type defaults to all, filters in order, no data cache, has signal', async () => {
    const f = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(body)))
    vi.stubGlobal('fetch', f)
    expect(await searchContent({ q: '  queue ' })).toEqual(body.data)
    let url = new URL(f.mock.calls[0][0] as string)
    expect(url.pathname).toBe('/api/v1/search')
    expect(url.search).toBe('?q=queue&type=all')
    const init = f.mock.calls[0][1] as RequestInit & { next?: unknown }
    expect(init.cache).toBe('no-store')
    expect(init.next).toBeUndefined()
    expect(init.signal).toBeInstanceOf(AbortSignal)

    await searchContent({ q: '', type: 'post', page: 2, size: 10, category: 'kien-truc', tags: ['aws', '', 'java'], series: 'x' })
    url = new URL(f.mock.calls[1][0] as string)
    expect(url.search).toBe('?type=post&page=2&size=10&category=kien-truc&tag=aws&tag=java&series=x')
  })

  it('sends lang=<language> after the filters', async () => {
    const f = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(body)))
    vi.stubGlobal('fetch', f)
    await searchContent({ q: 'queue', type: 'post', series: 'x', language: 'en' })
    expect(new URL(f.mock.calls[0][0] as string).search).toBe('?q=queue&type=post&series=x&lang=en')
  })

  it('sends the visitor address and the shared token only when an address (or null) is given', async () => {
    vi.stubEnv('CLIENT_IP_TOKEN', '  search-token-for-tests  ')
    const f = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(body)))
    vi.stubGlobal('fetch', f)

    await searchContent({ q: 'queue' })
    await searchContent({ q: 'queue' }, { clientIp: '203.0.113.5' })
    await searchContent({ q: 'queue' }, { clientIp: null })

    const sent = (i: number) => (f.mock.calls[i][1] as RequestInit).headers
    expect(sent(0)).toBeUndefined()
    expect(sent(1)).toEqual({ 'x-client-ip': '203.0.113.5', 'x-client-ip-token': 'search-token-for-tests' })
    expect(sent(2)).toEqual({ 'x-client-ip-token': 'search-token-for-tests' })
    // The query stays in the URL only; the address never lands there.
    expect(String(f.mock.calls[1][0])).not.toContain('203.0.113.5')
  })

  it('a backend error does not carry the query string in its message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 503)))
    const error = await searchContent({ q: SECRET_QUERY }).catch((e: Error) => e)
    expect((error as Error).message).toBe('API responded 503 for /api/v1/search')
  })
})
