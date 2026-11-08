import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPosts } from '@/lib/api'
import { getGallery } from '@/lib/gallery'
import { mediaPath } from '@/lib/media'
import { defaultSiteContent } from '@/content/defaults'
import { getSeriesList } from '@/lib/series'
import { TEST_LOCALE } from '@/test/intl'
import type { GalleryPhoto, PostSummary, SeriesSummary } from '@/lib/types'
import { SPLIT_ASIDE, SPLIT_EVEN } from '@/components/site/reader/reader-layout'
import Home, { generateMetadata, revalidate } from './page'
import { pageProps } from '@/test/page-props'
import { ALL_PROJECTS_LINK, FEATURED_PROJECTS_HEADING } from '@/test/fixtures/vi/removed-projects'
import { msg } from '@/test/render-intl'

const { site, about, profile, skills } = defaultSiteContent(TEST_LOCALE)

const metadata = await generateMetadata(pageProps())

/**
 * `Home` is an async Server Component, so React Testing Library cannot render it —
 * `render(<Home />)` hands RTL a promise. It is an ordinary exported async function, so
 * these tests call it and render the tree it returns. That keeps the real module under
 * test, including the fetch arguments and the fallback rule, rather than a helper
 * extracted for testability.
 *
 * The section components are NOT mocked. Each has its own test file for its own branches,
 * but a page that composes eight of them has one failure mode no component test can see:
 * a section left out, rendered twice, or rendered in the wrong order. Rendering the real
 * tree is what catches that, and it is also the only way to count the h1s and check the
 * heading outline of the actual page.
 */
vi.mock('@/lib/api', () => ({ getPosts: vi.fn() }))
// The "Photos" section is a secondary block: on failure or empty it does not render. By default every test gets an
// empty gallery, so the tests about other parts of the page see exactly the page of a site with no photos yet.
vi.mock('@/lib/gallery', () => ({ getGallery: vi.fn() }))

// The "Series" block is a secondary block like the photos: on failure or empty it does not render. By default every test gets no
// series, so the tests about other parts of the page see exactly the page of a site that has none yet.
vi.mock('@/lib/series', () => ({ getSeriesList: vi.fn() }))

/** The top-level bands of the rendered page: every child of the container except the JSON-LD `<script>`. */
const bands = (container: HTMLElement) => Array.from(container.children).filter((el) => el.tagName !== 'SCRIPT')

/** The markup of a band without React's generated ids (`useId`, e.g. the contact form's): they count up with every render. */
const markup = (el: Element) => el.outerHTML.replace(/_r_[0-9a-z]+_/g, '_r_')

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const photo = (n: number): GalleryPhoto => ({
  id: uuid(100 + n),
  image: {
    id: uuid(n),
    fileName: `${uuid(n)}.jpg`,
    width: 1600,
    height: 1200,
    altText: `Photo description ${n}`,
    dominantColor: null,
  },
  caption: null,
  takenOn: null,
})

function stubGallery(photos: GalleryPhoto[]) {
  vi.mocked(getGallery).mockImplementation(async ({ page, size }) => ({
    items: photos.slice(0, size),
    meta: { page, size, totalElements: photos.length, totalPages: photos.length > 0 ? 1 : 0 },
  }))
}

const SIX_PHOTOS = [1, 2, 3, 4, 5, 6].map(photo)

beforeEach(() => {
  stubGallery([])
  vi.mocked(getSeriesList).mockResolvedValue([])
})

const seriesItem = (n: number): SeriesSummary => ({
  id: uuid(500 + n),
  title: `Series ${n}`,
  slug: `series-${n}`,
  description: `Description of series ${n}.`,
  postCount: n + 1,
  readingMinutes: 10 * n,
  latestPublishedAt: '2026-10-05T10:00:00Z',
  parts: [{ slug: `series-${n}-part-1`, title: `Series ${n} part 1` }],
})

const post = (n: number): PostSummary => ({
  id: `p${n}`,
  title: `Post ${n}`,
  slug: `bai-viet-${n}`,
  excerpt: `Excerpt ${n}.`,
  // The public list only ever returns PUBLISHED, so the fixture says so rather than
  // leaving a required field to be filled in by accident.
  status: 'PUBLISHED',
  category: null,
  tags: [],
  publishedAt: '2026-10-03T18:23:29Z',
  featured: false,
  readingMinutes: 1,
})

/**
 * Answers from the `featured` set or the unfiltered set depending on what was asked for,
 * which is what makes the fallback observable. A mock that returned one fixed list could
 * not tell "fell back correctly" from "never passed featured at all".
 */
