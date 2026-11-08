import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { routeMap } from '@/test/routes'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { postUrl } from '@/components/site/ArticleJsonLd'
import { defaultSiteContent } from '@/content/defaults'
import { DEFAULT_LOCALE } from '@/i18n/config'
import { getPosts } from '@/lib/api'
import { getSeriesList } from '@/lib/series'
import { getStats } from '@/lib/stats'
import { getCategories, getTags } from '@/lib/taxonomy'
import type { Category, PostSummary, SeriesSummary, Tag } from '@/lib/types'
import { runThroughDataCache } from '@/test/next-data-cache'
import sitemap from './sitemap'
import { msg } from '@/test/render-intl'
import { TAG_NAME_WITH_DIACRITICS } from '@/test/fixtures/vi/mediaUnit-sitemap'

/**
 * `sitemap` is an ordinary exported async function — Next's metadata route loader calls
 * it and serialises what it returns — so these tests call it directly and assert on the
 * array. Nothing here renders anything.
 *
 * The data sources are mocked at the module boundary rather than at `fetch`, because
 * what this file must prove is about the SET OF URLS, not about HTTP: that every post,
 * category and tag is listed, that paging is real, that nothing is listed
 * twice, and that a dead backend does not take the build down with it. `lib/api.test.ts`
 * and `lib/taxonomy.test.ts` already own the envelope and error-mapping behaviour.
 */
vi.mock('@/lib/api', () => ({ getPosts: vi.fn() }))
vi.mock('@/lib/taxonomy', () => ({ getCategories: vi.fn(), getTags: vi.fn() }))
// Two new sources: the series list for /series/{slug}, and the stats to know whether the gallery
// has photos. Default in beforeEach: no series yet, an empty gallery — exactly the state
// of a freshly upgraded site, so the old tests see exactly the set of URLs they always saw.
vi.mock('@/lib/series', () => ({ getSeriesList: vi.fn() }))
vi.mock('@/lib/stats', () => ({ getStats: vi.fn() }))

const ORIGIN = 'https://blog.example.com'

/** The nine static paths, in the order the sitemap emits them — the reading order of the header and footer. */
const STATIC_URLS = [
  ORIGIN,
  `${ORIGIN}/writing`,
  `${ORIGIN}/start-here`,
  `${ORIGIN}/series`,
  `${ORIGIN}/topics`,
  `${ORIGIN}/archive`,
  `${ORIGIN}/case-studies`,
  `${ORIGIN}/about`,
  `${ORIGIN}/search`,
]

const CASE_STUDY_SLUGS = defaultSiteContent(DEFAULT_LOCALE).caseStudies.map((study) => study.slug)
const CASE_STUDY_URLS = CASE_STUDY_SLUGS.map((slug) => `${ORIGIN}/case-studies/${slug}`)

function series(slug: string, latestPublishedAt: string): SeriesSummary {
  return {
    id: `s-${slug}`,
    title: `Series ${slug}`,
    slug,
    description: null,
    postCount: 2,
    readingMinutes: 9,
    latestPublishedAt,
    parts: [],
  }
}

function stubSeries(list: SeriesSummary[]) {
  vi.mocked(getSeriesList).mockResolvedValue(list)
}

function stubStats(galleryPhotos: number) {
  vi.mocked(getStats).mockResolvedValue({ publishedPosts: 0, totalViews: 0, seriesCount: 0, galleryPhotos })
}

function post(n: number, over: Partial<PostSummary> = {}): PostSummary {
  return {
    id: `p${n}`,
    title: `Post ${n}`,
    slug: `bai-viet-${n}`,
    excerpt: null,
    status: 'PUBLISHED',
    category: null,
    tags: [],
    // Distinct, ascending, and all in the past: `newest` has to pick one of these and
    // a test that cannot tell them apart would pass with `dates[0]`.
    publishedAt: `2026-01-${String(n).padStart(2, '0')}T00:00:00Z`,
    featured: false,
    readingMinutes: 1,
    ...over,
  }
}

const categories: Category[] = [
  { id: 'c1', name: 'Architecture', slug: 'kien-truc', description: null },
  { id: 'c2', name: 'Debugging', slug: 'go-loi', description: 'Tracking down a bug.' },
]

const tags: Tag[] = [
  // Name and slug deliberately differ: a sitemap built from `name` would emit
  // /tags/ followed by the name the Vietnamese tag name with diacritics, and /tags/CI%2FCD, both 404s. Measured off the running backend —
  // curl -s localhost:8080/api/v1/tags returns exactly this shape.
  { id: 't1', name: TAG_NAME_WITH_DIACRITICS, slug: 'bai-hoc' },
  { id: 't2', name: 'CI/CD', slug: 'ci-cd' },
]

/**
 * Serves `pages` as the backend would: page N answers `pages[N]`, out-of-range answers
 * an empty list (measured: `?page=99` is a 200 with `data: []`), and `meta.totalPages`
 * reports the real count unless overridden — which is how the two "the API is lying
 * about totalPages" tests below get their shape.
 */
function stubPosts(pages: PostSummary[][], meta: { totalPages?: number } = {}) {
  vi.mocked(getPosts).mockImplementation(async ({ page, size }) => ({
    items: pages[page] ?? [],
    meta: {
      page,
      size,
      totalElements: pages.flat().length,
      totalPages: meta.totalPages ?? pages.length,
    },
  }))
}

function stubTaxonomy() {
  vi.mocked(getCategories).mockResolvedValue(categories)
  vi.mocked(getTags).mockResolvedValue(tags)
}

type Entries = Awaited<ReturnType<typeof sitemap>>

/** Whether a URL is in the /en tree (the home page of it is exactly `/en`). */
function isEnglish(url: string): boolean {
  return url === `${ORIGIN}/en` || url.startsWith(`${ORIGIN}/en/`)
}

/** The default-locale URLs: what the sitemap listed before the site had a second language. */
function urls(entries: Entries): string[] {
  return entries.map((entry) => entry.url).filter((url) => !isEnglish(url))
}

