import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSiteContent } from '@/content/defaults'
import { DEFAULT_LOCALE } from '@/i18n/config'
import { getPosts } from '@/lib/api'
import { getPopularPosts } from '@/lib/popular'
import { fetchAllPublishedPosts } from '@/lib/published-posts'
import { getSeriesList } from '@/lib/series'
import type { Category, PostSummary, SeriesSummary, Tag } from '@/lib/types'
import {
  VIEW_THRESHOLDS,
  bucketByMonth,
  countCategories,
  countTags,
  getDiscovery,
  newestFirst,
  popularOrRecommended,
  shouldShowViews,
} from './discovery'
import { msg } from '@/test/render-intl'
import { TAG_NAMES_SORTED, TAG_NAMES_UNSORTED } from '@/test/fixtures/vi/collation'

/*
 * getDiscovery gathers four sources; each source is mocked at the module boundary so each one can
 * fail on its own. Pure functions are tested directly, with no mocks.
 *
 * `@/lib/api` keeps the real part (ApiError, NotFoundError) and only replaces getPosts: other modules
 * in the import graph still need those two error classes to be real values.
 */
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  getPosts: vi.fn(),
}))
vi.mock('@/lib/popular', () => ({ getPopularPosts: vi.fn() }))
vi.mock('@/lib/published-posts', () => ({ fetchAllPublishedPosts: vi.fn() }))
vi.mock('@/lib/series', () => ({ getSeriesList: vi.fn(), getSeries: vi.fn() }))

function post(slug: string, over: Partial<PostSummary> = {}): PostSummary {
  return {
    id: `id-${slug}`,
    title: `Title ${slug}`,
    slug,
    excerpt: null,
    status: 'PUBLISHED',
    category: null,
    tags: [],
    featured: false,
    readingMinutes: 4,
    publishedAt: '2026-10-03T00:00:00Z',
    ...over,
  }
}

function tag(name: string, slug: string): Tag {
  return { id: `t-${slug}`, name, slug }
}

function category(slug: string, name: string, description: string | null = null): Category {
  return { id: `c-${slug}`, name, slug, description }
}

function series(n: number): SeriesSummary {
  return {
    id: `s${n}`,
    title: `Series ${n}`,
    slug: `series-${n}`,
    description: null,
    postCount: 2,
    readingMinutes: 11,
    latestPublishedAt: '2026-10-03T00:00:00Z',
    parts: [],
  }
}

describe('VIEW_THRESHOLDS', () => {
  it('pins the three thresholds of the spec: 10 per post, 100 site-wide, "Most read" needs 3 posts', () => {
    expect(VIEW_THRESHOLDS).toEqual({ perPost: 10, siteTotal: 100, popularPosts: 3 })
  })
})

describe('shouldShowViews', () => {
  it('only shows the view count from 10 upward', () => {
    expect(shouldShowViews(undefined)).toBe(false)
    expect(shouldShowViews(0)).toBe(false)
    expect(shouldShowViews(9)).toBe(false)
    expect(shouldShowViews(10)).toBe(true)
    expect(shouldShowViews(1500)).toBe(true)
  })
})

describe('countTags', () => {
  it('counts posts per tag, most posts first, no tag with 0 posts', () => {
    const java = tag('Java', 'java')
    const spring = tag('Spring Boot', 'spring-boot')

    const counts = countTags([post('a', { tags: [java, spring] }), post('b', { tags: [java] }), post('c')])

    expect(counts).toEqual([
      { tag: java, count: 2 },
      { tag: spring, count: 1 },
    ])
    expect(counts.every((entry) => entry.count > 0)).toBe(true)
  })

  it('with the same post count, sorts in Vietnamese alphabetical order, not by character code', () => {
    const names = TAG_NAMES_UNSORTED
    const posts = names.map((name, i) => post(`p${i}`, { tags: [tag(name, `t${i}`)] }))

    // By character code, uppercase letters come before lowercase ones and accented letters after 'z'.
    // A Vietnamese reader expects the order below.
    expect(countTags(posts).map((entry) => entry.tag.name)).toEqual(TAG_NAMES_SORTED)
  })

  it('a tag repeated on the same post counts only once', () => {
    const java = tag('Java', 'java')

    expect(countTags([post('a', { tags: [java, java] })])).toEqual([{ tag: java, count: 1 }])
  })
})

