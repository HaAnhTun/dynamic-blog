import { afterEach, describe, expect, it, vi } from 'vitest'
import { seriesRows } from './series-rows'
import { archiveMonthHref, buildLeftRail } from './reader-rail'
import type { Category, PostSummary, SeriesDetail } from './types'

/*
 * buildLeftRail is pure: the fixtures below are the whole input. `discovery.ts` pulls in server modules
 * at import time, but none of them is called here.
 */

const CATEGORY: Category = { id: 'c1', slug: 'cloud', name: 'Cloud', description: null }
const OTHER_CATEGORY: Category = { id: 'c2', slug: 'life', name: 'Life', description: null }

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

/** A post of `CATEGORY`, `day` days into October 2026. */
const inCategory = (slug: string, day: number, over: Partial<PostSummary> = {}) =>
  post(slug, { category: CATEGORY, publishedAt: `2026-10-${String(day).padStart(2, '0')}T00:00:00Z`, ...over })

function seriesOf(count: number, over: Partial<SeriesDetail> = {}): SeriesDetail {
  return {
    id: 's1',
    title: 'Async pipeline',
    slug: 'async-pipeline',
    description: null,
    posts: Array.from({ length: count }, (_, i) =>
      post(`part-${i + 1}`, {
        title: `Part ${i + 1}`,
        // The stored position has gaps on purpose: only the position among the published parts counts.
        series: {
          id: 's1',
          slug: 'async-pipeline',
          title: 'Async pipeline',
          position: (i + 1) * 10,
          partNumber: i + 1,
          partCount: count,
        },
      }),
    ),
    ...over,
  }
}

type Group = { posts: { slug: string; locale?: string }[] }
const slugs = (posts: { slug: string }[] | undefined) => posts?.map((p) => p.slug)
const primaryPosts = (model: ReturnType<typeof buildLeftRail>) => (model.primary as unknown as Group).posts

afterEach(() => vi.restoreAllMocks())

describe('buildLeftRail: series path', () => {
  it('a post that is one of the parts gets the series group, counted by position in series.posts', () => {
    const series = seriesOf(3)
    const current = series.posts[1]!
    const model = buildLeftRail({ post: current, series, all: series.posts, language: 'vi' })

    expect(model.primary).toMatchObject({
      kind: 'series',
      slug: 'async-pipeline',
      title: 'Async pipeline',
      current: 2,
      total: 3,
      windowed: false,
      rows: seriesRows(3, 1),
    })
    expect(model.primary).toMatchObject({
      parts: [
        { slug: 'part-1', title: 'Part 1' },
        { slug: 'part-2', title: 'Part 2' },
        { slug: 'part-3', title: 'Part 3' },
      ],
    })
  })

  it('the part number is the position among the published parts, not the stored position', () => {
    const series = seriesOf(3)
    // Stored positions are 10, 20, 30: reading the third part must still say 3.
    const model = buildLeftRail({ post: series.posts[2]!, series, all: series.posts, language: 'vi' })

    expect(model.primary).toMatchObject({ kind: 'series', current: 3, total: 3 })
  })

  it('reuses the window rows of seriesRows and sets windowed from 8 parts', () => {
    const series = seriesOf(8)
    const model = buildLeftRail({ post: series.posts[4]!, series, all: series.posts, language: 'vi' })

    expect(model.primary).toMatchObject({ kind: 'series', current: 5, total: 8, windowed: true, rows: seriesRows(8, 4) })
  })

  it('7 parts are not windowed', () => {
    const series = seriesOf(7)
    const model = buildLeftRail({ post: series.posts[0]!, series, all: series.posts, language: 'vi' })

    expect(model.primary).toMatchObject({ kind: 'series', total: 7, windowed: false })
  })

  it('a post that is not among the published parts falls through to its category', () => {
    const series = seriesOf(3)
    const stray = inCategory('stray', 5)
    const sibling = inCategory('sibling', 4)
    const model = buildLeftRail({ post: stray, series, all: [stray, sibling, ...series.posts], language: 'vi' })

    expect(model.primary).toMatchObject({ kind: 'category', name: 'Cloud' })
    expect(slugs(primaryPosts(model))).toEqual(['sibling'])
    expect(model.secondary).toBeNull()
  })

  it('a null series behaves as no series', () => {
    const solo = inCategory('solo', 5)
    const other = inCategory('other', 6)
    const model = buildLeftRail({ post: solo, series: null, all: [solo, other], language: 'vi' })

    expect(model.primary).toMatchObject({ kind: 'category' })
  })

  it('secondary: a category group of at most 4 posts, never a part of the series', () => {
    const series = seriesOf(2)
    const current = { ...series.posts[0]!, category: CATEGORY }
    const partInCategory = { ...series.posts[1]!, category: CATEGORY, publishedAt: '2026-10-30T00:00:00Z' }
    const others = Array.from({ length: 6 }, (_, i) => inCategory(`c${i + 1}`, i + 10))
    const model = buildLeftRail({ post: current, series, all: [current, partInCategory, ...others], language: 'vi' })

    expect(model.secondary).toMatchObject({ kind: 'category', name: 'Cloud' })
    // newest first, capped at 4, no part of the series, not the current post
    expect(slugs(model.secondary?.posts)).toEqual(['c6', 'c5', 'c4', 'c3'])
  })

  it('secondary is null without a category, and when the only other posts are parts of the series', () => {
    const series = seriesOf(2)
    const noCategory = buildLeftRail({ post: series.posts[0]!, series, all: series.posts, language: 'vi' })
    expect(noCategory.secondary).toBeNull()

    const current = { ...series.posts[0]!, category: CATEGORY }
    const partInCategory = { ...series.posts[1]!, category: CATEGORY }
    const onlyParts = buildLeftRail({ post: current, series, all: [current, partInCategory], language: 'vi' })
    expect(onlyParts.secondary).toBeNull()
  })
})

