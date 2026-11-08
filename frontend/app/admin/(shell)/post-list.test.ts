import { describe, expect, it } from 'vitest'
import {
  ACCENTED_QUERY,
  D_STROKE_TITLE,
  MIXED_CASE_QUERY_MATCH,
  MIXED_CASE_QUERY_MISS,
  MIXED_CASE_TITLE,
  PIPELINE_TITLE,
  UPPERCASE_ACCENTED_QUERY,
} from '@/test/fixtures/vi/post-list-search'
import type { PostSummary } from '@/lib/types'
import {
  categoryOptions,
  countPosts,
  filterPosts,
  healthCounts,
  listHref,
  matchesQuery,
  pageOf,
  parseHealth,
  parseLanguage,
  parsePage,
  parseQuery,
  parseSlug,
  parseSort,
  parseStatus,
  shownEditDate,
  sortPosts,
  tagOptions,
} from './post-list'

const post = (over: Partial<PostSummary> = {}): PostSummary => ({
  id: 'p1',
  title: 'First post',
  slug: 'first-post',
  excerpt: null,
  status: 'DRAFT',
  category: null,
  tags: [],
  featured: false,
  readingMinutes: 1,
  publishedAt: null,
  ...over,
})

describe('parsePage', () => {
  // Two separate guards (shape, then range): each value below is stopped by only one of the two.
  it.each([
    ['1e3', 0],
    ['-1', 0],
    [' 2', 0],
    ['2.0', 0],
    ['0x10', 0],
    ['abc', 0],
    ['', 0],
    ['2147483648', 0],
    ['3', 3],
    ['100000', 100000],
    ['100001', 0],
  ])('?page=%j → %i', (raw, expected) => {
    expect(parsePage(raw)).toBe(expected)
  })

  it('takes the first value when ?page repeats, and 0 when missing', () => {
    expect(parsePage(['4', '9'])).toBe(4)
    expect(parsePage(undefined)).toBe(0)
  })
})

describe('parseStatus / parseQuery', () => {
  // Pinned on purpose: the "archived" filter was removed, because no action puts a post into the
  // ARCHIVED status — that entry was always empty. An old link's `?status=archived` falls back to "all".
  it('accepts only the two real statuses; everything else, including "archived", is "all"', () => {
    expect(parseStatus('draft')).toBe('draft')
    expect(parseStatus('published')).toBe('published')
    expect(parseStatus('archived')).toBe('all')
    expect(parseStatus('DRAFT')).toBe('all')
    expect(parseStatus('xoa-het')).toBe('all')
    expect(parseStatus(undefined)).toBe('all')
    expect(parseStatus(['draft', 'published'])).toBe('draft')
  })

  it('trims whitespace and limits the length of the search box', () => {
    expect(parseQuery('  markdown  ')).toBe('markdown')
    expect(parseQuery('x'.repeat(500))).toHaveLength(100)
    expect(parseQuery(undefined)).toBe('')
  })
})

describe('matchesQuery', () => {
  const pipeline = post({ title: PIPELINE_TITLE, slug: 'sample-post-12' })

  it('ignores accents and case', () => {
    expect(matchesQuery(pipeline, ACCENTED_QUERY)).toBe(true)
    expect(matchesQuery(pipeline, 'bat dong bo')).toBe(true)
    expect(matchesQuery(pipeline, UPPERCASE_ACCENTED_QUERY)).toBe(true)
  })

  it('a Vietnamese query matches a title with non-Latin characters under vi, case-insensitively', () => {
    const mixed = post({ title: MIXED_CASE_TITLE, slug: 'duong-ong' })
    expect(matchesQuery(mixed, MIXED_CASE_QUERY_MATCH, 'vi')).toBe(true)
    expect(matchesQuery(mixed, MIXED_CASE_QUERY_MISS, 'vi')).toBe(false)
  })

  it('a plain d finds U+0111 (d with stroke): a letter that does not decompose through NFD', () => {
    expect(matchesQuery(post({ title: D_STROKE_TITLE }), 'duong ong')).toBe(true)
  })

  it('also searches by slug, and a non-matching query excludes', () => {
    expect(matchesQuery(pipeline, 'post-12')).toBe(true)
    expect(matchesQuery(pipeline, 'kubernetes')).toBe(false)
  })

  it('an empty search box (or only whitespace) filters nothing', () => {
    expect(matchesQuery(pipeline, '   ')).toBe(true)
  })

  it('characters the slug drops (#, +, non-Latin) are compared verbatim: "#" does not match every post, "C#" does not become "c"', () => {
    const csharp = post({ title: 'Learning C# in a week', slug: 'learning-c-in-a-week' })
    const cache = post({ title: 'What is a cache', slug: 'what-is-a-cache' })

    expect(matchesQuery(cache, '#')).toBe(false)
    expect(matchesQuery(cache, '?!')).toBe(false)
    expect(matchesQuery(csharp, 'c#')).toBe(true)
    expect(matchesQuery(csharp, 'C#')).toBe(true)
    expect(matchesQuery(cache, 'C#')).toBe(false)
    expect(matchesQuery(cache, '缓存')).toBe(false)
  })

  it('Vietnamese text in decomposed form (NFD) still searches by slug, not falling back to verbatim comparison', () => {
    expect(matchesQuery(pipeline, ACCENTED_QUERY.normalize('NFD'))).toBe(true)
  })
})