/** The /en URLs. */
function englishUrls(entries: Entries): string[] {
  return entries.map((entry) => entry.url).filter(isEnglish)
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', ORIGIN)
  stubSeries([])
  stubStats(0)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('the URL set', () => {
  it('lists every static route, published post, category, tag and series — and nothing else', async () => {
    stubPosts([[post(1), post(2)]])
    stubTaxonomy()
    stubSeries([series('series-a', '2026-01-02T00:00:00Z')])
    stubStats(3)

    const entries = await sitemap()

    // An exact set, not a series of `toContain`s. A `toContain` suite passes when the
    // sitemap grows a URL nobody intended — a /?page=1 left over from the old listing,
    // say — and a URL that 404s is the one failure this file exists to prevent.
    //
    // Both posts are in one year, so there is no `/archive?year=` URL (see the "new pages"
    // describe below).
    expect(new Set(urls(entries))).toEqual(
      new Set([
        ...STATIC_URLS,
        ...CASE_STUDY_URLS,
        `${ORIGIN}/gallery`,
        `${ORIGIN}/posts/bai-viet-1`,
        `${ORIGIN}/posts/bai-viet-2`,
        `${ORIGIN}/categories/kien-truc`,
        `${ORIGIN}/categories/go-loi`,
        `${ORIGIN}/tags/bai-hoc`,
        `${ORIGIN}/tags/ci-cd`,
        `${ORIGIN}/series/series-a`,
      ]),
    )
  })

  it('promises no /projects URL, because no route serves one any more', async () => {
    stubPosts([[post(1)]])
    stubTaxonomy()

    // The portfolio section was removed at the owner's request — the work shown there
    // was not personal. Both route files are gone, so ANY /projects URL left in here
    // would be the one failure this file exists to prevent: a sitemap entry that 404s.
    expect(urls(await sitemap()).filter((url) => url.includes('/projects'))).toEqual([])
  })

  it('builds taxonomy URLs from the slug, never the name', async () => {
    stubPosts([[]])
    stubTaxonomy()

    const listed = urls(await sitemap())

    expect(listed).toContain(`${ORIGIN}/tags/bai-hoc`)
    expect(listed).toContain(`${ORIGIN}/tags/ci-cd`)
    // "CI/CD" as a path segment would add a third path segment and 404; the Vietnamese tag name would
    // percent-encode into a URL no route matches.
    expect(listed.some((url) => url.includes('CI/CD') || url.includes('%C3%A0'))).toBe(false)
  })

  it('leaves unpublished posts out', async () => {
    stubPosts([[post(1), post(2, { status: 'DRAFT' }), post(3, { status: 'ARCHIVED' })]])
    stubTaxonomy()

    const listed = urls(await sitemap())

    expect(listed).toContain(`${ORIGIN}/posts/bai-viet-1`)
    // A draft's URL answers 404 to an anonymous request, which is a crawler.
    expect(listed).not.toContain(`${ORIGIN}/posts/bai-viet-2`)
    expect(listed).not.toContain(`${ORIGIN}/posts/bai-viet-3`)
  })

  it('emits every URL absolute, on the configured origin, with no double slash', async () => {
    // The second post in another year, a series and a few photos: so every new kind of URL also goes through the loop
    // below, including the kind with a query (`/archive?year=2025`).
    stubPosts([[post(1), post(2, { publishedAt: '2025-06-01T00:00:00Z' })]])
    stubTaxonomy()
    stubSeries([series('series-a', '2026-01-01T00:00:00Z')])
    stubStats(2)

    const entries = await sitemap()

    // Guards against a vacuous loop: the body below proves nothing over an empty list.
    // Eighteen plus the case studies of the packaged defaults (CASE_STUDY_SLUGS) with these stubs — nine static paths, /gallery, the case studies, two published
    // posts, two categories, two tags, one series and one old archive year — plus the /en copy of all but the two posts and
    // the old archive year (the English site has no post of 2025, so it has no page for that year).
    expect(urls(entries)).toHaveLength(18 + CASE_STUDY_SLUGS.length)
    expect(entries).toHaveLength(33 + CASE_STUDY_SLUGS.length * 2)
    expect(urls(entries)).toContain(`${ORIGIN}/archive?year=2025`)
    for (const { url } of entries) {
      // `new URL(url)` with no base throws on a relative URL, which is the failure a
      // regex over the string could miss.
      expect(new URL(url).origin).toBe(ORIGIN)
      // The home page is the bare origin and every other URL is the origin plus a
      // rooted path; nothing may be relative, and nothing may carry `//` after the
      // origin.
      expect(url === ORIGIN || url.startsWith(`${ORIGIN}/`)).toBe(true)
      expect(url.slice(ORIGIN.length)).not.toContain('//')
    }
  })

  it('spells the home page exactly as its own canonical tag does', async () => {
    stubPosts([[post(1)]])
    stubTaxonomy()

    const listed = urls(await sitemap())

    // Measured on the running dev server: `/` emits
    // `<link rel="canonical" href="http://localhost:3000"/>` — Next resolves
    // app/layout.tsx's `alternates: { canonical: '/' }` against metadataBase and drops
    // the trailing slash. Listing `${ORIGIN}/` instead would advertise a URL whose page
    // declares a different canonical.
    expect(listed).toContain(ORIGIN)
    expect(listed).not.toContain(`${ORIGIN}/`)

    // Only at the root. `/writing/` and `/writing` are different URLs to a router, and
    // app/writing/page.tsx answers the second one.
    expect(listed.filter((url) => url !== ORIGIN).every((url) => !url.endsWith('/'))).toBe(true)
  })

  it('lists no URL twice, even when a post appears on two pages', async () => {
    // Not hypothetical: `fetchAllPosts` makes several requests, and a post published
    // between page 0 and page 1 shifts the ordering under the cursor, so the same
    // article really can come back on both pages.
    stubPosts([
      [post(1), post(2)],
      [post(2), post(3)],
    ])
    stubTaxonomy()

    const listed = urls(await sitemap())

    expect(listed).toHaveLength(new Set(listed).size)
    expect(listed.filter((url) => url === `${ORIGIN}/posts/bai-viet-2`)).toHaveLength(1)
    expect(listed).toContain(`${ORIGIN}/posts/bai-viet-3`)
  })

  it('carries no changeFrequency and no priority', async () => {
    stubPosts([[post(1)]])
    stubTaxonomy()

    // Both are advisory, both are ignored by Google, and any value for either would be
    // invented here rather than measured. Asserted so that "add priority" is a
    // deliberate change with a justification, not a drive-by.
    for (const entry of await sitemap()) {
      expect(entry).not.toHaveProperty('changeFrequency')
      expect(entry).not.toHaveProperty('priority')
      expect(entry).not.toHaveProperty('images')
    }
  })
})

describe('paging', () => {
  it('follows totalPages past the first page', async () => {
    // The whole point. 12 posts today against a default size of 20 means a single
    // request returns everything and keeps doing so until post 101 — at which point a
    // one-request sitemap silently stops listing new articles, with no error and no
    // failing test. Three posts over two pages reproduces that in one assertion.
    stubPosts([[post(1), post(2)], [post(3)]])
    stubTaxonomy()

    const listed = urls(await sitemap())

    expect(listed).toContain(`${ORIGIN}/posts/bai-viet-3`)
    expect(vi.mocked(getPosts).mock.calls.map(([args]) => args.page)).toEqual([0, 1])
  })

  it('asks for 100 per page, the most the backend will actually give', async () => {
    stubPosts([[post(1)]])
    stubTaxonomy()

    await sitemap()

    // Measured, not assumed: `?size=200` answers `"pagination":{"size":100}` — the
    // service clamps silently. Asking for more than the clamp would make page 0 look
    // like the whole list while totalPages quietly disagreed.
    for (const [args] of vi.mocked(getPosts).mock.calls) {
      expect(args.size).toBe(100)
      expect(args.size).toBeLessThanOrEqual(100)
    }
  })

  it('stops when a page comes back empty, even though totalPages claims more', async () => {
    // Measured: `?page=99` answers 200 with `data: []` and `totalPages: 3`. Without the
    // empty-page break, a totalPages that overstates the truth spins to the cap.
    stubPosts([[post(1)], []], { totalPages: 99 })
    stubTaxonomy()

    const listed = urls(await sitemap())

    expect(listed).toContain(`${ORIGIN}/posts/bai-viet-1`)
    expect(vi.mocked(getPosts).mock.calls.length).toBe(2)
  })

  it('keeps paging on a full page when totalPages is missing, and stops on a short one', async () => {
    // lib/api.ts substitutes a zeroed `meta` when the envelope carries no `pagination`
    // key, so `totalPages: 0` is a real shape this has to survive. The fallback rule is
    // "a page shorter than the page size was the last one".
    const full = Array.from({ length: 100 }, (_, i) => post(i + 1))
    stubPosts([full, [post(101)]], { totalPages: 0 })
    stubTaxonomy()

    const listed = urls(await sitemap())

    expect(vi.mocked(getPosts).mock.calls.length).toBe(2)
    expect(listed).toContain(`${ORIGIN}/posts/bai-viet-101`)
  })
})

describe('when the API is unreachable — the build must not fail', () => {
  const down = () => Promise.reject(new Error('fetch failed'))
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('still returns the static routes, logs once, and does not throw', async () => {
    // This is the path that will actually happen: `next build` in CI, or a `docker
    // build` that shares no network with the API. An unhandled rejection here fails the
    // entire production build over a service that is merely not running.
    vi.mocked(getPosts).mockImplementation(down)
    vi.mocked(getCategories).mockImplementation(down)
    vi.mocked(getTags).mockImplementation(down)
    vi.mocked(getSeriesList).mockImplementation(down)
    vi.mocked(getStats).mockImplementation(down)

    const listed = urls(await sitemap())

    // The case studies are still present when the API is down, and that is worth asserting: they are built from
    // TypeScript constants, not from the API, so a crashed backend must not make the sitemap
    // lose them.
    //
    // The four new pages (/start-here, /series, /topics, /archive) are routes that always exist, like
    // /writing, so they are here. /gallery is not: it only enters the sitemap when photos are known to exist,
    // and with no readable stats it is not known.
    expect(listed).toEqual([...STATIC_URLS, ...CASE_STUDY_URLS])

    // Once, not once per source and not once per page of a paged fetch.
    expect(warn).toHaveBeenCalledTimes(1)
    const message = String(warn.mock.calls[0][0])
    expect(message).toContain('posts')
    expect(message).toContain('categories')
    expect(message).toContain('tags')
    expect(message).toContain('series')
    expect(message).toContain('stats')
    // console.warn, not console.error: nothing is failing, and a CI log scanner
    // grepping for "error" should not be told otherwise.
  })

  it('omits lastModified rather than inventing one when the posts are gone', async () => {
    vi.mocked(getPosts).mockImplementation(down)
    vi.mocked(getCategories).mockImplementation(down)
    vi.mocked(getTags).mockImplementation(down)
    vi.mocked(getSeriesList).mockImplementation(down)
    vi.mocked(getStats).mockImplementation(down)

    // `new Date()` is the obvious thing to write here and it would claim every page
    // changed on every build, which trains a crawler to ignore the field entirely.
    for (const entry of await sitemap()) {
      expect(entry.lastModified).toBeUndefined()
    }
  })

  it('keeps the post URLs when only the taxonomy fetch fails', async () => {
    // Caught per source, in parallel: a category outage must not cost the article URLs,
    // which are the ones that matter. A single try/catch around all three would lose
    // everything to the first failure.
    stubPosts([[post(1)]])
    vi.mocked(getCategories).mockImplementation(down)
    vi.mocked(getTags).mockImplementation(down)

    const listed = urls(await sitemap())

    expect(listed).toContain(`${ORIGIN}/posts/bai-viet-1`)
    expect(listed.some((url) => url.includes('/categories/'))).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).not.toContain('posts (')
  })

  it('keeps the taxonomy URLs when only the post fetch fails', async () => {
    vi.mocked(getPosts).mockImplementation(down)
    stubTaxonomy()

    const listed = urls(await sitemap())

    expect(listed).toContain(`${ORIGIN}/categories/kien-truc`)
    expect(listed).toContain(`${ORIGIN}/tags/ci-cd`)
    expect(listed.some((url) => url.includes('/posts/'))).toBe(false)
  })

  it('does not log at all when every fetch succeeds', async () => {
    stubPosts([[post(1)]])
    stubTaxonomy()

    await sitemap()

    expect(warn).not.toHaveBeenCalled()
  })
})

