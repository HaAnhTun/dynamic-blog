import { defaultSiteContent } from '@/content/defaults'
import { TEST_LOCALE } from '@/test/intl'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { routeDir } from '@/test/routes'
import { render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getPosts } from '@/lib/api'
import { getDiscovery, type Discovery } from '@/lib/discovery'
import { fetchAllPublishedPosts } from '@/lib/published-posts'
import { absoluteUrl } from '@/lib/site'
import { getStats } from '@/lib/stats'
import { getCategories, getTags } from '@/lib/taxonomy'
import type { Category, PostSummary, SiteStats } from '@/lib/types'
import WritingIndex, { generateMetadata, revalidate } from './page'
import { msg } from '@/test/render-intl'
import { lastBrowseFrameCall, resetBrowseFrameCalls } from '@/test/browse-frame-mock'

const { site } = defaultSiteContent(TEST_LOCALE)

/**
 * `WritingIndex` is an async Server Component, so React Testing Library cannot render
 * it — `render(<WritingIndex />)` would hand RTL a promise. It is, however, an ordinary
 * exported async function, so it can be called directly and the element tree it returns
 * can be rendered. That is what these tests do.
 *
 * The alternative was to extract the `?page` parsing and the out-of-range rule into a
 * pure helper and unit-test that instead. Rejected for the same reason app/page.test.tsx
 * rejected it: the helper would be tested and the page would not, so nothing would catch
 * the page passing the wrong value to the helper, ignoring its answer, or losing the
 * `notFound()` call.
 *
 * `notFound()` is the real one from next/navigation, not a mock. Verified to work
 * outside a request context: it throws an Error whose `digest` is
 * 'NEXT_HTTP_ERROR_FALLBACK;404'. Mocking it would have meant asserting that a stub was
 * called, which cannot tell a real 404 from a page that carried on rendering.
 */
// The frame (sidebar + main column) is tested once in BrowseFrame.test.tsx; here it records what the page asked for.
vi.mock('@/components/site/BrowseFrame', () => import('@/test/browse-frame-mock'))
vi.mock('@/lib/api', () => ({ getPosts: vi.fn() }))
vi.mock('@/lib/taxonomy', () => ({ getCategories: vi.fn(), getTags: vi.fn() }))
vi.mock('@/lib/stats', () => ({ getStats: vi.fn() }))
vi.mock('@/lib/published-posts', () => ({ fetchAllPublishedPosts: vi.fn() }))
// The real parts stay (the threshold, DISCOVERY_LIMITS, the countCategories that the page and DiscoveryGrid
// use); only the loader is replaced, so each source can fail on its own.
vi.mock('@/lib/discovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/discovery')>()),
  getDiscovery: vi.fn(),
}))

const summary = (n: number): PostSummary => ({
  id: `p${n}`,
  title: `Post ${n}`,
  slug: `bai-viet-${n}`,
  excerpt: null,
  status: 'PUBLISHED',
  category: null,
  tags: [],
  publishedAt: null,
  featured: false,
  readingMinutes: 1,
})

const categories: Category[] = [
  { id: 'c1', name: 'Architecture', slug: 'kien-truc', description: null },
  {
    id: 'c2',
    name: 'How I work',
    slug: 'cach-toi-lam-viec',
    description: 'Process, verification.',
  },
]

/**
 * All published posts, the source for counting posts per category: two "How I work" posts, no
 * "Architecture" post (so that category is absent from the filter strip when counts are available).
 */
const published: PostSummary[] = [
  { ...summary(1), category: categories[1]!, tags: [{ id: 't1', name: 'Lessons', slug: 'bai-hoc' }] },
  { ...summary(2), category: categories[1]! },
  summary(3),
]

const stats = (over: Partial<SiteStats> = {}): SiteStats => ({
  publishedPosts: 20,
  totalViews: 0,
  seriesCount: 0,
  galleryPhotos: 0,
  ...over,
})

const NO_DISCOVERY: Discovery = {
  popular: null,
  recent: null,
  series: null,
  seriesTotal: 0,
  tags: null,
  tagTotal: 0,
  months: null,
  blogroll: [],
}

/** The "Discover" block has two child blocks, as getDiscovery returns when the API is healthy. */
const someDiscovery: Discovery = {
  ...NO_DISCOVERY,
  popular: { kind: 'recommended', posts: [summary(7)] },
  tags: [{ tag: { id: 't1', name: 'Lessons', slug: 'bai-hoc' }, count: 1 }],
  tagTotal: 1,
}

/**
 * Echoes the requested page back in `meta.page`, because that is what the backend does
 * — `PageRequest.of(Math.max(page, 0), …)` — and it is precisely why an out-of-range
 * page needs deciding in the page component. A mock that clamped `meta.page` itself
 * would hide the bug this rule exists to prevent.
 *
 * The secondary sources (stats, Discovery, all posts for counting categories) are healthy and neutral by default:
 * no series, no views, no Discovery block. A test that needs otherwise sets it again.
 */