describe('countCategories', () => {
  it('keeps the order of the category list and drops categories without posts', () => {
    const testing = category('kiem-thu', 'Testing')
    const empty = category('trong', msg('Admin.series.countNone'))
    const arch = category('kien-truc', 'Architecture')

    const counts = countCategories(
      [post('a', { category: arch }), post('b', { category: testing }), post('c', { category: arch }), post('d')],
      [testing, empty, arch],
    )

    expect(counts).toEqual([
      { category: testing, count: 1 },
      { category: arch, count: 2 },
    ])
  })

  it('returns the Category of the list (with description), not the copy on the post', () => {
    const full = category('kiem-thu', 'Testing', 'Full description')
    const onPost = { ...full, description: null }

    const [entry] = countCategories([post('a', { category: onPost })], [full])

    expect(entry?.category.description).toBe('Full description')
    expect(entry?.count).toBe(1)
  })
})

describe('bucketByMonth', () => {
  it('groups by UTC month: 2026-10-31T20:00:00Z is October, not November in Vietnam time', () => {
    // vitest.config.mts pins TZ=Asia/Ho_Chi_Minh, so in local time this instant is already 01/11.
    const buckets = bucketByMonth([post('cuoi-thang', { publishedAt: '2026-10-31T20:00:00Z' })])

    expect(buckets).toHaveLength(1)
    expect(buckets[0]).toMatchObject({ year: 2026, month: 10, count: 1 })
  })

  it('newest month first, newest post first within a month, count equals the number of posts', () => {
    const buckets = bucketByMonth([
      post('t9', { publishedAt: '2026-09-15T00:00:00Z' }),
      post('t10-dau', { publishedAt: '2026-10-01T00:00:00Z' }),
      post('nam-truoc', { publishedAt: '2025-12-31T23:59:59Z' }),
      post('t10-cuoi', { publishedAt: '2026-10-20T00:00:00Z' }),
    ])

    expect(buckets.map((b) => [b.year, b.month, b.count])).toEqual([
      [2026, 10, 2],
      [2026, 9, 1],
      [2025, 12, 1],
    ])
    expect(buckets[0]!.posts.map((p) => p.slug)).toEqual(['t10-cuoi', 't10-dau'])
  })

  it('skips posts without a publish date or with a broken date', () => {
    const buckets = bucketByMonth([
      post('co-ngay', { publishedAt: '2026-10-03T00:00:00Z' }),
      post('khong-ngay', { publishedAt: null }),
      post('ngay-hong', { publishedAt: 'not a date' }),
    ])

    expect(buckets).toHaveLength(1)
    expect(buckets[0]!.posts.map((p) => p.slug)).toEqual(['co-ngay'])
  })
})

describe('newestFirst', () => {
  it('is exported: sorts by publish date instead of input order, drops undated and unparsable posts, keeps the time', () => {
    const entries = newestFirst([
      post('old', { publishedAt: '2026-01-01T00:00:00Z' }),
      post('no-date', { publishedAt: null }),
      post('new', { publishedAt: '2026-10-01T00:00:00Z' }),
      post('broken', { publishedAt: 'not a date' }),
      post('mid', { publishedAt: '2026-05-01T00:00:00Z' }),
    ])

    expect(entries.map((entry) => entry.post.slug)).toEqual(['new', 'mid', 'old'])
    expect(entries[0]!.time).toBe(Date.parse('2026-10-01T00:00:00Z'))
  })
})

describe('popularOrRecommended', () => {
  const featured = [1, 2, 3, 4, 5, 6].map((n) => post(`hay-${n}`, { featured: true, featuredRank: n }))

  it('with 3 posts at 10 views or more it is "Most read", containing only the posts passing the threshold', () => {
    const popular = [
      post('a', { viewCount: 40 }),
      post('b', { viewCount: 12 }),
      post('c', { viewCount: 10 }),
      post('d', { viewCount: 9 }),
    ]

    const result = popularOrRecommended(popular, featured)

    expect(result.kind).toBe('popular')
    // 'd' has 9 views: below the per-post threshold the count is not shown, so it also does not appear in the
    // "most read" list — otherwise it would be the only row without a view count.
    expect(result.posts.map((p) => p.slug)).toEqual(['a', 'b', 'c'])
  })

  it('with only 2 posts passing the threshold, falls back to "Read these first" by curated rank', () => {
    const popular = [post('a', { viewCount: 400 }), post('b', { viewCount: 10 }), post('c', { viewCount: 9 })]

    const result = popularOrRecommended(popular, featured)

    expect(result.kind).toBe('recommended')
    expect(result.posts.map((p) => p.slug)).toEqual(['hay-1', 'hay-2', 'hay-3', 'hay-4', 'hay-5'])
  })

  it('never more than 5 posts', () => {
    const popular = [1, 2, 3, 4, 5, 6, 7].map((n) => post(`p${n}`, { viewCount: 100 - n }))

    expect(popularOrRecommended(popular, featured).posts).toHaveLength(5)
  })
})