describe('lastModified', () => {
  it("uses the post's own publishedAt", async () => {
    stubPosts([[post(1), post(2)]])
    stubTaxonomy()

    const entries = await sitemap()
    const article = entries.find((entry) => entry.url.endsWith('/posts/bai-viet-2'))

    // The exact string from the API, not a reformatted one: reformatting an instant
    // here could only introduce a timezone bug, and the format wants ISO-8601.
    expect(article?.lastModified).toBe('2026-01-02T00:00:00Z')
  })

  it('omits it for a post with no publishedAt', async () => {
    stubPosts([[post(1, { publishedAt: null })]])
    stubTaxonomy()

    const entries = await sitemap()
    const article = entries.find((entry) => entry.url.endsWith('/posts/bai-viet-1'))

    expect(article).toBeDefined()
    expect(article?.lastModified).toBeUndefined()
  })

  it('gives / and /writing the newest post date, not the first one it saw', async () => {
    // Deliberately out of order, and across two pages, so an implementation that takes
    // `posts[0].publishedAt` or the last value it iterated fails.
    stubPosts([[post(2), post(9)], [post(5)]])
    stubTaxonomy()

    const entries = await sitemap()
    const byUrl = new Map(entries.map((entry) => [entry.url, entry.lastModified]))

    expect(byUrl.get(ORIGIN)).toBe('2026-01-09T00:00:00Z')
    expect(byUrl.get(`${ORIGIN}/writing`)).toBe('2026-01-09T00:00:00Z')
  })

  it('gives each archive the newest date among its own posts', async () => {
    stubPosts([
      [
        post(1, { category: categories[0], tags: [tags[0]] }),
        post(7, { category: categories[1], tags: [tags[0], tags[1]] }),
        post(3, { category: categories[0], tags: [] }),
      ],
    ])
    stubTaxonomy()

    const byUrl = new Map((await sitemap()).map((entry) => [entry.url, entry.lastModified]))

    // kien-truc holds posts 1 and 3 -> 3 is newer. go-loi holds post 7 only.
    expect(byUrl.get(`${ORIGIN}/categories/kien-truc`)).toBe('2026-01-03T00:00:00Z')
    expect(byUrl.get(`${ORIGIN}/categories/go-loi`)).toBe('2026-01-07T00:00:00Z')
    // bai-hoc is on 1 and 7; ci-cd on 7 alone. A per-archive date that just echoed the
    // site-wide newest would make all four of these equal, so this is the assertion
    // that the filter is really per taxonomy.
    expect(byUrl.get(`${ORIGIN}/tags/bai-hoc`)).toBe('2026-01-07T00:00:00Z')
    expect(byUrl.get(`${ORIGIN}/tags/ci-cd`)).toBe('2026-01-07T00:00:00Z')
    expect(byUrl.get(`${ORIGIN}/categories/kien-truc`)).not.toBe(byUrl.get(ORIGIN))
  })

  it('lists an empty archive with no date rather than dropping it', async () => {
    // A category with no posts is a 200 page — the archives 404 only on a slug that is
    // not in the taxonomy list at all — so dropping it would hide a live URL.
    stubPosts([[post(1)]])
    stubTaxonomy()

    const entry = (await sitemap()).find((candidate) => candidate.url === `${ORIGIN}/categories/go-loi`)

    expect(entry).toBeDefined()
    expect(entry?.lastModified).toBeUndefined()
  })

  it('leaves the static content pages dateless', async () => {
    stubPosts([[post(1)]])
    stubTaxonomy()
    stubStats(4)

    const byUrl = new Map((await sitemap()).map((entry) => [entry.url, entry.lastModified]))

    // /about is rendered from content/profile.ts. The only honest date for it is a git
    // commit time this route cannot see, so there is no date.
    //
    // /start-here is an order the owner sets by hand: re-ordering it publishes nothing, so the
    // newest post's date says nothing about it. /gallery: the public API has no upload date.
    for (const path of ['/about', '/search', '/start-here', '/gallery']) {
      expect(byUrl.has(`${ORIGIN}${path}`), path).toBe(true)
      expect(byUrl.get(`${ORIGIN}${path}`), path).toBeUndefined()
    }
  })

  it('gives /archive and /topics the date of the newest post: both are a way to browse the post list', async () => {
    stubPosts([[post(3), post(8), post(5)]])
    stubTaxonomy()

    const byUrl = new Map((await sitemap()).map((entry) => [entry.url, entry.lastModified]))

    expect(byUrl.get(`${ORIGIN}/archive`)).toBe('2026-01-08T00:00:00Z')
    expect(byUrl.get(`${ORIGIN}/topics`)).toBe('2026-01-08T00:00:00Z')
  })

  it('ignores an unparseable date instead of emitting it', async () => {
    stubPosts([[post(1, { publishedAt: 'not a date' }), post(4)]])
    stubTaxonomy()

    const byUrl = new Map((await sitemap()).map((entry) => [entry.url, entry.lastModified]))

    expect(byUrl.get(ORIGIN)).toBe('2026-01-04T00:00:00Z')
  })
})

