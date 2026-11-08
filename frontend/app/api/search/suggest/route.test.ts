// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, searchContent } from '@/lib/api'
import { getPopularPosts } from '@/lib/popular'
import type { BackendSearchResponse } from '@/lib/search-contract'
import { SEARCH_RATE } from '@/lib/search-suggest'
import type { PostSummary } from '@/lib/types'
import { GET as popularGET } from '../popular/route'
import { GET } from './route'
import { msg } from '@/test/render-intl'

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  searchContent: vi.fn(),
}))
vi.mock('@/lib/popular', () => ({ getPopularPosts: vi.fn() }))

let ipCounter = 0
function freshIp(): string {
  ipCounter += 1
  return `10.8.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`
}

function suggest(query: Record<string, string>, headers: Record<string, string> = {}, ip = freshIp()) {
  const url = new URL('http://localhost:3000/api/search/suggest')
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  return GET(new Request(url, { headers: { 'sec-fetch-site': 'same-origin', 'x-forwarded-for': ip, ...headers } }))
}

const KIEN_TRUC = { id: 'c1', name: 'Architecture', slug: 'kien-truc', description: 'Systems and trade-offs.' }
const SPRING = { id: 't1', name: 'Spring Boot', slug: 'spring-boot' }

function post(n: number, extra: Partial<PostSummary> = {}): PostSummary {
  return {
    id: `00000000-0000-4000-8000-00000000000${n}`,
    title: `Post ${n}`,
    slug: `bai-${n}`,
    excerpt: `Summary ${n}`,
    status: 'PUBLISHED',
    category: KIEN_TRUC,
    tags: [SPRING],
    featured: false,
    readingMinutes: 4,
    publishedAt: '2026-10-05T08:00:00Z',
    ...extra,
  }
}

const seg = (text: string, match = false) => ({ text, match })

/** The real backend shape (`SearchResponse`): a post group carries `post` (a summary with a UUID) and pagination when `type=post`. */
function backend(extra: Partial<BackendSearchResponse<PostSummary>> = {}): BackendSearchResponse<PostSummary> {
  return {
    query: 'spring',
    engine: 'postgres',
    degraded: false,
    groups: [
      {
        type: 'post',
        total: 7,
        page: 0,
        totalPages: 2,
        items: [
          {
            id: 'post:bai-1',
            title: [seg('Spring', true), seg(' Boot and queue')],
            description: [seg('Summary 1')],
            href: '/posts/bai-1',
            meta: {
              kind: 'post',
              category: 'Architecture',
              author: 'Gary Guest',
              publishedAt: '2026-10-05T08:00:00Z',
              readingMinutes: 4,
              tags: ['Spring Boot'],
            },
            post: post(1, {
              title: 'Spring Boot and queue',
              author: {
                displayName: 'Gary Guest',
                githubLogin: 'guest',
                avatarUrl: null,
                siteOwner: false,
                profileSlug: 'tran-khach',
              },
            }),
          },
        ],
      },
      {
        type: 'topic',
        total: 1,
        items: [
          {
            id: 'tag:spring-boot',
            title: [seg('Spring', true), seg(' Boot')],
            href: '/tags/spring-boot',
            meta: { kind: 'tag', count: 1 },
          },
        ],
      },
      {
        type: 'case-study',
        total: 1,
        items: [
          {
            id: 'case-study:blog-nay',
            title: [seg('This blog')],
            description: [seg('Next.js and '), seg('Spring', true), seg(' Boot')],
            href: '/case-studies/blog-nay',
          },
        ],
      },
    ],
    ...extra,
  }
}

beforeEach(() => vi.mocked(searchContent).mockResolvedValue(backend()))
afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(searchContent).mockReset()
})

describe('GET /api/search/suggest: the visitor address for the backend', () => {
  it('passes the address counted from the right of X-Forwarded-For, never the first entry the visitor wrote', async () => {
    await suggest({ q: 'spring' }, { 'x-forwarded-for': '6.6.6.6, 10.9.0.77' })

    expect(searchContent).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ clientIp: '10.9.0.77' }))
  })

  it('an address nobody vouches for (a junk entry) is passed as null: the backend counts it as unknown', async () => {
    await suggest({ q: 'spring' }, { 'x-forwarded-for': 'not-an-ip' })

    expect(searchContent).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ clientIp: null }))
  })
})