function respond({ totalPages, items }: { totalPages: number; items: PostSummary[] }) {
  vi.mocked(getPosts).mockImplementation(async ({ page, size }) => ({
    items,
    meta: { page, size, totalElements: totalPages * size, totalPages },
  }))
  vi.mocked(getCategories).mockResolvedValue(categories)
  vi.mocked(getStats).mockResolvedValue(stats())
  vi.mocked(getDiscovery).mockResolvedValue(NO_DISCOVERY)
  vi.mocked(fetchAllPublishedPosts).mockResolvedValue(published)
}

function props(searchParams: Record<string, string | string[] | undefined> = {}): PageProps<'/[locale]/writing'> {
  return { params: Promise.resolve({ locale: 'vi' }), searchParams: Promise.resolve(searchParams) }
}

async function expectNotFound(pageProps: PageProps<'/[locale]/writing'>) {
  const thrown = await WritingIndex(pageProps).then(
    () => null,
    (error: unknown) => error,
  )
  expect(thrown, 'WritingIndex returned a page instead of calling notFound()').not.toBeNull()
  expect((thrown as { digest?: string }).digest).toBe('NEXT_HTTP_ERROR_FALLBACK;404')
}

/** The JSON-LD blocks on the page, parsed, in document order. */
function jsonLd(container: HTMLElement): Record<string, unknown>[] {
  return Array.from(container.querySelectorAll('script[type="application/ld+json"]')).map(
    (script) => JSON.parse(script.textContent ?? '') as Record<string, unknown>,
  )
}

type ListItem = { '@type': string; position: number; name: string; url: string }

/** The ItemList entries of the CollectionPage block. */
function itemList(block: Record<string, unknown>): ListItem[] {
  const list = block.mainEntity as { '@type': string; itemListElement: ListItem[] }
  expect(list['@type']).toBe('ItemList')
  return list.itemListElement
}

/** Names and hrefs of the visible post rows, in order: the h2 title link of each ListRow. */
function visibleRows(container: HTMLElement): [string | null, string | null][] {
  return [...container.querySelectorAll('li > article h2 a')].map((a) => [a.textContent, a.getAttribute('href')])
}

afterEach(() => {
  resetBrowseFrameCalls()
  vi.mocked(getPosts).mockReset()
  vi.mocked(getCategories).mockReset()
  vi.mocked(getTags).mockReset()
  vi.mocked(getStats).mockReset()
  vi.mocked(getDiscovery).mockReset()
  vi.mocked(fetchAllPublishedPosts).mockReset()
  vi.unstubAllEnvs()
})