/**
 * `updatedAt` on listing items (V6 P1-8). An edit changes the page a crawler would fetch — the
 * body, the title, the tags — and publishedAt never moves after the first publish, so before
 * this every edited article advertised its original date forever.
 *
 * The backend adds the field in the same release, but the running dev backend does not have it
 * until it is restarted, and nothing validates the JSON at runtime: absent, unparseable and
 * non-string values all have to fall back to publishedAt rather than be emitted or crash.
 */
describe('lastModified from updatedAt', () => {
  it('prefers updatedAt when it is newer than publishedAt, as the exact API string', async () => {
    stubPosts([[post(1, { updatedAt: '2026-03-15T08:30:12.123456Z' }), post(2)]])
    stubTaxonomy()

    const byUrl = new Map((await sitemap()).map((entry) => [entry.url, entry.lastModified]))

    expect(byUrl.get(`${ORIGIN}/posts/bai-viet-1`)).toBe('2026-03-15T08:30:12.123456Z')
    // Post 2 carries no updatedAt: the backend before V6, or a summary that simply lacks it.
    expect(byUrl.get(`${ORIGIN}/posts/bai-viet-2`)).toBe('2026-01-02T00:00:00Z')
  })

  it('keeps publishedAt when updatedAt is older, unparseable or not a string', async () => {
    stubPosts([
      [
        // Older: seed data and imports can carry an updatedAt before the publish date.
        post(1, { publishedAt: '2026-02-01T00:00:00Z', updatedAt: '2026-01-20T00:00:00Z' }),
        post(2, { updatedAt: 'not a date' }),
        // Not validated at runtime, so a number can arrive where a string is declared — and
        // `Date.parse(2027)` is a valid date (the year), so only a type check keeps it out.
        post(3, { updatedAt: 2027 as unknown as string }),
        post(4, { updatedAt: '' }),
      ],
    ])
    stubTaxonomy()

    const byUrl = new Map((await sitemap()).map((entry) => [entry.url, entry.lastModified]))

    expect(byUrl.get(`${ORIGIN}/posts/bai-viet-1`)).toBe('2026-02-01T00:00:00Z')
    expect(byUrl.get(`${ORIGIN}/posts/bai-viet-2`)).toBe('2026-01-02T00:00:00Z')
    expect(byUrl.get(`${ORIGIN}/posts/bai-viet-3`)).toBe('2026-01-03T00:00:00Z')
    expect(byUrl.get(`${ORIGIN}/posts/bai-viet-4`)).toBe('2026-01-04T00:00:00Z')
  })

  it('uses updatedAt alone when publishedAt is missing, and nothing when both are', async () => {
    stubPosts([[post(1, { publishedAt: null, updatedAt: '2026-01-05T00:00:00Z' }), post(2, { publishedAt: null })]])
    stubTaxonomy()

    const entries = await sitemap()
    const article = (n: number) => entries.find((entry) => entry.url === `${ORIGIN}/posts/bai-viet-${n}`)

    expect(article(1)?.lastModified).toBe('2026-01-05T00:00:00Z')
    expect(article(2)).toBeDefined()
    expect(article(2)).not.toHaveProperty('lastModified')
  })

  it('dates each category and tag by the newest change among its own posts', async () => {
    stubPosts([
      [
        // kien-truc: post 1 published on the 1st but edited on the 20th; post 3 untouched on the 3rd.
        post(1, { category: categories[0], tags: [tags[0]], updatedAt: '2026-01-20T00:00:00Z' }),
        post(3, { category: categories[0], tags: [] }),
        // go-loi: post 7 only, edited on the 9th.
        post(7, { category: categories[1], tags: [tags[1]], updatedAt: '2026-01-09T00:00:00Z' }),
      ],
    ])
    stubTaxonomy()

    const byUrl = new Map((await sitemap()).map((entry) => [entry.url, entry.lastModified]))

    expect(byUrl.get(`${ORIGIN}/categories/kien-truc`)).toBe('2026-01-20T00:00:00Z')
    expect(byUrl.get(`${ORIGIN}/categories/go-loi`)).toBe('2026-01-09T00:00:00Z')
    expect(byUrl.get(`${ORIGIN}/tags/bai-hoc`)).toBe('2026-01-20T00:00:00Z')
    expect(byUrl.get(`${ORIGIN}/tags/ci-cd`)).toBe('2026-01-09T00:00:00Z')
  })

  it('dates /, /writing, /archive and /topics by the newest change across all posts', async () => {
    // Post 2 is the newest PUBLISHED; post 1 is older but the most recently EDITED. The listing
    // pages show titles and excerpts, so the edit is what changed them last.
    stubPosts([[post(1, { updatedAt: '2026-02-10T00:00:00Z' }), post(2, { updatedAt: '2026-01-02T00:00:00Z' })]])
    stubTaxonomy()

    const byUrl = new Map((await sitemap()).map((entry) => [entry.url, entry.lastModified]))

    for (const path of ['', '/writing', '/archive', '/topics']) {
      expect(byUrl.get(`${ORIGIN}${path}`), path || '/').toBe('2026-02-10T00:00:00Z')
    }
  })

  it('dates each archive year by the newest change among the posts published that year', async () => {
    stubPosts([
      [
        post(1, { publishedAt: '2026-02-01T00:00:00Z' }),
        // Published in 2025, edited in 2026: its year page lists it, so that page changed in 2026.
        post(2, { publishedAt: '2025-03-01T00:00:00Z', updatedAt: '2026-01-15T00:00:00Z' }),
        post(3, { publishedAt: '2024-05-02T00:00:00Z' }),
      ],
    ])
    stubTaxonomy()

    const byUrl = new Map((await sitemap()).map((entry) => [entry.url, entry.lastModified]))

    // The edit does not move the post into another year: the year is the publish year.
    expect(byUrl.get(`${ORIGIN}/archive?year=2025`)).toBe('2026-01-15T00:00:00Z')
    expect(byUrl.get(`${ORIGIN}/archive?year=2024`)).toBe('2024-05-02T00:00:00Z')
    expect(byUrl.has(`${ORIGIN}/archive?year=2026`)).toBe(false)
  })
})