describe('GET /api/search/suggest: contract', () => {
  it('returns no-store (the fetch carrying q is already no-store in searchContent: lib/api-additions.test.ts)', async () => {
    const res = await suggest({ q: 'post' })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('no-store')
  })

  it('input validation: a type outside the list and a q longer than 200 are 400; under 2 characters is empty, with no backend call', async () => {
    expect((await suggest({ q: 'post', type: 'code' })).status).toBe(400)
    expect((await suggest({ q: 'a'.repeat(201) })).status).toBe(400)
    expect((await suggest({ q: `  ${'a'.repeat(200)}  ` })).status).toBe(200)

    const short = await suggest({ q: ' s ' })
    expect(await short.json()).toEqual({ query: 's', groups: [], degraded: false })
    expect(searchContent).toHaveBeenCalledTimes(1)
  })

  it('cross-site is 403, before any backend call', async () => {
    const res = await suggest({ q: 'post' }, { 'sec-fetch-site': 'cross-site' })
    expect(res.status).toBe(403)
    expect(searchContent).not.toHaveBeenCalled()
  })

  it('forwards a known page language to the backend and ignores an unknown one', async () => {
    await suggest({ q: 'spring', lang: 'en' })
    expect(vi.mocked(searchContent).mock.calls[0]![0]).toEqual({ q: 'spring', type: 'all', limit: 5, language: 'en' })

    vi.mocked(searchContent).mockClear()
    expect((await suggest({ q: 'spring', lang: 'fr' })).status).toBe(200)
    expect(vi.mocked(searchContent).mock.calls[0]![0]).toEqual({ q: 'spring', type: 'all', limit: 5 })
  })

  it('a post result carries its own language so the link uses that prefix', async () => {
    vi.mocked(searchContent).mockResolvedValue(
      backend({
        groups: [
          {
            type: 'post',
            total: 1,
            items: [
              { id: 'post:bai-1', title: [seg('x')], href: '/posts/bai-1', post: post(1, { language: 'en' }) },
              { id: 'post:bai-2', title: [seg('y')], href: '/posts/bai-2', post: post(2, { language: 'xx' }) },
            ],
          },
        ],
      }),
    )
    const body = await (await suggest({ q: 'spring' })).json()

    expect(body.groups[0].items.map((item: { locale?: string }) => item.locale)).toEqual(['en', undefined])
  })

  it('copies the backend answer: keeps order, id, Segment[], href, meta; drops post, page, totalPages', async () => {
    const body = await (await suggest({ q: 'spring' })).json()

    expect(vi.mocked(searchContent).mock.calls[0]![0]).toEqual({ q: 'spring', type: 'all', limit: 5 })
    expect(vi.mocked(searchContent).mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal)
    expect(body.groups.map((g: { type: string }) => g.type)).toEqual(['post', 'topic', 'case-study'])
    expect(body.groups[0]).toEqual({
      type: 'post',
      total: 7,
      items: [
        {
          id: 'post:bai-1',
          title: [seg('Spring', true), seg(' Boot and queue')],
          description: [seg('Summary 1')],
          href: '/posts/bai-1',
          meta: {
            kind: 'post',
            category: 'Architecture',
            author: 'Gary Guest',
            publishedAt: '2026-10-05T08:00:00Z',
            readingMinutes: 4,
            tags: ['Spring Boot'],
          },
        },
      ],
    })
    expect(body.degraded).toBe(false)
    const raw = JSON.stringify(body)
    expect(raw).not.toMatch(/00000000-0000|PUBLISHED|githubLogin|"status"|"post":|totalPages|@/)
  })

  it('does not trust the backend href: only on-site paths; a group left without rows is dropped', async () => {
    vi.mocked(searchContent).mockResolvedValue(
      backend({
        groups: [
          {
            type: 'page',
            total: 3,
            items: [
              { id: 'page:x', title: [seg('X')], href: 'javascript:alert(1)' },
              { id: 'page:y', title: [seg('Y')], href: '//evil.example' },
              { id: 'page:/archive', title: [seg(msg('Site.footer.links.archive'))], href: '/archive' },
            ],
          },
          { type: 'series', total: 1, items: [{ id: 'series:x', title: [seg('X')], href: 'https://evil.example' }] },
        ],
      }),
    )
    const body = await (await suggest({ q: 'luu tru' })).json()
    expect(body.groups).toEqual([
      {
        type: 'page',
        total: 3,
        items: [{ id: 'page:/archive', title: [seg(msg('Site.footer.links.archive'))], href: '/archive' }],
      },
    ])
  })

  it('"All" shows at most 5 per group; the posts tab asks for a first page of 10; the other tabs ask for limit 10', async () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `post:bai-${i}`, title: [seg(`Post ${i}`)], href: `/posts/bai-${i}` }))
    vi.mocked(searchContent).mockResolvedValue(backend({ groups: [{ type: 'post', total: 40, items: many(12) }] }))

    const all = await (await suggest({ q: 'bai' })).json()
    expect(all.groups[0].items).toHaveLength(5)
    expect(all.groups[0].total).toBe(40)

    const tab = await (await suggest({ q: 'bai', type: 'post' })).json()
    expect(tab.groups[0].items).toHaveLength(10)
    expect(vi.mocked(searchContent).mock.calls.at(-1)![0]).toEqual({ q: 'bai', type: 'post', limit: 10, page: 0, size: 10 })

    await suggest({ q: 'bai', type: 'author' })
    expect(vi.mocked(searchContent).mock.calls.at(-1)![0]).toEqual({ q: 'bai', type: 'author', limit: 10 })
  })

  it('backend degraded passes straight through: the panel shows "Using basic search"', async () => {
    vi.mocked(searchContent).mockResolvedValue(backend({ engine: 'postgres', degraded: true }))
    const body = await (await suggest({ q: 'spring' })).json()
    expect(body.degraded).toBe(true)
    expect(body.groups).toHaveLength(3)
  })

  it('backend errors become codes: 5xx and a lost network are 502, a timeout is 504, 429 is 429, 400 is 400', async () => {
    const cases: Array<[unknown, number, string]> = [
      [new ApiError(500, 'INTERNAL_ERROR', 'boom'), 502, 'UPSTREAM_UNAVAILABLE'],
      [new ApiError(503, undefined, 'down'), 502, 'UPSTREAM_UNAVAILABLE'],
      [new TypeError('fetch failed'), 502, 'UPSTREAM_UNAVAILABLE'],
      [new ApiError(429, 'RATE_LIMITED', 'Too many'), 429, 'RATE_LIMITED'],
      [new ApiError(400, 'VALIDATION_ERROR', 'q must be at most 200 characters'), 400, 'VALIDATION_ERROR'],
    ]
    for (const [error, status, code] of cases) {
      vi.mocked(searchContent).mockRejectedValueOnce(error)
      const res = await suggest({ q: 'spring' })
      expect(res.status, String(error)).toBe(status)
      expect((await res.json()).error.code, String(error)).toBe(code)
      expect(res.headers.get('cache-control')).toContain('no-store')
    }

    vi.mocked(searchContent).mockImplementationOnce(
      (_params, options) =>
        new Promise((_, reject) => options?.signal?.addEventListener('abort', () => reject(options.signal!.reason))),
    )
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const pending = suggest({ q: 'spring' })
    await vi.advanceTimersByTimeAsync(3_100)
    vi.useRealTimers()
    const timedOut = await pending
    expect(timedOut.status).toBe(504)
    expect(await timedOut.json()).toEqual({ error: { code: 'UPSTREAM_TIMEOUT', message: 'Search timed out' } })

    // No results is a 200 with empty groups, never an error.
    vi.mocked(searchContent).mockResolvedValueOnce(backend({ groups: [] }))
    expect(await (await suggest({ q: 'khongcogi' })).json()).toEqual({ query: 'khongcogi', groups: [], degraded: false })
  })

  it('never logs the query or returns it in an error body', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    )
    const secret = 'private query text'
    for (const status of [500, 429, 400]) {
      vi.mocked(searchContent).mockRejectedValueOnce(new ApiError(status, undefined, `API responded ${status} for ?q=${secret}`))
      const res = await suggest({ q: secret })
      expect(JSON.stringify(await res.json())).not.toContain(secret)
    }
    await suggest({ q: secret })
    for (const spy of spies) for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(secret)
  })
})