describe('countPosts / filterPosts', () => {
  const posts = [
    post({ id: 'a', status: 'PUBLISHED', viewCount: 10, title: 'What is markdown' }),
    post({ id: 'b', status: 'PUBLISHED', viewCount: 5 }),
    post({ id: 'c', status: 'DRAFT' }),
    post({ id: 'd', status: 'ARCHIVED', viewCount: 1 }),
  ]

  // Pinned on purpose: there is no "archived" entry any more, and the total views only sums PUBLISHED posts —
  // exactly the number the public page prints (the backend only counts published posts at /api/v1/stats). Post "d", stranded in the
  // ARCHIVED status, is still in "all", but its views do not enter the total.
  it('counts by status; views only sum published posts (missing is 0)', () => {
    expect(countPosts(posts)).toEqual({ all: 4, published: 2, draft: 1, views: 15 })
    expect(countPosts([])).toEqual({ all: 0, published: 0, draft: 0, views: 0 })
    expect(countPosts([post({ status: 'DRAFT', viewCount: 7 })]).views).toBe(0)
  })

  it('filters by status then by search box, keeping backend order', () => {
    expect(filterPosts(posts, { status: 'all', query: '' }).map((p) => p.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(filterPosts(posts, { status: 'published', query: '' }).map((p) => p.id)).toEqual(['a', 'b'])
    expect(filterPosts(posts, { status: 'draft', query: '' }).map((p) => p.id)).toEqual(['c'])
    expect(filterPosts(posts, { status: 'published', query: 'markdown' }).map((p) => p.id)).toEqual(['a'])
  })
})

describe('pageOf', () => {
  const items = Array.from({ length: 45 }, (_, i) => i)

  it('20 per page', () => {
    expect(pageOf(items, 0)).toEqual({ items: items.slice(0, 20), page: 0, totalPages: 3 })
    expect(pageOf(items, 2).items).toEqual([40, 41, 42, 43, 44])
  })

  it('a page past the end is clamped to the last page; an empty list is one empty page', () => {
    expect(pageOf(items, 99).page).toBe(2)
    expect(pageOf([], 5)).toEqual({ items: [], page: 0, totalPages: 1 })
  })
})

describe('filtering by category, tag, "Needs attention"; sorting by views', () => {
  const aws = { id: 't1', name: 'AWS', slug: 'aws' }
  const java = { id: 't2', name: 'Java', slug: 'java' }
  const arch = { id: 'c1', name: 'Design', slug: 'design', description: null }
  const backend = { id: 'c2', name: 'Backend', slug: 'backend', description: null }
  const posts = [
    post({ id: 'a', status: 'PUBLISHED', category: arch, tags: [aws], excerpt: 'yes', viewCount: 5 }),
    post({ id: 'b', status: 'PUBLISHED', category: backend, tags: [java, aws], excerpt: null, viewCount: 40 }),
    post({ id: 'c', status: 'DRAFT', category: null, tags: [], excerpt: '  ', featured: true }),
    post({ id: 'd', status: 'PUBLISHED', category: arch, tags: [], excerpt: 'yes', viewCount: 40 }),
  ]

  it('reads parameters: slugs are trimmed and lowercased; an unknown sort and "Needs attention" fall back to the default', () => {
    expect(parseSlug(' Design ')).toBe('design')
    expect(parseSlug(undefined)).toBe('')
    expect(parseSort('views')).toBe('views')
    expect(parseSort('updated')).toBe('updated')
    expect(parseSort(['updated', 'views'])).toBe('updated')
    expect(parseSort('VIEWS')).toBe('newest')
    expect(parseSort('UPDATED')).toBe('newest')
    expect(parseHealth('no-tags')).toBe('no-tags')
    expect(parseHealth('none-such')).toBeNull()
    expect(parseHealth(['no-excerpt', 'x'])).toBe('no-excerpt')
  })

  it('filters by category slug, tag slug, and combined with status', () => {
    expect(filterPosts(posts, { status: 'all', query: '', category: 'design' }).map((p) => p.id)).toEqual(['a', 'd'])
    expect(filterPosts(posts, { status: 'all', query: '', tag: 'aws' }).map((p) => p.id)).toEqual(['a', 'b'])
    expect(filterPosts(posts, { status: 'published', query: '', category: 'design', tag: 'aws' }).map((p) => p.id)).toEqual(['a'])
    expect(filterPosts(posts, { status: 'all', query: '', category: 'none-such' })).toEqual([])
  })

  it('"Needs attention": counts each kind, and filters by exactly that kind', () => {
    expect(healthCounts(posts)).toEqual({
      'draft-no-category': 1,
      'featured-unpublished': 1,
      // A description of only whitespace is also no description.
      'no-excerpt': 2,
      'no-tags': 2,
    })
    expect(filterPosts(posts, { status: 'all', query: '', health: 'no-excerpt' }).map((p) => p.id)).toEqual(['b', 'c'])
    expect(filterPosts(posts, { status: 'all', query: '', health: 'draft-no-category' }).map((p) => p.id)).toEqual(['c'])
  })

  it('sorts by views: most first, ties keep the backend newest-created-first order', () => {
    expect(sortPosts(posts, 'views').map((p) => p.id)).toEqual(['b', 'd', 'a', 'c'])
    expect(sortPosts(posts, 'newest').map((p) => p.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('category/tag choices: only those that have posts, each once, ordered by name', () => {
    expect(categoryOptions(posts)).toEqual([
      { slug: 'backend', name: 'Backend' },
      { slug: 'design', name: 'Design' },
    ])
    expect(tagOptions(posts)).toEqual([
      { slug: 'aws', name: 'AWS' },
      { slug: 'java', name: 'Java' },
    ])
  })
})

describe('"Recently edited" sort', () => {
  it('sorts by last edit, newest first; compares by time, not by text', () => {
    const posts = [
      post({ id: 'a', updatedAt: '2026-10-01T00:00:00Z' }),
      post({ id: 'b', updatedAt: '2026-10-03T00:00:00Z' }),
      // Same second as "c" but with a fraction: as text "…00Z" sorts AFTER "…00.5Z" though it is earlier.
      post({ id: 'c', updatedAt: '2026-10-02T00:00:00.5Z' }),
      post({ id: 'd', updatedAt: '2026-10-02T00:00:00Z' }),
    ]

    expect(sortPosts(posts, 'updated').map((p) => p.id)).toEqual(['b', 'c', 'd', 'a'])
  })

  it('stable: the same time keeps the backend newest-created-first order', () => {
    const same = '2026-10-02T08:00:00Z'
    const posts = [post({ id: 'x', updatedAt: same }), post({ id: 'y', updatedAt: same }), post({ id: 'z', updatedAt: same })]

    expect(sortPosts(posts, 'updated').map((p) => p.id)).toEqual(['x', 'y', 'z'])
  })

  it('missing or corrupt updatedAt (old backend): uses the publish date; with neither it goes last, keeping backend order', () => {
    const posts = [
      post({ id: 'none-1' }),
      post({ id: 'published', publishedAt: '2026-10-05T00:00:00Z' }),
      post({ id: 'broken', updatedAt: 'not a date', publishedAt: '2026-10-01T00:00:00Z' }),
      post({ id: 'edited', updatedAt: '2026-10-03T00:00:00Z' }),
      post({ id: 'none-2' }),
    ]

    expect(sortPosts(posts, 'updated').map((p) => p.id)).toEqual(['published', 'edited', 'broken', 'none-1', 'none-2'])
  })

  it('does not mutate the input array', () => {
    const posts = [post({ id: 'a', updatedAt: '2026-10-01T00:00:00Z' }), post({ id: 'b', updatedAt: '2026-10-03T00:00:00Z' })]

    sortPosts(posts, 'updated')

    expect(posts.map((p) => p.id)).toEqual(['a', 'b'])
  })
})

describe('shownEditDate: "edited <date>" on a row secondary line', () => {
  it('draft: always shows the last edit, the only thing telling which draft is still being written', () => {
    expect(shownEditDate(post({ status: 'DRAFT', updatedAt: '2026-10-02T19:00:00Z' }), 'newest')).toBe('2026-10-02T19:00:00Z')
  })

  it('published post: only when edited on a (UTC) day after the publish day — the same rule as "Updated" on the post page', () => {
    const published = { status: 'PUBLISHED', publishedAt: '2026-10-01T02:00:00Z' }
    expect(shownEditDate(post({ ...published, updatedAt: '2026-10-01T09:00:00Z' }), 'newest')).toBeNull()
    expect(shownEditDate(post({ ...published, updatedAt: '2026-10-04T09:00:00Z' }), 'newest')).toBe('2026-10-04T09:00:00Z')
  })

  it('while sorting by "Recently edited": always shown, because that is the sort key itself', () => {
    const published = post({ status: 'PUBLISHED', publishedAt: '2026-10-01T02:00:00Z', updatedAt: '2026-10-01T09:00:00Z' })
    expect(shownEditDate(published, 'updated')).toBe('2026-10-01T09:00:00Z')
  })

  it('missing or unreadable: shows nothing', () => {
    expect(shownEditDate(post({ status: 'DRAFT' }), 'updated')).toBeNull()
    expect(shownEditDate(post({ status: 'DRAFT', updatedAt: 'broken' }), 'updated')).toBeNull()
  })
})

describe('listHref', () => {
  it('drops default parameters, keeps the active filters', () => {
    expect(listHref({ status: 'all', query: '' })).toBe('/admin')
    expect(listHref({ status: 'draft', query: '' })).toBe('/admin?status=draft')
    expect(listHref({ status: 'all', query: ACCENTED_QUERY, page: 2 })).toBe(
      '/admin?q=b%E1%BA%A5t+%C4%91%E1%BB%93ng+b%E1%BB%99&page=2',
    )
    expect(listHref({ status: 'published', query: '', page: 0 })).toBe('/admin?status=published')
  })

  it('carries category, tag, sort and "Needs attention"; default values are dropped', () => {
    expect(
      listHref({ status: 'draft', query: '', category: 'design', tag: 'aws', sort: 'views', health: 'no-tags', page: 1 }),
    ).toBe('/admin?status=draft&cat=design&tag=aws&sort=views&health=no-tags&page=1')
    expect(listHref({ status: 'all', query: '', category: '', tag: '', sort: 'newest', health: null })).toBe('/admin')
    expect(listHref({ status: 'all', query: '', sort: 'updated' })).toBe('/admin?sort=updated')
    // Round trip: the built sort reads back exactly as before.
    expect(
      parseSort(
        new URL(`http://x${listHref({ status: 'all', query: '', sort: 'updated' })}`).searchParams.get('sort') ?? undefined,
      ),
    ).toBe('updated')
  })
})

describe('language filter', () => {
  const posts = [
    post({ id: 'a', language: 'vi' }),
    post({ id: 'b', language: 'en' }),
    post({ id: 'c', language: 'en' }),
    post({ id: 'd' }),
  ]

  it('parseLanguage accepts an enabled locale and treats anything else as every language', () => {
    expect(parseLanguage('en')).toBe('en')
    expect(parseLanguage(['vi', 'en'])).toBe('vi')
    expect(parseLanguage('fr')).toBe('')
    expect(parseLanguage('')).toBe('')
    expect(parseLanguage(undefined)).toBe('')
  })

  it('filterPosts keeps only the posts of that language; no language keeps them all', () => {
    expect(filterPosts(posts, { status: 'all', query: '', language: 'en' }).map((p) => p.id)).toEqual(['b', 'c'])
    expect(filterPosts(posts, { status: 'all', query: '', language: '' })).toHaveLength(4)
    expect(filterPosts(posts, { status: 'all', query: '' })).toHaveLength(4)
  })

  it('listHref writes lang only when set, and keeps the other filters', () => {
    expect(listHref({ status: 'all', query: '', language: 'en' })).toBe('/admin?lang=en')
    expect(listHref({ status: 'draft', query: '', language: '' })).toBe('/admin?status=draft')
    expect(listHref({ status: 'draft', query: 'x', language: 'vi', page: 1 })).toBe('/admin?status=draft&q=x&lang=vi&page=1')
  })
})