describe('the base URL', () => {
  it('strips a trailing slash so no URL carries a double slash', async () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://blog.example.com/')
    stubPosts([[post(1)]])
    stubTaxonomy()

    const listed = urls(await sitemap())

    expect(listed).toContain('https://blog.example.com/posts/bai-viet-1')
    expect(listed.some((url) => url.includes('.com//'))).toBe(false)
  })

  it('treats an empty or whitespace NEXT_PUBLIC_SITE_URL as unset', async () => {
    stubPosts([[post(1)]])
    stubTaxonomy()

    // `NEXT_PUBLIC_SITE_URL=` with nothing after it is a real way to write a .env line.
    // With `??` instead of `||` that empty string is accepted as an origin and every
    // entry becomes a relative path — a sitemap of relative URLs, which is invalid.
    for (const value of ['', '   ']) {
      vi.stubEnv('NEXT_PUBLIC_SITE_URL', value)
      expect(urls(await sitemap())).toContain('http://localhost:3000/posts/bai-viet-1')
    }
  })

  it('falls back to the same localhost origin app/layout.tsx falls back to', async () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', undefined)
    stubPosts([[post(1)]])
    stubTaxonomy()

    expect(urls(await sitemap())).toContain('http://localhost:3000/posts/bai-viet-1')
  })

  it('reads the origin from lib/site.ts rather than computing its own', () => {
    // This was written as a textual comparison: it read app/layout.tsx's source, pulled
    // the env var name and the fallback literal out of both files with regexes, and
    // required them to match. That was the right guard for the situation at the time —
    // four files each computed the origin independently, and a sitemap full of localhost
    // links in production is the symptom when one drifts.
    //
    // The situation changed, and so did the guard. There is now ONE definition, in
    // lib/site.ts, because the fourth copy (the root layout) had used `??` instead of
    // `||` — so an empty `NEXT_PUBLIC_SITE_URL=` line produced `new URL('')`, thrown from
    // metadataBase, i.e. every page on the site returning 500. Three files had the rule
    // right and one did not, which is what four copies buys you.
    //
    // So the assertion is now structural rather than textual, and strictly stronger:
    // nothing in these files may touch process.env at all. A file that imports siteUrl()
    // cannot disagree with the others; a file that reads the env var might.
    const sources = ['app/sitemap.ts', 'app/robots.ts', 'lib/root-metadata.ts', 'components/site/ArticleJsonLd.tsx']

    // Comments are stripped first, and that is not a convenience. Every one of these
    // files legitimately NAMES the env var in prose — explaining why the empty-string
    // case matters, or recording what the code used to do — and a test that matched raw
    // text would fail on an accurate comment. The assertion is about code.
    const codeOf = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

    for (const file of sources) {
      const code = codeOf(readFileSync(resolve(process.cwd(), file), 'utf8'))
      expect(code, `${file} must not read process.env directly; import from lib/site.ts`).not.toMatch(
        /process\.env\.NEXT_PUBLIC_SITE_URL/,
      )
      // The sitemap gets its absolute URLs from lib/locale-path.ts, which builds them on lib/site.ts (asserted below).
      const origin = file === 'app/sitemap.ts' ? /from '@\/lib\/locale-path'/ : /from '@\/lib\/site'/
      expect(code, `${file} must import the origin from lib/site.ts`).toMatch(origin)
    }
    expect(codeOf(readFileSync(resolve(process.cwd(), 'lib/locale-path.ts'), 'utf8'))).toMatch(/from '@\/lib\/site'/)

    // And lib/site.ts is where the env var IS read — otherwise the loop above would pass
    // on a codebase that had simply stopped resolving an origin at all.
    const site = codeOf(readFileSync(resolve(process.cwd(), 'lib/site.ts'), 'utf8'))
    expect(site).toMatch(/process\.env\.NEXT_PUBLIC_SITE_URL/)
  })

  it('emits post URLs byte-identical to postUrl(), the canonical and copy-link string', async () => {
    // Three places build a post URL: `alternates.canonical` on the post page, the
    // clipboard string in CopyLink, and this sitemap. ArticleJsonLd.postUrl is the
    // first two. If they disagree the sitemap advertises a URL whose own page declares
    // a different canonical, and the article is dropped as a duplicate of itself.
    for (const value of [ORIGIN, `${ORIGIN}/`, '', undefined]) {
      vi.stubEnv('NEXT_PUBLIC_SITE_URL', value)
      stubPosts([[post(1)]])
      stubTaxonomy()

      const listed = urls(await sitemap())
      expect(listed).toContain(postUrl('bai-viet-1'))
    }
  })
})

describe('the real API client against a dead backend', () => {
  /**
   * Everything above stubs `getPosts`/`getCategories`/`getTags`, so it proves the
   * sitemap handles a REJECTED PROMISE — not that a connection refused by the operating
   * system actually arrives here as one. The gap matters: `fetch` resolves rather than
   * throws on 4xx/5xx, lib/api.ts converts those into `ApiError` itself, and a
   * transport failure is a different code path again. The build that will really happen
   * in CI is this one, so it is tested with the real modules.
   *
   * `vi.doUnmock` + `vi.resetModules` + a dynamic import is what gets past the
   * file-level `vi.mock` hoisting. `API_BASE_URL` has to be stubbed BEFORE the import
   * because lib/api.ts reads it at module scope.
   *
   * Port 1 rather than a hostname that does not resolve: ECONNREFUSED on loopback is
   * immediate and needs no DNS, so this costs milliseconds and cannot hang on a
   * resolver. If something ever is listening on port 1, this test fails loudly instead
   * of passing vacuously.
   */
  afterEach(() => {
    vi.doMock('@/lib/api', () => ({ getPosts: vi.fn() }))
    vi.doMock('@/lib/taxonomy', () => ({ getCategories: vi.fn(), getTags: vi.fn() }))
    vi.doMock('@/lib/series', () => ({ getSeriesList: vi.fn() }))
    vi.doMock('@/lib/stats', () => ({ getStats: vi.fn() }))
    vi.resetModules()
  })

  it('returns the static routes instead of throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubEnv('API_BASE_URL', 'http://127.0.0.1:1')
    vi.doUnmock('@/lib/api')
    vi.doUnmock('@/lib/taxonomy')
    // Both new sources go through lib/fetch-json.ts, a different fetch path from lib/api.ts: they too
    // must arrive here as a rejected promise, not as an error thrown straight out.
    vi.doUnmock('@/lib/series')
    vi.doUnmock('@/lib/stats')
    vi.resetModules()

    const realSitemap = (await import('./sitemap')).default
    const entries = await realSitemap()

    expect(urls(entries)).toEqual([...STATIC_URLS, ...CASE_STUDY_URLS])
    expect(warn).toHaveBeenCalledTimes(1)
    const message = String(warn.mock.calls[0][0])
    expect(message).toContain('fetch failed')
    expect(message).toContain('series (')
    expect(message).toContain('stats (')
  })
})