function mockApi({ featured, recent }: { featured: PostSummary[]; recent: PostSummary[] }) {
  vi.mocked(getPosts).mockImplementation(async (params) => {
    const items = params.featured === true ? featured : recent
    return {
      items,
      meta: { page: params.page, size: params.size, totalElements: items.length, totalPages: 1 },
    }
  })
}

afterEach(() => {
  vi.mocked(getPosts).mockReset()
  vi.mocked(getGallery).mockReset()
  vi.mocked(getSeriesList).mockReset()
})

describe('Home — the writing section', () => {
  it('asks for the featured posts and renders them without a second request', async () => {
    mockApi({ featured: [post(1), post(2), post(3)], recent: [post(9)] })

    render(await Home(pageProps()))

    // Pins the size and the tri-state parameter. `featured: true` and not a variable:
    // lib/api.ts drops a `false`, so a boolean flag here would be silently ignored.
    expect(getPosts).toHaveBeenCalledWith({ page: 0, size: 3, featured: true, language: 'vi' })
    expect(getPosts, 'the fallback must not run when something is featured').toHaveBeenCalledTimes(1)

    expect(screen.getByRole('link', { name: 'Post 1' })).toHaveAttribute('href', '/posts/bai-viet-1')
    expect(screen.getByText('Post 3')).toBeInTheDocument()
    // Makes the fallback test below discriminating: the recent list is reachable from
    // the mock, so its absence here proves the page chose the featured one.
    expect(screen.queryByText('Post 9')).not.toBeInTheDocument()
  })

  it('falls back to the most recent posts when nothing is featured', async () => {
    // The state every fresh database starts in: posts exist, none is featured. Without
    // the fallback the homepage renders a heading, an "All posts" link and a hole.
    mockApi({ featured: [], recent: [post(9), post(10)] })

    const { container } = render(await Home(pageProps()))

    expect(getPosts).toHaveBeenCalledTimes(2)
    expect(getPosts).toHaveBeenNthCalledWith(1, { page: 0, size: 3, featured: true, language: 'vi' })
    // Exactly this object: no `featured` key at all. `{ page: 0, size: 3, featured: false }`
    // fails here, which is the point — absent and false stay distinguishable at the API.
    expect(getPosts).toHaveBeenNthCalledWith(2, { page: 0, size: 3, language: 'vi' })

    expect(screen.getByText('Post 9')).toBeInTheDocument()
    expect(screen.getByText('Post 10')).toBeInTheDocument()
    expect(container.querySelectorAll('article')).toHaveLength(2)
    expect(screen.queryByText(msg('Site.home.empty'))).not.toBeInTheDocument()
  })

  it('each post is a ListRow h3 with a thumbnail and a category, with no tag row', async () => {
    const kienTruc = { id: 'c1', name: 'Architecture', slug: 'kien-truc', description: null }
    mockApi({
      featured: [{ ...post(1), category: kienTruc, tags: [{ id: 't1', name: 'Lessons', slug: 'bai-hoc' }] }, post(2)],
      recent: [],
    })

    const { container } = render(await Home(pageProps()))
    const section = container.querySelector('#bai-viet')!.closest('section')!

    expect(screen.getByRole('heading', { level: 2, name: msg('Site.footer.links.startHere') })).toBe(
      container.querySelector('#bai-viet'),
    )
    const rows = section.querySelectorAll('article')
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      // h3 because the section h2 is right above; the thumbnail is a hidden link wrapping the cover art.
      expect(row.querySelectorAll('h3')).toHaveLength(1)
      expect(row.querySelectorAll('svg.cover-art')).toHaveLength(1)
      expect(row.querySelector('a[aria-hidden="true"][tabindex="-1"]')).not.toBeNull()
    }
    expect(within(section).getAllByRole('link', { name: 'Post 1' })).toHaveLength(1)

    // No tag row on the home page: the three sample posts are an invitation to read, not a table of contents.
    expect(within(section).queryByRole('list', { name: msg('Site.article.tagsLabel') })).not.toBeInTheDocument()
    expect(section.querySelector('a[href^="/tags/"]')).toBeNull()
    // Pair of the "yes" assertion: the category is still there, now a link to the category page.
    expect(within(section).getByRole('link', { name: 'Architecture' })).toHaveAttribute('href', '/categories/kien-truc')
  })

  it('offers the other language when this one has no posts but the other has', async () => {
    vi.mocked(getPosts).mockImplementation(async (params) => {
      const items = params.language === 'en' ? [post(1)] : []
      return { items, meta: { page: params.page, size: params.size, totalElements: items.length, totalPages: 1 } }
    })

    render(await Home(pageProps()))

    expect(getPosts).toHaveBeenCalledWith({ page: 0, size: 3, featured: true, language: 'vi' })
    expect(screen.getByText(msg('Site.languageFallback.message'))).toBeInTheDocument()
    expect(screen.getByRole('link', { name: msg('Site.languageFallback.link', { language: 'English' }) })).toHaveAttribute(
      'href',
      '/en',
    )
    expect(screen.queryByText(msg('Site.home.empty'))).not.toBeInTheDocument()
  })

  it('says so, once, when the blog has published nothing at all', async () => {
    mockApi({ featured: [], recent: [] })

    const { container } = render(await Home(pageProps()))

    // Two for the list, one probing the other language for the fallback link.
    expect(getPosts).toHaveBeenCalledTimes(3)
    expect(screen.getByText(msg('Site.home.empty'))).toBeInTheDocument()
    // Element, not text: an `items.map` over an empty list would leave the assertion
    // above true while rendering empty cards.
    expect(container.querySelector('article')).toBeNull()
    // The rest of the page still has to be there — the writing section going quiet must
    // not take the portfolio with it.
    expect(container.querySelectorAll('h1')).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 2, name: msg('Site.home.timeline.title') })).toBeInTheDocument()
  })
})