describe('buildLeftRail: category path', () => {
  it('excludes the current post, sorts newest first by date (not API order), and drops undated posts', () => {
    const current = inCategory('current', 15)
    const all = [
      inCategory('older', 2),
      current,
      inCategory('newest', 20),
      inCategory('undated', 1, { publishedAt: null }),
      inCategory('broken', 1, { publishedAt: 'not a date' }),
      inCategory('middle', 9),
      post('elsewhere', { category: OTHER_CATEGORY, publishedAt: '2026-10-25T00:00:00Z' }),
    ]
    const model = buildLeftRail({ post: current, series: null, all, language: 'vi' })

    expect(model.primary).toMatchObject({ kind: 'category', name: 'Cloud' })
    expect(slugs(primaryPosts(model))).toEqual(['newest', 'middle', 'older'])
  })

  it('caps the list at 6', () => {
    const current = inCategory('current', 1)
    const all = [current, ...Array.from({ length: 9 }, (_, i) => inCategory(`p${i + 1}`, i + 2))]
    const model = buildLeftRail({ post: current, series: null, all, language: 'vi' })

    expect(slugs(primaryPosts(model))).toEqual(['p9', 'p8', 'p7', 'p6', 'p5', 'p4'])
  })

  it('carries the category name, never a category href', () => {
    const current = inCategory('current', 1)
    const model = buildLeftRail({ post: current, series: null, all: [current, inCategory('b', 2)], language: 'vi' })

    expect(JSON.stringify(model)).not.toMatch(/\/(topics|categories|category)/)
    expect(model.primary).not.toHaveProperty('href')
    expect(model.secondary).toBeNull()
  })

  it('RailPost.locale follows postLinkLocale: only a post in another language carries a locale', () => {
    const current = inCategory('current', 1, { language: 'vi' })
    const all = [
      current,
      inCategory('same', 2, { language: 'vi' }),
      inCategory('other', 3, { language: 'en' }),
      inCategory('none', 4),
    ]
    const model = buildLeftRail({ post: current, series: null, all, language: 'vi' })

    expect(primaryPosts(model).map((p) => [p.slug, p.locale])).toEqual([
      ['none', undefined],
      ['other', 'en'],
      ['same', undefined],
    ])
  })

  it('every RailPost is exactly id, slug, title and locale', () => {
    const current = inCategory('current', 1)
    const model = buildLeftRail({ post: current, series: null, all: [current, inCategory('b', 2)], language: 'vi' })

    expect(primaryPosts(model)).toEqual([{ id: 'id-b', slug: 'b', title: 'Title b', locale: undefined }])
  })
})

describe('buildLeftRail: latest path', () => {
  it('a post without a category gets the newest 5 posts, current excluded', () => {
    const current = post('current', { publishedAt: '2026-10-20T00:00:00Z' })
    const all = [
      current,
      ...Array.from({ length: 7 }, (_, i) => post(`p${i + 1}`, { publishedAt: `2026-09-0${i + 1}T00:00:00Z` })),
    ]
    const model = buildLeftRail({ post: current, series: null, all, language: 'vi' })

    expect(model.primary?.kind).toBe('latest')
    expect(slugs(primaryPosts(model))).toEqual(['p7', 'p6', 'p5', 'p4', 'p3'])
  })

  it('a category with no other post falls through to latest', () => {
    const current = inCategory('current', 1)
    const all = [current, post('a', { publishedAt: '2026-09-01T00:00:00Z' }), post('b', { publishedAt: '2026-09-02T00:00:00Z' })]
    const model = buildLeftRail({ post: current, series: null, all, language: 'vi' })

    expect(model.primary?.kind).toBe('latest')
    expect(slugs(primaryPosts(model))).toEqual(['b', 'a'])
  })

  it('a one-post blog gives primary null (and still a month)', () => {
    const only = post('only')
    const model = buildLeftRail({ post: only, series: null, all: [only], language: 'vi' })

    expect(model.primary).toBeNull()
    expect(model.secondary).toBeNull()
    expect(model.month).toEqual({ year: 2026, month: 10, href: '/archive#thang-2026-10' })
  })
})