describe('no listed URL can 404', () => {
  it('has a route file for every static path it lists', async () => {
    stubPosts([[]])
    stubTaxonomy()
    // With photos, so /gallery is listed and therefore checked.
    stubStats(1)

    const frontend = process.cwd()
    const listed = urls(await sitemap())

    // `process.cwd()`, following the writing-page test: `import.meta.dirname` is undefined
    // before Node 20.11 and `fileURLToPath(import.meta.url)` throws under Vitest's module
    // runner.
    //
    // Resolved through the real route tree rather than a hardcoded path per page. The
    // hardcoded version said `app/writing/page.tsx`, and it broke the moment the public
    // pages moved into an `app/(site)/` route group — correctly, but for the wrong reason:
    // the assertion worth making is "this URL is served", and a file path is only a proxy
    // for it. A proxy that has to be hand-edited whenever the tree is reorganised would
    // also have passed if a page were moved somewhere that serves a DIFFERENT URL.
    const served = routeMap(join(frontend, 'app'))

    // The base directory is proved first: resolving to the repo root instead of frontend/
    // would make an empty map, and every check below would then fail for the wrong reason
    // — or, written the other way round, pass while checking nothing.
    expect(served.get('/'), `resolved ${frontend}, which does not look like frontend/`).toBeDefined()

    for (const path of [
      '/',
      '/writing',
      '/start-here',
      '/series',
      '/topics',
      '/archive',
      '/case-studies',
      '/about',
      '/search',
      '/gallery',
    ]) {
      expect(listed).toContain(path === '/' ? ORIGIN : `${ORIGIN}${path}`)
      expect(
        served.get(path),
        `${path} is in the sitemap, so some page file must serve it. Create one, or remove ` +
          `'${path}' from STATIC_PATHS in app/sitemap.ts — a sitemap that promises a 404 ` +
          'is worse than one that omits the page.',
      ).toBeDefined()
    }
  })

  it('has a dynamic route file for every templated path it lists', async () => {
    stubPosts([[post(1)]])
    stubTaxonomy()

    const served = routeMap(join(process.cwd(), 'app'))

    // The dynamic segments the entries above are built from. A sitemap listing
    // /tags/<slug> with nothing serving /tags/[slug] is sixteen promised 404s.
    for (const template of ['/posts/[slug]', '/case-studies/[slug]', '/categories/[slug]', '/tags/[slug]', '/series/[slug]']) {
      expect(served.get(template), `nothing serves ${template}`).toBeDefined()
    }

    // The other direction, for the route that was removed: nothing serves
    // /projects/[slug] any more, and the set assertions above are what keep the sitemap
    // from naming it. Asserting it here as well means a page file restored WITHOUT its
    // sitemap entry — or a sitemap entry restored without the page — fails loudly
    // instead of quietly disagreeing.
    expect(served.get('/projects/[slug]'), 'the portfolio route was removed').toBeUndefined()
    expect(served.get('/projects'), 'the portfolio route was removed').toBeUndefined()
  })

  it('every URL it emits has a serving route, including URLs with a query', async () => {
    // The two lists above are hand-made lists. This is the opposite direction, needing nobody to remember to update:
    // take EVERY URL the sitemap actually emits (of every kind, thanks to the stubs below) and demand a page
    // serving its path. `/archive?year=2025` is served by the page of /archive.
    stubPosts([[post(1, { category: categories[0], tags: [tags[0]] }), post(2, { publishedAt: '2025-03-01T00:00:00Z' })]])
    stubTaxonomy()
    stubSeries([series('series-a', '2026-01-01T00:00:00Z')])
    stubStats(2)

    const served = routeMap(join(process.cwd(), 'app'))
    const listed = urls(await sitemap())
    expect(listed).toContain(`${ORIGIN}/archive?year=2025`)

    for (const entry of listed) {
      const { pathname } = new URL(entry)
      const segments = pathname.split('/').filter(Boolean)
      const template = segments.length === 2 ? `/${segments[0]}/[slug]` : pathname
      expect(served.get(pathname) ?? served.get(template), `no page serves ${entry}`).toBeDefined()
    }
  })
})

describe('the new pages', () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('/gallery only when the stats say the gallery has photos', async () => {
    stubPosts([[post(1)]])
    stubTaxonomy()

    stubStats(0)
    expect(urls(await sitemap())).not.toContain(`${ORIGIN}/gallery`)

    stubStats(2)
    expect(urls(await sitemap())).toContain(`${ORIGIN}/gallery`)
  })

  it('stats unreadable: drops /gallery, keeps every other URL, logs one warning line', async () => {
    stubPosts([[post(1)]])
    stubTaxonomy()
    stubSeries([series('series-a', '2026-01-01T00:00:00Z')])
    vi.mocked(getStats).mockRejectedValue(new Error('fetch failed'))

    const listed = urls(await sitemap())

    // If it is not known, do not promise: an empty /gallery is a thin 200 page, and should not invite a crawler.
    expect(listed).not.toContain(`${ORIGIN}/gallery`)
    expect(listed).toContain(`${ORIGIN}/posts/bai-viet-1`)
    expect(listed).toContain(`${ORIGIN}/series/series-a`)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('stats (')
    expect(String(warn.mock.calls[0][0])).not.toContain('series (')
  })

  it('/series/{slug} carries lastModified = its latestPublishedAt; /series carries the newest date', async () => {
    stubPosts([[post(1)]])
    stubTaxonomy()
    // Deliberately not in date order: taking the first or the last element would both be wrong.
    stubSeries([
      series('series-b', '2026-01-04T00:00:00Z'),
      series('series-a', '2026-01-09T00:00:00Z'),
      series('ghi-chep-cu', '2026-01-02T00:00:00Z'),
    ])

    const byUrl = new Map((await sitemap()).map((entry) => [entry.url, entry.lastModified]))

    expect(byUrl.get(`${ORIGIN}/series/series-b`)).toBe('2026-01-04T00:00:00Z')
    expect(byUrl.get(`${ORIGIN}/series/series-a`)).toBe('2026-01-09T00:00:00Z')
    expect(byUrl.get(`${ORIGIN}/series/ghi-chep-cu`)).toBe('2026-01-02T00:00:00Z')
    expect(byUrl.get(`${ORIGIN}/series`)).toBe('2026-01-09T00:00:00Z')
  })

  it('a series slug is encoded like a post slug', async () => {
    stubPosts([[]])
    stubTaxonomy()
    stubSeries([series(msg('Admin.topics.manager.usageAll', { count: 'series' }), '2026-01-01T00:00:00Z')])

    expect(urls(await sitemap())).toContain(
      `${ORIGIN}/series/${encodeURIComponent(msg('Admin.topics.manager.usageAll', { count: 'series' }))}`,
    )
  })

  it('series unreadable: no /series/{slug}, /series is still there (no date), every other URL remains', async () => {
    stubPosts([[post(1)]])
    stubTaxonomy()
    vi.mocked(getSeriesList).mockRejectedValue(new Error('fetch failed'))

    const entries = await sitemap()
    const listed = urls(entries)

    expect(listed.some((entry) => entry.includes('/series/'))).toBe(false)
    expect(listed).toContain(`${ORIGIN}/series`)
    expect(entries.find((entry) => entry.url === `${ORIGIN}/series`)?.lastModified).toBeUndefined()
    expect(listed).toContain(`${ORIGIN}/posts/bai-viet-1`)
    expect(String(warn.mock.calls[0]?.[0])).toContain('series (')
  })

  it('/archive?year=Y for every year except the newest, each year carrying the date of its newest post', async () => {
    stubPosts([
      [
        post(1, { publishedAt: '2024-05-02T00:00:00Z' }),
        post(2, { publishedAt: '2026-02-01T00:00:00Z' }),
        post(3, { publishedAt: '2025-03-01T00:00:00Z' }),
        post(4, { publishedAt: '2025-11-20T00:00:00Z' }),
      ],
    ])
    stubTaxonomy()

    const entries = await sitemap()
    const byUrl = new Map(entries.map((entry) => [entry.url, entry.lastModified]))

    // The newest year IS /archive: its canonical carries no ?year (archive/page.tsx), so
    // listing `/archive?year=2026` promises a URL that declares itself a duplicate.
    expect(urls(entries).filter((entry) => entry.includes('/archive'))).toEqual([
      `${ORIGIN}/archive`,
      `${ORIGIN}/archive?year=2025`,
      `${ORIGIN}/archive?year=2024`,
    ])
    expect(byUrl.get(`${ORIGIN}/archive`)).toBe('2026-02-01T00:00:00Z')
    expect(byUrl.get(`${ORIGIN}/archive?year=2025`)).toBe('2025-11-20T00:00:00Z')
    expect(byUrl.get(`${ORIGIN}/archive?year=2024`)).toBe('2024-05-02T00:00:00Z')
  })

  it('only one year has posts: no ?year URL, /archive is still there', async () => {
    stubPosts([[post(1), post(2)]])
    stubTaxonomy()

    const listed = urls(await sitemap())

    expect(listed.filter((entry) => entry.includes('?year='))).toEqual([])
    expect(listed).toContain(`${ORIGIN}/archive`)
  })

  it('the year is computed in UTC like the archive page, not in server time', async () => {
    // 20:00 UTC on 31/12/2025 is 03:00 on 01/01/2026 in Asia/Ho_Chi_Minh — the timezone vitest
    // pins. The /archive page groups by UTC (lib/discovery.ts), so this post belongs to 2025; a
    // sitemap reading the year in machine time would have no `?year=2025` and promise the wrong set of years.
    stubPosts([[post(1, { publishedAt: '2025-12-31T20:00:00Z' }), post(2, { publishedAt: '2026-03-01T00:00:00Z' })]])
    stubTaxonomy()

    const byUrl = new Map((await sitemap()).map((entry) => [entry.url, entry.lastModified]))

    expect(byUrl.get(`${ORIGIN}/archive?year=2025`)).toBe('2025-12-31T20:00:00Z')
    expect(byUrl.has(`${ORIGIN}/archive?year=2026`)).toBe(false)
  })

  it('has no /random: a 307 route to a random post is not a page', async () => {
    stubPosts([[post(1)]])
    stubTaxonomy()

    const listed = urls(await sitemap())

    expect(listed.some((entry) => entry.includes('/random'))).toBe(false)
    // The "has" counterpart: the editorial entry point (/start-here) is there.
    expect(listed).toContain(`${ORIGIN}/start-here`)
  })
})