describe('getDiscovery', () => {
  const featured = [post('hay-1', { featured: true, featuredRank: 1 }), post('hay-2', { featured: true, featuredRank: 2 })]

  /** 14 posts, one per month from 2025-09 to 2026-10, newest first as the API returns them. */
  const allPosts = Array.from({ length: 14 }, (_, i) => {
    const date = new Date(Date.UTC(2026, 9 - i, 10))
    return post(`bai-${i}`, {
      publishedAt: date.toISOString(),
      tags: i === 0 ? Array.from({ length: 23 }, (_, t) => tag(`Tag ${String(t).padStart(2, '0')}`, `the-${t}`)) : [],
    })
  })

  function stub(sources: {
    popular?: PostSummary[] | Error
    featured?: PostSummary[] | Error
    all?: PostSummary[] | Error
    series?: SeriesSummary[] | Error
  }) {
    const settle = <T>(value: T | Error) => (value instanceof Error ? Promise.reject(value) : Promise.resolve(value))
    vi.mocked(getPopularPosts).mockImplementation(() => settle(sources.popular ?? []))
    vi.mocked(getPosts).mockImplementation(() =>
      settle(sources.featured ?? []).then((items) => ({
        items,
        meta: { page: 0, size: items.length, totalElements: items.length, totalPages: 1 },
      })),
    )
    vi.mocked(fetchAllPublishedPosts).mockImplementation(() => settle(sources.all ?? []))
    vi.mocked(getSeriesList).mockImplementation(() => settle(sources.series ?? []))
  }

  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('passes the language to every source', async () => {
    stub({ featured, all: allPosts })
    await getDiscovery({ context: 'writing', language: 'en' })

    expect(getPopularPosts).toHaveBeenCalledWith(6, 'en')
    expect(getPosts).toHaveBeenCalledWith(expect.objectContaining({ featured: true, language: 'en' }))
    expect(fetchAllPublishedPosts).toHaveBeenCalledWith('en')
    expect(getSeriesList).toHaveBeenCalledWith('en')
  })

  it('a failing source logs one warning naming the source; with all sources there is no log', async () => {
    stub({ featured, all: allPosts, series: new Error('series down') })
    await getDiscovery({ context: 'writing' })

    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain('series (series down)')

    warn.mockClear()
    stub({ featured, all: allPosts, series: [series(1)] })
    await getDiscovery({ context: 'writing' })

    expect(warn).not.toHaveBeenCalled()
  })

  it('/writing: with all sources there is "Most read", series ≤5, tags ≤20, months ≤12 and the blogroll', async () => {
    stub({
      popular: [post('a', { viewCount: 30 }), post('b', { viewCount: 20 }), post('c', { viewCount: 10 })],
      featured,
      all: allPosts,
      series: [1, 2, 3, 4, 5, 6, 7].map(series),
    })

    const d = await getDiscovery({ context: 'writing' })

    expect(d.popular).toEqual({
      kind: 'popular',
      posts: [
        expect.objectContaining({ slug: 'a' }),
        expect.objectContaining({ slug: 'b' }),
        expect.objectContaining({ slug: 'c' }),
      ],
    })
    expect(d.series?.map((s) => s.slug)).toEqual(['series-1', 'series-2', 'series-3', 'series-4', 'series-5'])
    expect(d.seriesTotal).toBe(7)
    expect(d.tags).toHaveLength(20)
    expect(d.tagTotal).toBe(23)
    expect(d.months).toHaveLength(12)
    expect(d.months?.[0]).toMatchObject({ year: 2026, month: 10, count: 1 })
    // "Recently written" only exists on the post page; on /writing the list itself is already the newest posts.
    expect(d.recent).toBeNull()
    expect(d.blogroll).toEqual(defaultSiteContent(DEFAULT_LOCALE).blogroll)
  })

  it('asks for featured posts through getPosts featured=true and requests one extra popular post to subtract the post being read', async () => {
    stub({ featured, all: allPosts })

    await getDiscovery({ context: 'writing' })

    expect(getPosts).toHaveBeenCalledWith({ page: 0, size: 6, featured: true })
    expect(getPopularPosts).toHaveBeenCalledWith(6, undefined)
  })

  it('with too few views, it is "Read these first" from the curated posts', async () => {
    stub({ popular: [post('a', { viewCount: 30 }), post('b', { viewCount: 2 })], featured, all: allPosts })

    const d = await getDiscovery({ context: 'writing' })

    expect(d.popular?.kind).toBe('recommended')
    expect(d.popular?.posts.map((p) => p.slug)).toEqual(['hay-1', 'hay-2'])
  })

  it('a failing series list makes only the series block null, other blocks are still there', async () => {
    stub({ featured, all: allPosts, series: new Error('series down') })

    const d = await getDiscovery({ context: 'writing' })

    expect(d.series).toBeNull()
    expect(d.seriesTotal).toBe(0)
    expect(d.popular?.posts).toHaveLength(2)
    expect(d.tags).not.toBeNull()
    expect(d.months).not.toBeNull()
  })

  it('a failing read of all posts makes tags and months null, series and recommended posts are still there', async () => {
    stub({ featured, all: new Error('posts down'), series: [series(1)] })

    const d = await getDiscovery({ context: 'writing' })

    expect(d.tags).toBeNull()
    expect(d.tagTotal).toBe(0)
    expect(d.months).toBeNull()
    expect(d.series).toHaveLength(1)
    expect(d.popular?.kind).toBe('recommended')
  })

  it('a failing popular posts source still uses curated posts', async () => {
    stub({ popular: new Error('sort=popular down'), featured, all: allPosts })

    const d = await getDiscovery({ context: 'writing' })

    expect(d.popular?.kind).toBe('recommended')
    expect(d.popular?.posts).toHaveLength(2)
  })

  it('both popular posts and curated posts failing makes that block null, other blocks are still there', async () => {
    stub({ popular: new Error('down'), featured: new Error('down'), all: allPosts, series: [series(1)] })

    const d = await getDiscovery({ context: 'writing' })

    expect(d.popular).toBeNull()
    expect(d.tags).not.toBeNull()
    expect(d.series).toHaveLength(1)
  })

  it('backend completely down (every source rejects) still resolves, every block null — the page does not 500', async () => {
    const down = new Error('connect ECONNREFUSED')
    stub({ popular: down, featured: down, all: down, series: down })

    for (const context of ['writing', 'article'] as const) {
      const d = await getDiscovery({ context, excludeSlug: 'x' })

      expect(d).toMatchObject({
        popular: null,
        recent: null,
        series: null,
        seriesTotal: 0,
        tags: null,
        tagTotal: 0,
        months: null,
      })
    }
  })

  it('an empty source makes the block null, not an empty array, so there is no orphan heading', async () => {
    stub({ popular: [], featured: [], all: [], series: [] })

    const d = await getDiscovery({ context: 'writing' })

    expect(d).toMatchObject({ popular: null, recent: null, series: null, seriesTotal: 0, tags: null, tagTotal: 0, months: null })
  })

  it('post page: subtracts the post being read from every list, "Recently written" is the 5 newest posts, no series/tags/months', async () => {
    stub({
      popular: [
        post('a', { viewCount: 30 }),
        post('dang-doc', { viewCount: 25 }),
        post('b', { viewCount: 20 }),
        post('c', { viewCount: 15 }),
      ],
      featured: [post('dang-doc', { featured: true, featuredRank: 1 }), ...featured],
      all: [post('dang-doc', { publishedAt: '2026-10-20T00:00:00Z' }), ...allPosts],
      series: [series(1)],
    })

    const d = await getDiscovery({ context: 'article', excludeSlug: 'dang-doc' })

    expect(d.popular).toMatchObject({ kind: 'popular' })
    expect(d.popular?.posts.map((p) => p.slug)).toEqual(['a', 'b', 'c'])
    expect(d.recent?.map((p) => p.slug)).toEqual(['bai-0', 'bai-1', 'bai-2', 'bai-3', 'bai-4'])
    expect(d).toMatchObject({ series: null, seriesTotal: 0, tags: null, tagTotal: 0, months: null, blogroll: [] })
    // Do not call a source this context does not show.
    expect(getSeriesList).not.toHaveBeenCalled()
  })

  it('post page: the "Most read" threshold is computed after subtracting the post being read', async () => {
    stub({
      popular: [post('dang-doc', { viewCount: 90 }), post('a', { viewCount: 30 }), post('b', { viewCount: 20 })],
      featured,
      all: allPosts,
    })

    const d = await getDiscovery({ context: 'article', excludeSlug: 'dang-doc' })

    // Only 2 posts pass the threshold: a "most read" block with two rows is not meaningful, so fall back to curated.
    expect(d.popular?.kind).toBe('recommended')
    expect(d.popular?.posts.map((p) => p.slug)).toEqual(['hay-1', 'hay-2'])
  })

  it('post page: a failing read of all posts makes only "Recently written" null', async () => {
    stub({ featured, all: new Error('down') })

    const d = await getDiscovery({ context: 'article', excludeSlug: 'x' })

    expect(d.recent).toBeNull()
    expect(d.popular?.posts).toHaveLength(2)
  })
})