describe('Home — "Best posts" or "New posts"', () => {
  /** The posts section, found by id rather than by name: the name is exactly what is being checked. */
  const writing = (container: HTMLElement) => container.querySelector('#bai-viet')!.closest('section')!

  it('with curated posts: "Best posts", a lead sentence, "Full list →" to /start-here, "All posts →" below the list', async () => {
    mockApi({ featured: [post(1), post(2), post(3)], recent: [post(9)] })

    const { container } = render(await Home(pageProps()))
    const section = writing(container)

    expect(within(section).getByRole('heading', { level: 2 })).toHaveTextContent(msg('Site.footer.links.startHere'))
    expect(within(section).getByText(msg('Site.home.featuredLead', { count: 3 }))).toBeInTheDocument()

    // The action in the heading row points to the whole curated list, not /writing.
    expect(within(section).getByRole('link', { name: msg('Site.home.fullList') })).toHaveAttribute('href', '/start-here')
    // "All posts" is still exactly one link, now below the list.
    const all = within(section).getByRole('link', { name: msg('Site.startHere.allPosts') })
    expect(all).toHaveAttribute('href', '/writing')
    const list = section.querySelector('ul')!
    expect(list.compareDocumentPosition(all) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByRole('heading', { name: msg('Site.home.recentTitle') })).not.toBeInTheDocument()
  })

  it('the lead sentence states the exact number of posts shown: it does not say "three posts" when there are only two', async () => {
    mockApi({ featured: [post(1), post(2)], recent: [] })
    const { container, unmount } = render(await Home(pageProps()))
    expect(within(writing(container)).getByText(msg('Site.home.featuredLead', { count: 2 }))).toBeInTheDocument()
    expect(within(writing(container)).queryByText(msg('Site.home.featuredLead', { count: 3 }))).not.toBeInTheDocument()
    unmount()

    mockApi({ featured: [post(1)], recent: [] })
    const one = render(await Home(pageProps()))
    expect(within(writing(one.container)).getByText(msg('Site.home.featuredLead', { count: 1 }))).toBeInTheDocument()
  })

  it('without curated posts: "New posts", no lead sentence, action "All posts" to /writing', async () => {
    mockApi({ featured: [], recent: [post(9), post(10)] })

    const { container } = render(await Home(pageProps()))
    const section = writing(container)

    expect(within(section).getByRole('heading', { level: 2 })).toHaveTextContent(msg('Site.home.recentTitle'))
    expect(screen.queryByRole('heading', { name: msg('Site.footer.links.startHere') })).not.toBeInTheDocument()
    for (const count of [1, 2, 3, 4]) {
      expect(within(section).queryByText(msg('Site.home.featuredLead', { count }))).not.toBeInTheDocument()
    }
    // The newest posts are not a curated list: no link to /start-here pretends they are.
    expect(section.querySelector('a[href="/start-here"]')).toBeNull()
    expect(within(section).getAllByRole('link', { name: msg('Site.startHere.allPosts') })).toHaveLength(1)
    expect(within(section).getByRole('link', { name: msg('Site.startHere.allPosts') })).toHaveAttribute('href', '/writing')
  })
})