describe('author profile /u/<slug>', () => {
  const author = (profileSlug: string | null | undefined, siteOwner = false) => ({
    displayName: `Person ${profileSlug}`,
    githubLogin: null,
    avatarUrl: null,
    siteOwner,
    profileSlug,
  })

  it('each author who is not the site owner gets one URL, dated by the latest change among that person posts', async () => {
    stubPosts([
      [
        post(1, { author: author('tran-bich') }),
        post(3, { author: author('tran-bich'), updatedAt: '2026-02-10T00:00:00Z' }),
        post(2, { author: author('le-an') }),
      ],
    ])
    stubTaxonomy()

    const entries = await sitemap()
    const profiles = entries.filter((entry) => entry.url.includes('/u/') && !isEnglish(entry.url))

    expect(profiles.map(({ url, lastModified }) => ({ url, lastModified }))).toEqual([
      { url: `${ORIGIN}/u/tran-bich`, lastModified: '2026-02-10T00:00:00Z' },
      { url: `${ORIGIN}/u/le-an`, lastModified: '2026-01-02T00:00:00Z' },
    ])
    expect(routeMap(join(process.cwd(), 'app')).get('/u/[slug]'), 'nothing serves /u/[slug]').toBeDefined()
  })

  it('never the site owner, a post without an author (an old backend), a missing slug, null (suspended) or a wrong shape', async () => {
    stubPosts([
      [
        post(1, { author: author('chu-blog', true) }),
        post(2),
        post(3, { author: author(undefined) }),
        post(4, { author: author('Sai_Hinh') }),
        post(5, { author: author(null) }),
      ],
    ])
    stubTaxonomy()

    const listed = urls(await sitemap())

    expect(listed.filter((entry) => entry.includes('/u/'))).toEqual([])
    expect(listed.filter((entry) => entry === `${ORIGIN}/about`)).toHaveLength(1)
  })

  it('only from published posts: an author with only drafts gets no URL', async () => {
    stubPosts([[post(1, { status: 'DRAFT', author: author('chi-nhap') }), post(2, { author: author('da-dang') })]])
    stubTaxonomy()

    const listed = urls(await sitemap())

    expect(listed).toContain(`${ORIGIN}/u/da-dang`)
    expect(listed).not.toContain(`${ORIGIN}/u/chi-nhap`)
  })
})

/**
 * V6 P3-8: the DATA behind the sitemap is read on every request, not just the rendering.
 *
 * Every source the sitemap reads asks for `revalidate: 300` under a tag that only the admin's Server
 * Actions clear. A post published by seed/push.py or straight through the API therefore stayed out
 * of the sitemap for up to five minutes — and for longer in practice, because a crawler fetches this
 * URL rarely, and a rare fetch of a stale entry is answered with the stale copy while Next refreshes
 * it in the background.
 *
 * Run through Next's own fetch (test/next-data-cache.ts) with the real lib/ helpers, over a data
 * cache that still holds the list from before the write.
 */
describe('the backend, read on every request (V6 P3-8)', () => {
  afterEach(() => {
    vi.doMock('@/lib/api', () => ({ getPosts: vi.fn() }))
    vi.doMock('@/lib/taxonomy', () => ({ getCategories: vi.fn(), getTags: vi.fn() }))
    vi.doMock('@/lib/series', () => ({ getSeriesList: vi.fn() }))
    vi.doMock('@/lib/stats', () => ({ getStats: vi.fn() }))
    vi.resetModules()
  })

  /** app/sitemap.ts over the real lib/ modules, not the stubs the rest of this file uses. */
  async function realSitemapModule() {
    vi.doUnmock('@/lib/api')
    vi.doUnmock('@/lib/taxonomy')
    vi.doUnmock('@/lib/series')
    vi.doUnmock('@/lib/stats')
    vi.resetModules()
    return import('./sitemap')
  }

  /** The backend's answers when `posts` are what is published; every other source is empty. */
  function backendWith(posts: PostSummary[]) {
    return (path: string): unknown => {
      if (path.startsWith('/api/v1/posts?')) {
        return { data: posts, pagination: { page: 0, size: 100, totalElements: posts.length, totalPages: 1 } }
      }
      if (path === '/api/v1/stats') {
        return { data: { publishedPosts: posts.length, totalViews: 0, seriesCount: 0, galleryPhotos: 0 } }
      }
      return { data: [] }
    }
  }

  // Post 2 was published outside the admin after the data cache was filled.
  const live = backendWith([post(2), post(1)])
  const cached = backendWith([post(1)])

  it('declares fetchCache = force-no-store beside dynamic = force-dynamic', async () => {
    const mod = await realSitemapModule()

    expect(mod.dynamic).toBe('force-dynamic')
    expect(mod.fetchCache).toBe('force-no-store')
  })

  it('lists a post published outside the admin on the very next request, without touching the data cache', async () => {
    const mod = await realSitemapModule()

    const run = await runThroughDataCache({ dynamic: mod.dynamic, fetchCache: mod.fetchCache }, { live, cached }, () =>
      mod.default(),
    )

    expect(urls(run.result)).toContain(`${ORIGIN}/posts/bai-viet-2`)
    expect(run.cacheReads).toEqual([])
    expect(run.cacheWrites).toEqual([])
    // The price, stated: one backend request per source per sitemap fetch (and one more per extra
    // hundred posts).
    expect([...run.backend].sort()).toEqual([
      '/api/v1/categories?lang=en',
      '/api/v1/categories?lang=vi',
      '/api/v1/posts?page=0&size=100',
      '/api/v1/series?lang=en',
      '/api/v1/series?lang=vi',
      '/api/v1/stats',
      '/api/v1/tags?lang=en',
      '/api/v1/tags?lang=vi',
    ])
  })

  it('force-dynamic alone does not do it: the sources would still be answered from the data cache', async () => {
    // The sitemap as it was before V6 P3-8. The docs call `force-dynamic` equivalent to
    // `fetchCache = 'force-no-store'`; Next's fetch only lets it decide for a fetch that set no cache
    // option of its own, and every lib/ helper sets `revalidate: 300`. This is also the control for
    // the test above: the same harness and helpers DO serve the old copy when nothing overrides them.
    const mod = await realSitemapModule()

    const run = await runThroughDataCache({ dynamic: mod.dynamic }, { live, cached }, () => mod.default())

    expect(urls(run.result)).not.toContain(`${ORIGIN}/posts/bai-viet-2`)
    expect(urls(run.result)).toContain(`${ORIGIN}/posts/bai-viet-1`)
    expect(run.backend).toEqual([])
    expect(run.cacheReads).toHaveLength(8)
  })
})