describe('GET /api/search/suggest: per-IP quota', () => {
  it('fast typing with debounce does not hit the quota; over the quota is 429 with Retry-After; after the window it works again', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const ip = freshIp()

    // A minute of continuous typing: debounce ~180 ms, one request per word. 120 requests still go through.
    for (let i = 0; i < SEARCH_RATE.limit; i += 1) {
      now += 450
      expect((await suggest({ q: `keyword ${i}` }, {}, ip)).status).toBe(200)
    }
    const blocked = await suggest({ q: 'one more' }, {}, ip)
    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } })
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0)
    // Blocked at Next: the backend is not asked.
    expect(searchContent).toHaveBeenCalledTimes(SEARCH_RATE.limit)

    expect((await suggest({ q: 'another person' })).status).toBe(200)
    now += SEARCH_RATE.windowMs
    expect((await suggest({ q: 'allowed again' }, {}, ip)).status).toBe(200)
  })

  it('a query under 2 characters costs no attempt', async () => {
    let now = 2_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const ip = freshIp()
    for (let i = 0; i < SEARCH_RATE.limit + 10; i += 1) {
      now += 10
      await suggest({ q: 'x' }, {}, ip)
    }
    expect((await suggest({ q: 'spring' }, {}, ip)).status).toBe(200)
  })
})