describe('/writing', () => {
  it('passes the page language to every list and offers the other language when this one is empty', async () => {
    respond({ totalPages: 0, items: [] })
    vi.mocked(getPosts).mockImplementation(async ({ page, size, language }) => {
      const total = language === 'en' ? 3 : 0
      return { items: [], meta: { page, size, totalElements: total, totalPages: total > 0 ? 1 : 0 } }
    })

    render(await WritingIndex(props()))

    expect(getCategories).toHaveBeenCalledWith('vi')
    expect(fetchAllPublishedPosts).toHaveBeenCalledWith('vi')
    expect(screen.getByText(msg('Site.languageFallback.message'))).toBeInTheDocument()
    expect(screen.getByRole('link', { name: msg('Site.languageFallback.link', { language: 'English' }) })).toHaveAttribute(
      'href',
      '/en/writing',
    )
    expect(screen.queryByText(msg('Site.listing.empty'))).not.toBeInTheDocument()
  })

  it('asks the API for the first page and renders a row per post', async () => {
    respond({ totalPages: 3, items: [summary(1), summary(2)] })

    const { container } = render(await WritingIndex(props()))

    // Pins both PAGE_SIZE and the default page. A missing `?page` must mean 0, not 1
    // and not NaN. The exact object pins the absence of a stray `featured` or `category`
    // argument too — /writing is the UNfiltered list.
    expect(getPosts).toHaveBeenCalledWith({ page: 0, size: 10, language: 'vi' })
    expect(container.querySelectorAll('li > article')).toHaveLength(2)
    expect(screen.getByRole('link', { name: 'Post 1' })).toHaveAttribute('href', '/posts/bai-viet-1')
    expect(screen.getByRole('navigation', { name: msg('Site.pagination.label') })).toBeInTheDocument()
    // Makes the empty-state test below discriminating: this proves the paragraph is
    // absent when there are posts, so its presence there is a real branch.
    expect(screen.queryByText(msg('Site.home.empty'))).not.toBeInTheDocument()
  })

  it('has exactly one h1, and does not render its own <main>', async () => {
    respond({ totalPages: 1, items: [summary(1)] })

    const { container } = render(await WritingIndex(props()))

    expect(container.querySelectorAll('h1')).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(msg('Site.footer.links.writing'))
    // app/layout.tsx owns the document's single `<main id="main-content">`. Two main
    // landmarks is invalid HTML and makes "skip to main content" ambiguous — the
    // Foundations agent measured exactly that on `/` and /posts/[slug].
    expect(container.querySelector('main')).toBeNull()
  })

  it('offers the categories as a filter strip, linked by slug, each with its post count', async () => {
    respond({ totalPages: 1, items: [summary(1)] })

    render(await WritingIndex(props()))

    expect(getCategories).toHaveBeenCalledTimes(1)
    const strip = screen.getByRole('navigation', { name: msg('Site.writing.categories') })

    // "Testing 7": the number is for the eyes, the " posts" sr-only is for the ears, so the link name carries both.
    // Pinned again on purpose: previously the link name was only the category name.
    expect(
      within(strip).getByRole('link', { name: `How I work 2 ${msg('Site.discovery.postsUnit', { count: 2 })}` }),
    ).toHaveAttribute('href', '/categories/cach-toi-lam-viec')
    // "Architecture" has no posts yet: a link to an empty category page does not deserve a place on
    // the filter strip. Pair of the "yes" assertion above, so this is not an empty strip for some other reason.
    expect(within(strip).queryByRole('link', { name: /Architecture/ })).not.toBeInTheDocument()
  })

  it('Category strip: the rule sits directly in the main column (no Container), links widen the touch target', async () => {
    respond({ totalPages: 1, items: [summary(1)] })

    render(await WritingIndex(props()))

    const strip = screen.getByRole('navigation', { name: msg('Site.writing.categories') })
    // The border-y element is the strip itself; its parent is a plain section inside the frame, not a Container with a gutter, so
    // the rules are as long as the post rows right below.
    const rule = strip.closest('.border-y')!
    expect(rule).not.toBeNull()
    expect(rule).not.toHaveClass('px-4')
    const section = rule.parentElement!
    expect(section.tagName).toBe('SECTION')
    expect(section).not.toHaveClass('px-4', 'sm:px-6', 'mx-auto')
    expect(section.parentElement).toBe(screen.getByTestId('browse-frame'))
    for (const link of within(strip).getAllByRole('link')) {
      expect(link).toHaveClass('relative', 'after:absolute', 'after:-inset-x-1.5', 'after:-inset-y-2.5')
    }
  })

  it('no longer has a tag strip: tags moved to "Discover" and /topics, and are not fetched here', async () => {
    respond({ totalPages: 1, items: [summary(1)] })
    vi.mocked(getDiscovery).mockResolvedValue(someDiscovery)

    render(await WritingIndex(props()))

    // The tag strip left the top of the page so that the first post comes up onto a phone screen. Pinned again
    // on purpose from the test "categories and tags as a filter strip".
    expect(screen.queryByRole('navigation', { name: msg('Site.article.tagsLabel') })).not.toBeInTheDocument()
    expect(getTags).not.toHaveBeenCalled()

    // ...and still reachable: tags are in "Discover", links by slug, and "Topics" is in the sidebar.
    // Name on the label, slug in the href. An href built from `tag.name` would be
    // /tags/B%C3%A0i%20h%E1%BB%8Dc and match nothing — the backend filters on
    // `tags.slug`, and that was a real shipped bug for the whole of Sprint 3a.
    const discovery = screen.getByRole('region', { name: msg('Site.writing.discoverTitle') })
    expect(
      within(discovery).getByRole('link', { name: `Lessons 1 ${msg('Site.discovery.postsUnit', { count: 1 })}` }),
    ).toHaveAttribute('href', '/tags/bai-hoc')
    // (the "Topics" row of the sidebar is asserted in SiteSidebar.test.tsx; the page no longer renders its own section nav)
  })

  it('shows every category without a count when the posts cannot be counted', async () => {
    respond({ totalPages: 1, items: [summary(1)] })
    vi.mocked(fetchAllPublishedPosts).mockRejectedValue(new Error('posts unreachable'))

    render(await WritingIndex(props()))

    // The counts are secondary: if they cannot be counted the filter strip is still there as before, only missing the numbers,
    // and no category is hidden, because it is not known which category is empty.
    const strip = screen.getByRole('navigation', { name: msg('Site.writing.categories') })
    expect(
      within(strip)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Architecture', 'How I work'])
  })

  it('renders no filter strip when the blog has no categories', async () => {
    respond({ totalPages: 0, items: [] })
    vi.mocked(getCategories).mockResolvedValue([])

    render(await WritingIndex(props()))

    // An empty <nav aria-labelledby> with an empty <ul> under a visible heading is a
    // landmark that leads nowhere; on a brand-new blog there should be no strip at all.
    expect(screen.queryByRole('navigation', { name: msg('Site.writing.categories') })).not.toBeInTheDocument()
  })

  it('lets a taxonomy failure be a 500, not a silently stripped page', async () => {
    respond({ totalPages: 1, items: [summary(1)] })
    const boom = new Error('categories unreachable')
    vi.mocked(getCategories).mockRejectedValue(boom)

    // The tempting shape is `getCategories().catch(() => [])`, which renders a page
    // that looks fine and has quietly lost its navigation. Worse, the same `.catch`
    // on the archive pages turns a blip into a cached 404 for every archive URL.
    await expect(WritingIndex(props())).rejects.toBe(boom)
  })

  describe('stats line', () => {
    it('"N posts · M series", no views when the total is under 100', async () => {
      respond({ totalPages: 2, items: [summary(1)] })
      vi.mocked(getStats).mockResolvedValue(stats({ seriesCount: 2, totalViews: 99 }))
      vi.mocked(getDiscovery).mockResolvedValue({ ...NO_DISCOVERY, seriesTotal: 2 })

      render(await WritingIndex(props()))

      // The post count is meta.totalElements of the list itself (2 pages x 10), the same source as the pagination
      // below, not the /stats publishedPosts, so that the two numbers do not drift apart.
      expect(screen.getByText(msg('Site.writing.statsLine', { parts: 'postsSeries', posts: 20, series: 2 }))).toBeInTheDocument()
      expect(screen.queryByText(new RegExp(msg('Site.discovery.viewsUnit', { count: 2 })))).not.toBeInTheDocument()
    })

    it('adds "· N views" from 100, in vi-VN format', async () => {
      respond({ totalPages: 2, items: [summary(1)] })
      vi.mocked(getStats).mockResolvedValue(stats({ seriesCount: 2, totalViews: 100 }))
      vi.mocked(getDiscovery).mockResolvedValue({ ...NO_DISCOVERY, seriesTotal: 2 })
      const { unmount } = render(await WritingIndex(props()))

      expect(
        screen.getByText(msg('Site.writing.statsLine', { parts: 'postsSeriesViews', posts: 20, series: 2, views: 100 })),
      ).toBeInTheDocument()
      unmount()

      vi.mocked(getStats).mockResolvedValue(stats({ seriesCount: 2, totalViews: 52_817 }))
      render(await WritingIndex(props()))
      expect(
        screen.getByText(msg('Site.writing.statsLine', { parts: 'postsSeriesViews', posts: 20, series: 2, views: 52_817 })),
      ).toBeInTheDocument()
    })

    it('counts the series of the page language, not the site-wide figure of /stats', async () => {
      respond({ totalPages: 2, items: [summary(1)] })
      vi.mocked(getStats).mockResolvedValue(stats({ seriesCount: 5, totalViews: 10 }))
      vi.mocked(getDiscovery).mockResolvedValue({ ...NO_DISCOVERY, seriesTotal: 1 })

      render(await WritingIndex(props()))

      expect(screen.getByText(msg('Site.writing.statsLine', { parts: 'postsSeries', posts: 20, series: 1 }))).toBeInTheDocument()
    })

    it('with no series there is no "0 series"', async () => {
      respond({ totalPages: 2, items: [summary(1)] })
      vi.mocked(getStats).mockResolvedValue(stats({ seriesCount: 0, totalViews: 250 }))

      render(await WritingIndex(props()))

      expect(screen.getByText(msg('Site.writing.statsLine', { parts: 'postsViews', posts: 20, views: 250 }))).toBeInTheDocument()
    })

    it('when getStats fails the page still renders, the stats line only keeps the post count', async () => {
      respond({ totalPages: 2, items: [summary(1)] })
      vi.mocked(getStats).mockRejectedValue(new Error('stats unreachable'))

      render(await WritingIndex(props()))

      expect(screen.getByText(msg('Site.writing.statsLine', { parts: 'posts', posts: 20 }))).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'Post 1' })).toBeInTheDocument()
    })

    it('has a "Read a random post" link, an <a rel="nofollow"> to /random', async () => {
      respond({ totalPages: 1, items: [summary(1)] })

      const { container } = render(await WritingIndex(props()))

      const header = container.querySelector('header') as HTMLElement
      const random = within(header).getByRole('link', { name: msg('Site.footer.links.random') })
      expect(random).toHaveAttribute('href', '/random')
      expect(random).toHaveAttribute('rel', 'nofollow')
    })
  })

  it('renders inside the frame with "Latest" as the current Explore row, and no section nav row of its own', async () => {
    respond({ totalPages: 1, items: [summary(1)] })

    render(await WritingIndex(props()))

    expect(lastBrowseFrameCall()?.current).toEqual({ key: 'latest', exact: true })
    expect(screen.getByTestId('browse-frame')).toContainElement(screen.getByRole('heading', { level: 1 }))
    expect(screen.queryByRole('navigation', { name: msg('Site.listing.sectionNav.label') })).not.toBeInTheDocument()
  })

  describe('"Discover" block', () => {
    it('asks getDiscovery for the /writing context and renders the block at the end of the page', async () => {
      respond({ totalPages: 1, items: [summary(1)] })
      vi.mocked(getDiscovery).mockResolvedValue(someDiscovery)

      const { container } = render(await WritingIndex(props()))

      expect(getDiscovery).toHaveBeenCalledWith({ context: 'writing', language: 'vi' })
      const region = screen.getByRole('region', { name: msg('Site.writing.discoverTitle') })
      expect(within(region).getByRole('heading', { level: 2, name: msg('Site.writing.discoverTitle') })).toHaveAttribute(
        'id',
        'kham-pha',
      )
      // After the grid, outside the frame, at frame width, with a top border and hidden in print.
      const band = container.lastElementChild as HTMLElement
      expect(band).toContainElement(region)
      expect(band).toHaveClass('border-t', 'print:hidden')
      expect(screen.getByTestId('browse-frame')).not.toContainElement(region)
      expect(region.className).toContain('max-w-[87.5rem]')
    })

    it('when getDiscovery fails the page still renders, only without the "Discover" block', async () => {
      respond({ totalPages: 1, items: [summary(1)] })
      vi.mocked(getDiscovery).mockRejectedValue(new Error('discovery exploded'))

      render(await WritingIndex(props()))

      expect(screen.queryByRole('region', { name: msg('Site.writing.discoverTitle') })).not.toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'Post 1' })).toBeInTheDocument()
      expect(screen.getByRole('navigation', { name: msg('Site.writing.categories') })).toBeInTheDocument()
    })

    it('when every block is empty there is no "Discover" section', async () => {
      respond({ totalPages: 1, items: [summary(1)] })

      render(await WritingIndex(props()))

      expect(screen.queryByRole('region', { name: msg('Site.writing.discoverTitle') })).not.toBeInTheDocument()
    })
  })

  it('sends the page the reader asked for and reflects it in the pager', async () => {
    respond({ totalPages: 5, items: [summary(1)] })

    render(await WritingIndex(props({ page: '3' })))

    expect(getPosts).toHaveBeenCalledWith({ page: 3, size: 10, language: 'vi' })
    expect(screen.getByText('Trang 4 / 5')).toBeInTheDocument()

    // The pager's links, not just its label. `basePath` could become "/" — every pager
    // link landing on the portfolio homepage — with the rest of the suite still green,
    // and that is exactly the move this task performs.
    expect(screen.getByRole('link', { name: msg('Site.pagination.previous') })).toHaveAttribute('href', '/writing?page=2')
    expect(screen.getByRole('link', { name: /sau/i })).toHaveAttribute('href', '/writing?page=4')
  })

  it('404s a page index too large to be a real request, without asking the API', async () => {
    // The backend binds page to a 32-bit int: 2147483647 is a 500 and 2147483648 a 400,
    // so these were reader-typable URLs answered with a server error. The 22-digit
    // string is also where Number.parseInt returns a float — it became page=1e+22 on
    // the wire, scientific notation as an integer parameter.
    for (const page of ['10001', '2147483647', '2147483648', '9999999999999999999999']) {
      respond({ totalPages: 3, items: [summary(1)] })
      vi.mocked(getPosts).mockClear()
      vi.mocked(getCategories).mockClear()
      vi.mocked(getStats).mockClear()
      vi.mocked(getDiscovery).mockClear()
      vi.mocked(fetchAllPublishedPosts).mockClear()

      await expect(WritingIndex(props({ page })), `?page=${page}`).rejects.toMatchObject({
        digest: 'NEXT_HTTP_ERROR_FALLBACK;404',
      })
      expect(getPosts, `?page=${page} must not reach the API`).not.toHaveBeenCalled()
      expect(getCategories, `?page=${page} must not reach the API`).not.toHaveBeenCalled()
      // The secondary sources too: a page that does not exist has nothing to count or suggest.
      expect(getStats, `?page=${page} must not reach the API`).not.toHaveBeenCalled()
      expect(getDiscovery, `?page=${page} must not reach the API`).not.toHaveBeenCalled()
      expect(fetchAllPublishedPosts, `?page=${page} must not reach the API`).not.toHaveBeenCalled()
    }
  })

  it('falls back to the first page for a ?page the API should never be sent', async () => {
    // NaN, a negative index and an empty value all have to become 0 here. The backend
    // clamps too, but a frontend that posts garbage and relies on the server to launder
    // it breaks the moment anything else reads the same URL. '1.5', '0x2', '2abc' and
    // '+2' are the ones worth naming: Number.parseInt reads them as 1, 2, 2 and 2, so
    // without the shape check they silently became requests for a page the reader never
    // asked for.
    for (const page of ['abc', '-1', '-99', '', 'Infinity', '1.5', '0x2', '2abc', '+2', ' ']) {
      respond({ totalPages: 3, items: [summary(1)] })

      render(await WritingIndex(props({ page })))

      expect(getPosts, `?page=${page}`).toHaveBeenCalledWith({ page: 0, size: 10, language: 'vi' })
      vi.mocked(getPosts).mockReset()
    }
  })

  it('takes the first value when ?page is repeated', async () => {
    respond({ totalPages: 9, items: [summary(1)] })

    render(await WritingIndex(props({ page: ['2', '5'] })))

    // Honest note on what this does and does not pin. It kills "read the wrong
    // element": `page.at(-1)` sends 5 and fails here. It does NOT kill rewriting the
    // branch as `Number.parseInt(String(page ?? ''), 10)`, because String(['2','5']) is
    // '2,5' and parseInt stops at the comma — that mutant returns 2 too, and no test
    // can tell the two apart. The naive branchless form is the one tsc catches:
    // `Number.parseInt(page ?? '', 10)` is TS2345, because `page` is
    // `string | string[] | undefined`.
    expect(getPosts).toHaveBeenCalledWith({ page: 2, size: 10, language: 'vi' })
  })

  it('renders the last page that does exist', async () => {
    respond({ totalPages: 3, items: [summary(1)] })

    render(await WritingIndex(props({ page: '2' })))

    expect(screen.getByText('Trang 3 / 3')).toBeInTheDocument()
  })

  it('404s for a page past the last one instead of showing an empty list', async () => {
    // The backend echoes the requested page back, so ?page=99 against three pages
    // returns an empty list with meta.page = 99. Pagination clamps its own display,
    // which means without this rule the reader gets a blank page under a pager claiming
    // to be on the last one. '3' is the boundary — pages 0, 1 and 2 exist.
    for (const page of ['3', '99']) {
      respond({ totalPages: 3, items: [] })

      await expectNotFound(props({ page }))

      vi.mocked(getPosts).mockReset()
    }
  })

  it('renders the empty state on a brand-new blog rather than 404ing', async () => {
    // totalPages is 0 here, so a rule written as `current >= meta.totalPages` alone
    // would 404 the writing index of every blog that has not published anything yet.
    respond({ totalPages: 0, items: [] })

    const { container } = render(await WritingIndex(props()))

    expect(screen.getByText(msg('Site.home.empty'))).toBeInTheDocument()
    expect(container.querySelector('article')).toBeNull()
    expect(screen.queryByRole('navigation', { name: msg('Site.pagination.label') })).not.toBeInTheDocument()
  })

  it('404s for a page other than the first on a brand-new blog', async () => {
    // Page 0 always exists. Page 1 of an empty blog does not, and this is what
    // distinguishes the `current > 0` guard from a `meta.totalPages > 0` one, which
    // would answer ?page=1 with the empty state.
    respond({ totalPages: 0, items: [] })

    await expectNotFound(props({ page: '1' }))
  })

  it('declares the revalidate window the route is supposed to have', async () => {
    expect(revalidate).toBe(300)
  })

  describe('structured data (JSON-LD)', () => {
    it('CollectionPage carries the exact title, description and canonical that the page metadata declares', async () => {
      vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://blog.example.com')
      respond({ totalPages: 3, items: [summary(1), summary(2)] })

      const { container } = render(await WritingIndex(props()))
      const m = await generateMetadata(props())
      const [page] = jsonLd(container)

      expect(page).toMatchObject({
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: msg('Site.footer.links.writing'),
        description: msg('Site.pageDescriptions.writing'),
        url: 'https://blog.example.com/writing',
        inLanguage: 'vi',
      })
      // Same strings as og:title, meta description and canonical: one construction, not two
      // expressions that happen to match. The canonical is relative, metadataBase makes it absolute;
      // JSON-LD has no metadataBase so it goes through absoluteUrl of lib/site.ts.
      expect(page!.name).toBe(m.openGraph?.title)
      expect(page!.description).toBe(m.description)
      expect(page!.url).toBe(absoluteUrl(m.alternates?.canonical as string))
      // The description is the very lead the reader sees under the h1, not a sentence meant only for machines.
      expect(screen.getByText(page!.description as string)).toBeInTheDocument()
    })

    it('under /en the CollectionPage is at the /en URL and says en', async () => {
      vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://blog.example.com')
      respond({ totalPages: 3, items: [summary(1)] })

      const { container } = render(await WritingIndex({ ...props(), params: Promise.resolve({ locale: 'en' }) }))
      const [page] = jsonLd(container)

      expect(page).toMatchObject({ url: 'https://blog.example.com/en/writing', inLanguage: 'en' })
    })

    it('ItemList is exactly the posts this page shows, in the order shown; posts in the "Discover" block are not', async () => {
      vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://blog.example.com')
      // Not by ordinal number: the list keeps the backend order, it does not re-sort itself.
      respond({ totalPages: 3, items: [summary(2), summary(1)] })
      vi.mocked(getDiscovery).mockResolvedValue(someDiscovery)

      const { container } = render(await WritingIndex(props()))
      const list = itemList(jsonLd(container)[0]!)

      expect(list).toEqual([
        { '@type': 'ListItem', position: 1, name: 'Post 2', url: 'https://blog.example.com/posts/bai-viet-2' },
        { '@type': 'ListItem', position: 2, name: 'Post 1', url: 'https://blog.example.com/posts/bai-viet-1' },
      ])
      // Matches the visible rows: same name, same path, same order.
      expect(list.map((item) => [item.name, new URL(item.url).pathname])).toEqual(visibleRows(container))
      // "Post 7" is on the page, in "Discover", a way onward, not something this page lists.
      expect(screen.getByRole('region', { name: msg('Site.writing.discoverTitle') })).toHaveTextContent('Post 7')
      expect(list.map((item) => item.name)).not.toContain('Post 7')
    })

    it('?page=n: url is the canonical keeping the page number, position continues after the previous pages', async () => {
      vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://blog.example.com')
      respond({ totalPages: 5, items: [summary(31), summary(32)] })

      const { container } = render(await WritingIndex(props({ page: '3' })))
      const m = await generateMetadata(props({ page: '3' }))
      const [page] = jsonLd(container)

      expect(page!.url).toBe('https://blog.example.com/writing?page=3')
      expect(page!.url).toBe(absoluteUrl(m.alternates?.canonical as string))
      // ?page counts from 0, position counts from 1: page 3 with 10 posts per page starts with the 31st post.
      expect(itemList(page!).map((item) => [item.position, item.name])).toEqual([
        [31, 'Post 31'],
        [32, 'Post 32'],
      ])
    })

    it('no BreadcrumbList: the page has no visible breadcrumb for it to describe', async () => {
      respond({ totalPages: 1, items: [summary(1)] })

      const { container } = render(await WritingIndex(props()))

      expect(screen.queryByRole('navigation', { name: msg('Site.breadcrumb.label') })).not.toBeInTheDocument()
      // Exactly one block, and it is the CollectionPage: the absence assertion above is not green just because the page has no
      // JSON-LD at all.
      expect(jsonLd(container).map((block) => block['@type'])).toEqual(['CollectionPage'])
    })

    it('blog with no posts: no JSON-LD at all, not an empty ItemList', async () => {
      respond({ totalPages: 0, items: [] })

      const { container } = render(await WritingIndex(props()))

      expect(screen.getByText(msg('Site.home.empty'))).toBeInTheDocument()
      expect(jsonLd(container)).toEqual([])
    })
  })

  describe('generateMetadata', () => {
    /**
     * og:url must BE the canonical, and og:title must describe this page.
     *
     * Measured on the running dev server before lib/metadata.ts existed: this route
     * emitted `og:title = "<owner name>"` and `og:url = "http://localhost:3000"` —
     * the homepage's — because it declared `title`/`description`/`alternates` but no
     * `openGraph`, and Next inherits that object whole rather than deriving it from the
     * page's own title. A share of this page rendered the homepage's card.
     */
    it('describes ITSELF in the share card, not the homepage', async () => {
      respond({ totalPages: 4, items: [] })

      const m = await generateMetadata(props({ page: '3' }))

      expect(m.openGraph?.url).toBe(m.alternates?.canonical)
      expect(m.openGraph?.url).toBe('/writing?page=3')
      expect(m.openGraph?.title).toBe(msg('Site.footer.links.writing'))
      expect(m.twitter?.title).toBe(msg('Site.footer.links.writing'))
      // Lost by the two routes that DID write their own openGraph block. Present here
      // because the helper restates it for every route.
      expect(m.openGraph?.locale).toBe('vi_VN')
      expect(m.openGraph?.siteName).toBe(site.name)
    })

    it('under /en it is self-canonical, lists both languages and describes itself as en_US', async () => {
      respond({ totalPages: 4, items: [] })

      const meta = await generateMetadata({ ...props({ page: '3' }), params: Promise.resolve({ locale: 'en' }) })

      expect(meta.alternates?.canonical).toBe('/en/writing?page=3')
      expect(meta.openGraph?.url).toBe('/en/writing?page=3')
      expect(meta.alternates?.languages).toEqual({
        vi: '/writing?page=3',
        en: '/en/writing?page=3',
        'x-default': '/writing?page=3',
      })
      expect(meta.openGraph?.locale).toBe('en_US')
    })

    it('sets a canonical URL of its own, per paginated view', async () => {
      // app/layout.tsx sets `alternates: { canonical: '/' }` and Next INHERITS it into
      // every page that does not override it — measured live on /posts/[slug], which
      // emits <link rel="canonical" href="http://localhost:3000"/>. Without this the
      // writing index declares itself a duplicate of the homepage.
      expect(await generateMetadata(props())).toMatchObject({
        title: msg('Site.footer.links.writing'),
        alternates: { canonical: '/writing' },
      })

      // Not collapsed to '/writing'. Canonicalising page 3 to page 1 asks the crawler
      // to drop pages 2..N and the posts that only appear on them.
      expect(await generateMetadata(props({ page: '3' }))).toMatchObject({
        alternates: { canonical: '/writing?page=3' },
      })

      // The same shape check as the page body: a junk ?page must not end up in a
      // canonical URL, which is how a crawler learns about /writing?page=abc at all.
      expect(await generateMetadata(props({ page: '0x2' }))).toMatchObject({
        alternates: { canonical: '/writing' },
      })
    })
  })

  it('has a heading outline that descends without skipping a level', async () => {
    respond({ totalPages: 2, items: [summary(1), summary(2)] })
    // With the "Discover" block, so the outline includes its h2 and the h3s of its child blocks.
    vi.mocked(getDiscovery).mockResolvedValue(someDiscovery)

    const { container } = render(await WritingIndex(props()))
    expect(screen.getByRole('heading', { level: 2, name: msg('Site.writing.discoverTitle') })).toBeInTheDocument()

    // Not a style rule: a jump from h1 to h3 tells a screen-reader user that a level
    // is missing and they have lost a section. jsdom gives nothing else here — it
    // applies no Tailwind, so `sr-only` is invisible to it and every heading below is
    // counted whether it is painted or not, which is exactly right for an outline.
    //
    // This is also what keeps the list section headingless: an sr-only "All posts"
    // h2 there would make each post title its sibling rather than its child.
    const levels = [...container.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => Number(h.tagName[1]))

    expect(levels[0], 'the first heading must be the h1').toBe(1)
    expect(
      levels.filter((l) => l === 1),
      'exactly one h1',
    ).toHaveLength(1)
    levels.forEach((level, i) => {
      if (i === 0) return
      expect(level - levels[i - 1], `heading ${i} jumps from h${levels[i - 1]} to h${level}`).toBeLessThanOrEqual(1)
    })
  })

  it('has no loading.tsx on any of the three listing routes', () => {
    // Not a style preference. This project measured that a loading.tsx turns a
    // data-dependent notFound() into an HTTP 200 while every unit test keeps passing:
    // the route becomes a streamed shell, the shell's 200 status is already committed
    // by the time the body throws, and the 404 never reaches the status line. Every
    // out-of-range and unknown-slug rule above would then be green here and wrong live,
    // so the absence of these files is part of the contract and belongs in the suite.
    // `process.cwd()`, because neither of the obvious alternatives works here:
    // `import.meta.dirname` is undefined before Node 20.11, and
    // `fileURLToPath(import.meta.url)` throws "The URL must be of scheme file" under
    // Vite's transform — measured, that was this test's first failure.
    //
    // A path-absence assertion is vacuous if the path is wrong, so the base directory
    // is proved first. Without this line, resolving to the repo root instead of
    // frontend/ would make all twelve checks below pass while checking nothing.
    // Each route's directory is RESOLVED from the route tree, not spelled out. The earlier
    // version hardcoded 'app/writing', and when the public pages moved into an
    // `app/(site)/` route group that directory stopped existing — so every
    // `existsSync(.../loading.tsx)` returned false and all twelve checks passed while
    // checking nothing. An absence assertion against a path that is simply gone is the
    // purest form of a test that cannot fail. The guard below is what caught it, which is
    // why it is still here in a stronger form: it now demands that each route actually
    // resolves, so a renamed or deleted route fails loudly instead of vacuously passing.
    const appDir = join(process.cwd(), 'app')

    for (const route of ['/writing', '/categories/[slug]', '/tags/[slug]']) {
      const dir = routeDir(appDir, route)
      expect(
        dir,
        `nothing serves ${route}; this check would otherwise pass by looking at a path ` + 'that does not exist',
      ).toBeDefined()

      for (const file of ['loading.tsx', 'loading.ts', 'loading.jsx', 'loading.js']) {
        expect(existsSync(join(dir as string, file)), `${route}/${file} must not exist`).toBe(false)
      }
    }
  })
})