describe('Home — section "Series"', () => {
  const section = (container: HTMLElement) => container.querySelector('#series')!.closest('section')!

  it('asks for the series of the page language and shows the first three as rows like the featured posts', async () => {
    mockApi({ featured: [post(1)], recent: [] })
    vi.mocked(getSeriesList).mockResolvedValue([1, 2, 3, 4].map(seriesItem))

    const { container } = render(await Home(pageProps()))

    expect(getSeriesList).toHaveBeenCalledWith('vi')
    const block = within(section(container))
    expect(block.getByRole('heading', { level: 2 })).toHaveTextContent(msg('Site.home.seriesTitle'))
    expect(block.getByText(msg('Site.home.seriesLead'))).toBeInTheDocument()
    expect(block.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Series 1', 'Series 2', 'Series 3'])
    expect(block.getByRole('link', { name: 'Series 1' })).toHaveAttribute('href', '/series/series-1')
    expect(block.getByText('Description of series 2.')).toBeInTheDocument()
    expect(block.queryByText('Series 4')).not.toBeInTheDocument()
    // Same row grammar as a featured post: a thumbnail with the cover art beside the text.
    expect(section(container).querySelectorAll('article svg.cover-art')).toHaveLength(3)
  })

  it('states the number of parts and links to the whole list, with no part list of its own', async () => {
    mockApi({ featured: [post(1)], recent: [] })
    vi.mocked(getSeriesList).mockResolvedValue([seriesItem(2)])

    const { container } = render(await Home(pageProps()))
    const block = within(section(container))

    expect(block.getByText(msg('Site.listing.seriesMeta.parts', { count: 3 }))).toBeInTheDocument()
    expect(block.getByRole('link', { name: msg('Site.home.allSeries') })).toHaveAttribute('href', '/series')
    expect(section(container).querySelector('ol')).toBeNull()
    expect(block.queryByRole('link', { name: 'Series 2 part 1' })).not.toBeInTheDocument()
  })

  it('sits right after the posts, in the same band', async () => {
    mockApi({ featured: [post(1)], recent: [] })
    vi.mocked(getSeriesList).mockResolvedValue([seriesItem(1)])

    const { container } = render(await Home(pageProps()))

    const cells = Array.from(bands(container)[1]!.querySelector(':scope > div')!.children)
    expect(cells.map((cell) => cell.querySelector('h2')?.id)).toEqual(['bai-viet', 'series'])
  })

  it('no series: no section, and the posts take the whole band', async () => {
    mockApi({ featured: [post(1)], recent: [] })

    const { container } = render(await Home(pageProps()))

    expect(container.querySelector('#series')).toBeNull()
    expect(container.querySelector('a[href="/series"]')).toBeNull()
    expect(bands(container)[1]!.querySelector('#bai-viet')).not.toBeNull()
    expect(bands(container)[1]!.querySelector(':scope > div.grid')).toBeNull()
  })

  it('failing series API: the page still renders, only the section is missing', async () => {
    mockApi({ featured: [post(1)], recent: [] })
    vi.mocked(getSeriesList).mockRejectedValue(new Error('fetch failed'))

    const { container } = render(await Home(pageProps()))

    expect(container.querySelector('#series')).toBeNull()
    expect(screen.getByRole('link', { name: 'Post 1' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: msg('Site.contact.title') })).toBeInTheDocument()
  })
})

describe('Home — section "Photos"', () => {
  it('asks for the first six gallery photos', async () => {
    mockApi({ featured: [post(1)], recent: [] })
    stubGallery(SIX_PHOTOS)

    await Home(pageProps())

    expect(getGallery).toHaveBeenCalledWith({ page: 0, size: 6 })
  })

  it('with photos: the "Photos" section (id anh) sits between "Now" and "Contact", six cells pointing at the original photos', async () => {
    mockApi({ featured: [post(1)], recent: [] })
    stubGallery(SIX_PHOTOS)

    const { container } = render(await Home(pageProps()))

    const heading = screen.getByRole('heading', { level: 2, name: msg('Site.footer.links.gallery') })
    expect(heading).toHaveAttribute('id', 'anh')
    const section = screen.getByRole('region', { name: msg('Site.footer.links.gallery') })
    expect(
      within(section)
        .getAllByRole('link')
        .filter((a) => a.getAttribute('href')?.startsWith('/media/'))
        .map((a) => a.getAttribute('href')),
    ).toEqual(SIX_PHOTOS.map((p) => mediaPath(p.image)))
    expect(within(section).getByRole('link', { name: msg('Site.gallery.seeAll') })).toHaveAttribute('href', '/gallery')

    const h2s = Array.from(container.querySelectorAll('h2')).map((h) => h.textContent)
    expect(h2s.indexOf(msg('Site.footer.links.gallery'))).toBe(h2s.indexOf(msg('Site.home.now.title')) + 1)
    expect(h2s.indexOf(msg('Site.contact.title'))).toBe(h2s.indexOf(msg('Site.footer.links.gallery')) + 1)
    // No figures anywhere on the home page: no "6 photos".
    expect(within(section).queryByText(new RegExp(msg('Admin.gallery.manager.tally', { count: '\d+' })))).not.toBeInTheDocument()
  })

  it('empty gallery: no "Photos" section, no orphan heading', async () => {
    mockApi({ featured: [post(1)], recent: [] })

    const { container } = render(await Home(pageProps()))

    expect(screen.queryByRole('heading', { name: msg('Site.footer.links.gallery') })).not.toBeInTheDocument()
    expect(container.querySelector('#anh')).toBeNull()
    expect(container.querySelector('a[href="/gallery"]')).toBeNull()
  })

  it('failing gallery: the page still renders all the other parts, only the "Photos" section is missing', async () => {
    mockApi({ featured: [post(1)], recent: [] })
    vi.mocked(getGallery).mockRejectedValue(new Error('fetch failed'))

    const { container } = render(await Home(pageProps()))

    expect(container.querySelector('#anh')).toBeNull()
    expect(screen.getByRole('heading', { level: 2, name: msg('Site.contact.title') })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Post 1' })).toBeInTheDocument()
  })
})

describe('Home — structure', () => {
  it('renders no <main> of its own', async () => {
    // app/layout.tsx owns `<main id="main-content">`. Two main landmarks in one document
    // is invalid HTML and makes "skip to main content" ambiguous; the previous version of
    // this file emitted the second one, measured live on the dev server.
    mockApi({ featured: [post(1)], recent: [] })

    const { container } = render(await Home(pageProps()))

    expect(container.querySelector('main')).toBeNull()
  })

  it('has exactly one h1, and it is the hero headline', async () => {
    mockApi({ featured: [post(1)], recent: [] })

    const { container } = render(await Home(pageProps()))

    const h1s = container.querySelectorAll('h1')
    expect(h1s).toHaveLength(1)
    expect(h1s[0]?.textContent).toBe(profile.hero.headline)
  })

  it('descends through heading levels without skipping one', async () => {
    mockApi({ featured: [post(1)], recent: [] })

    const { container } = render(await Home(pageProps()))

    const levels = Array.from(container.querySelectorAll('h1, h2, h3, h4, h5, h6')).map((heading) => Number(heading.tagName[1]))

    expect(levels[0], 'the first heading on the page must be the h1').toBe(1)
    for (let i = 1; i < levels.length; i += 1) {
      // Going back up any number of levels is fine; going down more than one at a time
      // is the defect — an h2 followed by an h4 leaves a rung missing in the outline.
      expect(levels[i]! - levels[i - 1]!, `heading ${i} jumps from h${levels[i - 1]} to h${levels[i]}`).toBeLessThanOrEqual(1)
    }
  })

  it('without photos and without series: six sections in the defined order, and no skills section', async () => {
    mockApi({ featured: [post(1)], recent: [] })

    const { container } = render(await Home(pageProps()))

    const headings = Array.from(container.querySelectorAll('h1, h2')).map((h) => h.textContent)
    expect(headings).toEqual([
      profile.hero.headline,
      msg('Site.home.introTitle'),
      msg('Site.footer.links.startHere'),
      msg('Site.home.timeline.title'),
      msg('Site.home.now.title'),
      msg('Site.contact.title'),
    ])
  })

  it('with series: the "Series" section comes right after the posts', async () => {
    mockApi({ featured: [post(1)], recent: [] })
    vi.mocked(getSeriesList).mockResolvedValue([seriesItem(1)])

    const { container } = render(await Home(pageProps()))

    const headings = Array.from(container.querySelectorAll('h1, h2')).map((h) => h.textContent)
    expect(headings).toEqual([
      profile.hero.headline,
      msg('Site.home.introTitle'),
      msg('Site.footer.links.startHere'),
      msg('Site.home.seriesTitle'),
      msg('Site.home.timeline.title'),
      msg('Site.home.now.title'),
      msg('Site.contact.title'),
    ])
  })

  it('with photos: seven sections, "Photos" between "Now" and "Contact"', async () => {
    mockApi({ featured: [post(1)], recent: [] })
    stubGallery(SIX_PHOTOS)

    const { container } = render(await Home(pageProps()))

    const headings = Array.from(container.querySelectorAll('h1, h2')).map((h) => h.textContent)
    expect(headings).toEqual([
      profile.hero.headline,
      msg('Site.home.introTitle'),
      msg('Site.footer.links.startHere'),
      msg('Site.home.timeline.title'),
      msg('Site.home.now.title'),
      msg('Site.footer.links.gallery'),
      msg('Site.contact.title'),
    ])
  })

  it('failing gallery: exactly six sections again', async () => {
    mockApi({ featured: [post(1)], recent: [] })
    vi.mocked(getGallery).mockRejectedValue(new Error('fetch failed'))

    const { container } = render(await Home(pageProps()))

    expect(Array.from(container.querySelectorAll('h1, h2')).map((h) => h.textContent)).toHaveLength(6)
  })

  it('lays the page out as five reader bands, each with the gutter of the header', async () => {
    // The defect this catches has no type error and no visual test: one band written with its own `px-6` or a bare
    // <section> puts two blocks on the same page at two different left edges. Container owns the gutter; every
    // top-level child must be a `reader` one, so the text starts under the header logo.
    //
    // With photos, so that the photos band is checked too (a Container of its own, built by a component shared with /about).
    mockApi({ featured: [post(1)], recent: [] })
    stubGallery(SIX_PHOTOS)

    const { container } = render(await Home(pageProps()))

    // `<script>` excluded: the WebSite JSON-LD block is a top-level child and has no
    // gutter to get wrong. It is filtered by tag rather than by index so that adding or
    // removing a structured-data block cannot quietly shift which elements get checked.
    const rows = bands(container)
    // Five with photos: A (hero + introduction), B (posts + series), C (journey + now), the photos band, contact.
    expect(rows.length).toBe(5)
    for (const row of rows) {
      const label = `<${row.tagName.toLowerCase()}>`
      expect(row.className, label).toContain('px-4')
      expect(row.className, label).toContain('sm:px-6')
      expect(row.className, label).toContain('mx-auto')
      expect(row.className, label).toContain('max-w-[87.5rem]')
    }
  })

  it('puts neighbours side by side: A hero + introduction, B posts + series, C journey + now', async () => {
    mockApi({ featured: [post(1)], recent: [] })
    vi.mocked(getSeriesList).mockResolvedValue([seriesItem(1)])
    stubGallery(SIX_PHOTOS)

    const { container } = render(await Home(pageProps()))

    const rows = bands(container)
    const grid = (row: Element) => row.querySelector(':scope > div')!
    const headingIds = (row: Element) => Array.from(grid(row).children).map((cell) => cell.querySelector('h1, h2')?.id ?? '')

    // The two templates come from reader-layout.ts, never spelled out here.
    expect(grid(rows[0]!).className).toBe(SPLIT_EVEN)
    expect(grid(rows[1]!).className).toBe(SPLIT_EVEN)
    expect(grid(rows[2]!).className).toBe(SPLIT_ASIDE)

    expect(grid(rows[0]!).children[0]!.tagName).toBe('HEADER')
    expect(grid(rows[0]!).children[0]!.querySelector('h1')).not.toBeNull()
    expect(headingIds(rows[0]!)[1]).toBe('gioi-thieu')
    expect(headingIds(rows[1]!)).toEqual(['bai-viet', 'series'])
    expect(headingIds(rows[2]!)).toEqual(['chang-duong', 'hien-tai'])
    expect(rows[3]!.querySelector('h2')?.id).toBe('anh')
    expect(rows[4]!.querySelector('h2')?.id).toBe('lien-he')
    // Cells carry no Container of their own: the row owns the gutter and the vertical padding.
    for (const row of rows.slice(0, 3)) {
      expect(grid(row).querySelector('.mx-auto')).toBeNull()
      expect(grid(row).querySelector('section[class*="py-"], header[class*="py-"]')).toBeNull()
    }
    for (const row of [rows[0]!, rows[1]!, rows[2]!, rows[4]!]) {
      expect(row.className).toContain('py-8')
      expect(row.className).toContain('sm:py-14')
    }
  })

  it('renders the introduction as a card with 16px paragraphs on a phone and 18px from sm', async () => {
    mockApi({ featured: [post(1)], recent: [] })

    const { container } = render(await Home(pageProps()))

    const card = container.querySelector('#gioi-thieu')!.closest('section')!.parentElement!
    for (const cls of ['rounded-card', 'border', 'bg-neutral-50', 'p-4', 'sm:p-6', 'xl:p-8', 'dark:bg-neutral-900']) {
      expect(card.className, cls).toContain(cls)
    }
    const paragraphs = Array.from(card.querySelectorAll('section > div > p'))
    expect(paragraphs.length).toBeGreaterThan(0)
    // 18px text: in the 577px text box of a SPLIT_EVEN cell at 1440 that is about 70 characters a line (measured), inside the
    // 45 to 75 of a card; 16px text would run to 79 there.
    expect(card.querySelector('.sm\\:text-lg')).not.toBeNull()
    expect(card.querySelector('.text-lg')).toBeNull()
    // Below sm the paragraphs are 16px: a 398px column holds about 45 characters of 18px text, 52 of 16px.
    expect(card.querySelector('.text-base')).not.toBeNull()
  })

  it('has no skills section: no heading, no anchor, no skill names from the site content', async () => {
    mockApi({ featured: [post(1)], recent: [] })

    const { container } = render(await Home(pageProps()))

    expect(container.querySelector('#ky-nang')).toBeNull()
    expect(container.querySelector('a[href*="#ky-nang"]')).toBeNull()
    expect(screen.queryByRole('heading', { name: msg('Admin.settings.skills.groups') })).not.toBeInTheDocument()
    for (const group of skills) {
      expect(screen.queryByRole('heading', { level: 3, name: group.title }), group.title).not.toBeInTheDocument()
    }
  })

  it('the journey is the wide cell and "Now" the card beside it, in that DOM order', async () => {
    mockApi({ featured: [post(1)], recent: [] })

    const { container } = render(await Home(pageProps()))

    const cells = Array.from(bands(container)[2]!.querySelector(':scope > div')!.children)
    expect(cells).toHaveLength(2)
    expect(cells[0]!.querySelector('h2')?.id).toBe('chang-duong')
    expect(cells[1]!.className).toContain('rounded-card')
    expect(cells[1]!.querySelector('h2')?.id).toBe('hien-tai')
  })

  it('without photos: no photos band, and rows A, B, C and E are unchanged', async () => {
    mockApi({ featured: [post(1)], recent: [] })
    const withoutPhotos = render(await Home(pageProps()))
    const without = bands(withoutPhotos.container)
    const htmlWithout = without.map(markup)
    withoutPhotos.unmount()

    stubGallery(SIX_PHOTOS)
    const withPhotos = render(await Home(pageProps()))
    const withBand = bands(withPhotos.container)

    expect(without).toHaveLength(4)
    expect(without.some((el) => el.querySelector('#anh'))).toBe(false)
    expect(withBand).toHaveLength(5)
    // Rows A, B, C and E are exactly what they are with the photos band in between.
    expect([0, 1, 2, 4].map((i) => markup(withBand[i]!))).toEqual(htmlWithout)
  })

  it('keeps every section anchor', async () => {
    mockApi({ featured: [post(1)], recent: [] })
    stubGallery(SIX_PHOTOS)
    vi.mocked(getSeriesList).mockResolvedValue([seriesItem(1)])

    const { container } = render(await Home(pageProps()))

    for (const id of ['gioi-thieu', 'bai-viet', 'series', 'chang-duong', 'hien-tai', 'anh', 'lien-he']) {
      expect(container.querySelector(`h2#${id}`), id).not.toBeNull()
      expect(container.querySelector(`section[aria-labelledby="${id}"]`), `section named by ${id}`).not.toBeNull()
    }
  })

  it('reads no searchParams, so none of the ?page parsing can creep back', async () => {
    // The post list and its `?page` have moved to /writing, and with them the digit-shape
    // check, the MAX_PAGE refusal and the AcceptsGeneratedProps tripwire this file used to
    // carry. Those guards were each written against a measured failure, so dropping them
    // is only safe while this page reads no searchParams at all. The page takes one argument,
    // the props that carry the locale (`params`), and the source must not touch `searchParams`.
    expect(Home.length).toBe(1)
    const source = readFileSync(join(process.cwd(), 'app/[locale]/(site)/page.tsx'), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/searchParams/)
  })
})

describe('Home — portfolio content', () => {
  it('introduces the author in prose and links to /about', async () => {
    mockApi({ featured: [post(1)], recent: [] })

    render(await Home(pageProps()))

    const who = about.sections.find((section) => section.id === 'who')
    expect(who, 'the site content must still carry the `who` section').toBeDefined()
    expect(screen.getByText(who!.body[0]!)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: msg('Site.home.aboutLink') })).toHaveAttribute('href', '/about')

    // Not the whole About page: the other four sections stay on /about.
    for (const section of about.sections.filter((s) => s.id !== 'who')) {
      expect(screen.queryByText(section.body[0]!), section.id).not.toBeInTheDocument()
    }
  })

  it('carries no portfolio section and no link into the removed /projects route', async () => {
    // The owner's decision: the projects shown here were work projects, not personal
    // ones, and are not published. The data file, both routes and the card component
    // are gone — so a section rebuilt from a hardcoded list, or a leftover link, is a
    // link to a 404. This asserts the ABSENCE on the rendered page rather than the
    // absence of the file, which is the channel a reader actually meets.
    mockApi({ featured: [post(1)], recent: [] })

    const { container } = render(await Home(pageProps()))

    expect(screen.queryByRole('heading', { name: FEATURED_PROJECTS_HEADING })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: ALL_PROJECTS_LINK })).not.toBeInTheDocument()
    const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'))
    expect(hrefs.filter((href) => href?.startsWith('/projects'))).toEqual([])
    expect(container.querySelector('#du-an')).toBeNull()
  })

  it('shows no invented numbers: no progress bar and no percentage anywhere on the page', async () => {
    mockApi({ featured: [post(1)], recent: [] })

    const { container } = render(await Home(pageProps()))

    // There is no measurement behind "85% Java" in this repository, so a number would be invented to look precise.
    expect(container.querySelectorAll('[role="progressbar"], progress, meter')).toHaveLength(0)
    expect(container.textContent).not.toContain('%')
  })

  it('links to the two section pages the hero promises', async () => {
    mockApi({ featured: [post(1)], recent: [] })

    render(await Home(pageProps()))

    expect(screen.getByRole('link', { name: msg('Site.hero.readPosts') })).toHaveAttribute('href', '/writing')
    expect(screen.getByRole('link', { name: msg('Site.footer.links.about') })).toHaveAttribute('href', '/about')
    expect(screen.getByRole('link', { name: msg('Site.startHere.allPosts') })).toHaveAttribute('href', '/writing')
  })
})