describe('GET /api/search/popular', () => {
  const popular = (n: number, views: number) => post(n, { viewCount: views })
  const request = () =>
    popularGET(
      new Request('http://localhost:3000/api/search/popular', {
        headers: { 'sec-fetch-site': 'same-origin', 'x-forwarded-for': freshIp() },
      }),
    )

  it('only when real views pass the threshold: below it the list is empty, not replaced by curated posts', async () => {
    vi.mocked(getPopularPosts).mockResolvedValue([popular(1, 50), popular(2, 30), popular(3, 12), popular(4, 2)])
    expect(await (await request()).json()).toEqual({
      items: [
        { id: 'post:bai-1', title: 'Post 1', href: '/posts/bai-1' },
        { id: 'post:bai-2', title: 'Post 2', href: '/posts/bai-2' },
        { id: 'post:bai-3', title: 'Post 3', href: '/posts/bai-3' },
      ],
    })

    vi.mocked(getPopularPosts).mockResolvedValue([popular(1, 50), popular(2, 3)])
    expect(await (await request()).json()).toEqual({ items: [] })
  })

  it('asks for the popular posts of the page language and links each under the post language', async () => {
    vi.mocked(getPopularPosts).mockResolvedValue([
      post(1, { viewCount: 50, language: 'en' }),
      post(2, { viewCount: 30, language: 'en' }),
      post(3, { viewCount: 12, language: 'en' }),
    ])
    const response = await popularGET(
      new Request('http://localhost:3000/api/search/popular?lang=en', {
        headers: { 'sec-fetch-site': 'same-origin', 'x-forwarded-for': freshIp() },
      }),
    )

    expect(vi.mocked(getPopularPosts)).toHaveBeenLastCalledWith(6, 'en')
    expect((await response.json()).items[0]).toEqual({ id: 'post:bai-1', title: 'Post 1', href: '/posts/bai-1', locale: 'en' })

    await popularGET(
      new Request('http://localhost:3000/api/search/popular?lang=zz', {
        headers: { 'sec-fetch-site': 'same-origin', 'x-forwarded-for': freshIp() },
      }),
    )
    expect(vi.mocked(getPopularPosts)).toHaveBeenLastCalledWith(6, undefined)
  })

  it('a broken source is 502', async () => {
    vi.mocked(getPopularPosts).mockRejectedValue(new Error('down'))
    expect((await request()).status).toBe(502)
  })
})