describe('buildLeftRail: month link', () => {
  const newest = post('newest', { publishedAt: '2026-11-02T00:00:00Z' })

  it('the newest year links to the anchor on /archive', () => {
    const current = post('current', { publishedAt: '2026-03-09T00:00:00Z' })
    const model = buildLeftRail({ post: current, series: null, all: [newest, current], language: 'vi' })

    expect(model.month).toEqual({ year: 2026, month: 3, href: '/archive#thang-2026-03' })
  })

  it('an older year carries ?year= before the anchor', () => {
    const current = post('current', { publishedAt: '2025-12-09T00:00:00Z' })
    const model = buildLeftRail({ post: current, series: null, all: [newest, current], language: 'vi' })

    expect(model.month).toEqual({ year: 2025, month: 12, href: '/archive?year=2025#thang-2025-12' })
  })

  it('null and unparsable dates give month null', () => {
    for (const publishedAt of [null, 'not a date', '']) {
      const current = post('current', { publishedAt })
      const model = buildLeftRail({ post: current, series: null, all: [newest, current], language: 'vi' })
      expect(model.month, String(publishedAt)).toBeNull()
    }
  })

  it('a post missing from `all` still links to its own year', () => {
    const current = post('current', { publishedAt: '2024-01-09T00:00:00Z' })
    const model = buildLeftRail({ post: current, series: null, all: [], language: 'vi' })

    expect(model.month).toEqual({ year: 2024, month: 1, href: '/archive#thang-2024-01' })
  })

  describe.each(['Asia/Ho_Chi_Minh', 'America/Los_Angeles'])('under TZ=%s', (zone) => {
    const original = process.env.TZ
    afterEach(() => {
      if (original === undefined) delete process.env.TZ
      else process.env.TZ = original
    })

    it('2026-10-31T23:30:00Z is month 10, from UTC fields', () => {
      process.env.TZ = zone
      // Local time would give 1 November in Ho Chi Minh City (UTC+7) and 31 October 16:30 in Los Angeles.
      const current = post('current', { publishedAt: '2026-10-31T23:30:00Z' })
      const model = buildLeftRail({ post: current, series: null, all: [current], language: 'vi' })

      expect(model.month).toEqual({ year: 2026, month: 10, href: '/archive#thang-2026-10' })
    })

    it('2026-01-01T00:30:00Z is January 2026 (local time in Los Angeles would be December 2025)', () => {
      process.env.TZ = zone
      const current = post('current', { publishedAt: '2026-01-01T00:30:00Z' })
      const model = buildLeftRail({ post: current, series: null, all: [current], language: 'vi' })

      expect(model.month).toMatchObject({ year: 2026, month: 1 })
    })
  })
})

describe('archiveMonthHref', () => {
  it('newest year: anchor on /archive, month zero-padded', () => {
    expect(archiveMonthHref(2026, 3, 2026)).toBe('/archive#thang-2026-03')
    expect(archiveMonthHref(2026, 12, 2026)).toBe('/archive#thang-2026-12')
  })

  it('older year: ?year= before the anchor', () => {
    expect(archiveMonthHref(2025, 12, 2026)).toBe('/archive?year=2025#thang-2025-12')
  })
})

describe('buildLeftRail: odd input', () => {
  it('never throws: broken lists give a model without groups', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const current = inCategory('current', 1)

    const nullAll = buildLeftRail({ post: current, series: null, all: null as unknown as PostSummary[], language: 'vi' })
    expect(nullAll).toEqual({
      primary: null,
      secondary: null,
      month: { year: 2026, month: 10, href: '/archive#thang-2026-10' },
    })

    const brokenSeries = buildLeftRail({
      post: current,
      series: { id: 's', title: 't', slug: 's', description: null, posts: null as unknown as PostSummary[] },
      all: [current],
      language: 'vi',
    })
    expect(brokenSeries.primary).toBeNull()

    const brokenItems = buildLeftRail({
      post: current,
      series: null,
      all: [null as unknown as PostSummary],
      language: 'vi',
    })
    expect(brokenItems).toEqual({ primary: null, secondary: null, month: null })
    expect(warn).toHaveBeenCalled()
  })
})