describe('Home — route metadata', () => {
  it('declares the revalidate window the route is supposed to have', () => {
    // Nothing else observes this. Changing 300, or deleting the export, leaves every other
    // test in the suite green.
    expect(revalidate).toBe(300)
  })

  it('under /en the home page is /en, with hreflang for both languages', async () => {
    const english = await generateMetadata(pageProps('en'))

    expect(english.alternates?.canonical).toBe('/en')
    expect(english.openGraph?.url).toBe('/en')
    expect(english.alternates?.languages).toEqual({ vi: '/', en: '/en', 'x-default': '/' })
    expect(metadata.alternates?.languages).toEqual({ vi: '/', en: '/en', 'x-default': '/' })
  })

  it('states its own canonical, title and description', () => {
    // alternates.canonical is inherited from the root layout by every page that omits it,
    // so a page that sets its own cannot be broken by a later fix to that inheritance.
    expect(metadata.alternates?.canonical).toBe('/')
    expect(metadata.description).toBe(site.positioning)

    // `absolute`, not a bare string: the root layout's title.template would otherwise
    // append the author's name to a title that already contains it. The separator is an
    // interpunct because a tagline may itself contain an em dash.
    expect(metadata.title).toEqual({ absolute: `${site.name} · ${site.tagline}` })
    expect((metadata.title as { absolute: string }).absolute).not.toMatch(/—.*—/)

    expect(metadata.openGraph).toMatchObject({
      type: 'website',
      url: '/',
      description: site.positioning,
      locale: 'vi_VN',
      siteName: site.name,
    })
    // og:url IS the canonical, not a second expression that happens to agree with it.
    expect(metadata.openGraph?.url).toBe(metadata.alternates?.canonical)
    // The homepage's own twitter:title was the bare site name until lib/metadata.ts —
    // measured: `twitter:title = "the owner name"` while og:title carried the full
    // title. The root layout's twitter block was being inherited whole, exactly like the
    // openGraph block was on the five listing routes.
    expect(metadata.twitter?.title).toBe(`${site.name} · ${site.tagline}`)
  })
})

describe('landmarks', () => {
  it('names every section with a heading that exists on the page', async () => {
    mockApi({ featured: [post(1), post(2), post(3)], recent: [post(4)] })
    stubGallery(SIX_PHOTOS)

    const { container } = render(await Home(pageProps()))

    // A <section> with no accessible name is not exposed as a region landmark at all,
    // so a reader using landmark navigation on an eight-section homepage would get one
    // jump target instead of eight. SectionHeading already puts its id on the <h2>; the
    // aria-labelledby is what connects them.
    const sections = [...container.querySelectorAll('section')]
    expect(sections.length, 'the homepage should be built from sections').toBeGreaterThan(4)

    for (const section of sections) {
      const labelledBy = section.getAttribute('aria-labelledby')
      expect(labelledBy, `a <section> with no aria-labelledby: ${section.className}`).toBeTruthy()
      // And the target must EXIST. A dangling aria-labelledby is worse than none: the
      // element claims a name, the name resolves to nothing, and a screen reader
      // announces an unnamed region anyway — with no warning from anything.
      expect(
        container.querySelector(`#${labelledBy}`),
        `aria-labelledby="${labelledBy}" points at no element on this page`,
      ).not.toBeNull()
    }
  })
})