describe('the English tree and hreflang alternates', () => {
  async function build() {
    stubPosts([[post(1)]])
    stubTaxonomy()
    stubSeries([series('series-a', '2026-01-01T00:00:00Z')])
    stubStats(1)
    return sitemap()
  }

  it('lists the /en counterpart of every chrome, list, taxonomy, series and case study URL', async () => {
    const entries = await build()
    const english = englishUrls(entries)

    expect(english).toEqual(
      urls(entries)
        .filter((url) => !url.includes('/posts/'))
        .map((url) => url.replace(ORIGIN, `${ORIGIN}/en`)),
    )
    expect(english).toContain(`${ORIGIN}/en`)
    expect(english).toContain(`${ORIGIN}/en/archive`)
    expect(english).toContain(`${ORIGIN}/en/categories/kien-truc`)
    expect(english).toContain(`${ORIGIN}/en/series/series-a`)
    for (const slug of CASE_STUDY_SLUGS) expect(english).toContain(`${ORIGIN}/en/case-studies/${slug}`)
  })

  it('both entries of a page list vi, en and x-default, and the English entry keeps the date', async () => {
    const entries = await build()
    const languages = { vi: `${ORIGIN}/writing`, en: `${ORIGIN}/en/writing`, 'x-default': `${ORIGIN}/writing` }

    const vi = entries.find((entry) => entry.url === `${ORIGIN}/writing`)
    const en = entries.find((entry) => entry.url === `${ORIGIN}/en/writing`)
    expect(vi?.alternates?.languages).toEqual(languages)
    expect(en?.alternates?.languages).toEqual(languages)
    expect(en?.lastModified).toBe(vi?.lastModified)
    // The home page keeps the bare origin in the default language and is /en in English.
    expect(entries.find((entry) => entry.url === `${ORIGIN}/en`)?.alternates?.languages).toEqual({
      vi: ORIGIN,
      en: `${ORIGIN}/en`,
      'x-default': ORIGIN,
    })
  })

  it('a post has only its default-locale URL and no alternates: its /en URL canonicalizes to the original', async () => {
    const entries = await build()

    const posts = entries.filter((entry) => entry.url.includes('/posts/'))
    expect(posts.map((entry) => entry.url)).toEqual([postUrl('bai-viet-1')])
    expect(posts[0]).not.toHaveProperty('alternates')
    expect(entries.some((entry) => entry.url.includes('/en/posts/'))).toBe(false)
  })
})

describe('posts in two languages and their translations', () => {
  const link = (language: string, slug: string) => ({ language, slug, title: slug, status: 'PUBLISHED' })
  const vi1 = post(1, { language: 'vi', slug: 'xin-chao', translations: [link('en', 'hello')] })
  const en1 = post(2, { language: 'en', slug: 'hello', translations: [link('vi', 'xin-chao')] })

  async function build(posts: PostSummary[]) {
    stubPosts([posts])
    stubTaxonomy()
    stubSeries([])
    stubStats(0)
    return sitemap()
  }

  const find = (entries: Entries, url: string) => entries.find((entry) => entry.url === url)

  it('lists each post once, at the URL of its own language, with symmetric alternates and x-default', async () => {
    const entries = await build([vi1, en1])

    const languages = { vi: `${ORIGIN}/posts/xin-chao`, en: `${ORIGIN}/en/posts/hello`, 'x-default': `${ORIGIN}/posts/xin-chao` }
    expect(find(entries, `${ORIGIN}/posts/xin-chao`)?.alternates?.languages).toEqual(languages)
    expect(find(entries, `${ORIGIN}/en/posts/hello`)?.alternates?.languages).toEqual(languages)
    expect(entries.filter((entry) => entry.url.includes('/posts/'))).toHaveLength(2)
    expect(find(entries, `${ORIGIN}/en/posts/xin-chao`)).toBeUndefined()
    expect(find(entries, `${ORIGIN}/posts/hello`)).toBeUndefined()
  })

  it('a post without a published translation has no alternates', async () => {
    const entries = await build([post(3, { language: 'en', slug: 'alone', translations: [] })])

    const entry = find(entries, `${ORIGIN}/en/posts/alone`)
    expect(entry).toBeDefined()
    expect(entry).not.toHaveProperty('alternates')
  })

  it('never emits an alternate for a sibling that is not in the list (a draft or unpublished translation is not returned by the API)', async () => {
    const entries = await build([{ ...vi1, translations: [link('en', 'hello')] }])

    const entry = find(entries, `${ORIGIN}/posts/xin-chao`)
    expect(entry).not.toHaveProperty('alternates')
    expect(entries.some((candidate) => candidate.url.includes('hello'))).toBe(false)
  })

  it('drops a one-sided link: both posts stay without alternates', async () => {
    const entries = await build([vi1, { ...en1, translations: [] }])

    expect(find(entries, `${ORIGIN}/posts/xin-chao`)).not.toHaveProperty('alternates')
    expect(find(entries, `${ORIGIN}/en/posts/hello`)).not.toHaveProperty('alternates')
  })

  it('a category is listed in the locales whose list contains it, and alternates only link those', async () => {
    stubPosts([[vi1, en1]])
    stubSeries([])
    stubStats(0)
    vi.mocked(getTags).mockResolvedValue([])
    vi.mocked(getCategories).mockImplementation(async (language) => (language === 'en' ? [] : categories))

    const entries = await sitemap()

    const entry = find(entries, `${ORIGIN}/categories/kien-truc`)
    expect(entry).toBeDefined()
    expect(entry).not.toHaveProperty('alternates')
    expect(find(entries, `${ORIGIN}/en/categories/kien-truc`)).toBeUndefined()
  })
})
