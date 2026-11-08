import { screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultSiteContent } from '@/content/defaults'
import { TEST_LOCALE } from '@/test/intl'
import { getPosts } from '@/lib/api'
import { fetchAllPublishedPosts } from '@/lib/published-posts'
import { getSeriesList } from '@/lib/series'
import { getCategories } from '@/lib/taxonomy'
import type { Category, PostSummary, SeriesSummary } from '@/lib/types'
import StartHere, { dynamic, generateMetadata } from './page'
import { pageProps } from '@/test/page-props'
import { msg, renderWithIntl } from '@/test/render-intl'

// The sidebar frame is tested once (BrowseFrame.test.tsx); here a stand-in records what the page asked for.
vi.mock('@/components/site/BrowseFrame', () => import('@/test/browse-frame-mock'))

const { site } = defaultSiteContent(TEST_LOCALE)

/**
 * The "Best posts" page. The main content is the curated list; the series and categories
 * are secondary blocks. The two kinds of failure therefore have two different fates, and both are pinned here:
 * a failing curated list makes the page throw (500, like /writing), a failing secondary block only hides that block.
 */
vi.mock('@/lib/api', () => ({ getPosts: vi.fn() }))
vi.mock('@/lib/series', () => ({ getSeriesList: vi.fn(), getSeries: vi.fn() }))
vi.mock('@/lib/taxonomy', () => ({ getCategories: vi.fn(), getTags: vi.fn() }))
vi.mock('@/lib/published-posts', () => ({ fetchAllPublishedPosts: vi.fn() }))

const KIEN_TRUC: Category = { id: 'c1', name: 'Architecture', slug: 'kien-truc', description: 'Systems and trade-offs.' }
const LAM_VIEC: Category = { id: 'c2', name: 'How I work', slug: 'cach-toi-lam-viec', description: null }
const RONG: Category = { id: 'c3', name: 'No posts yet', slug: 'chua-co-bai', description: null }

const post = (n: number, extra: Partial<PostSummary> = {}): PostSummary => ({
  id: `p${n}`,
  title: `Chosen post number ${n}`,
  slug: `bai-chon-${n}`,
  excerpt: null,
  status: 'PUBLISHED',
  category: KIEN_TRUC,
  tags: [],
  publishedAt: '2026-10-03T08:00:00Z',
  featured: true,
  readingMinutes: 6,
  featuredRank: n,
  ...extra,
})

const SERIES: SeriesSummary = {
  id: 's1',
  title: 'Series A',
  slug: 'series-a',
  description: 'From the first build to writing together with a coding agent.',
  postCount: 3,
  readingMinutes: 24,
  latestPublishedAt: '2026-10-03T08:00:00Z',
  parts: [
    { slug: 'phan-dau', title: 'The first build' },
    { slug: 'phan-giua', title: 'Server component' },
    { slug: 'phan-cuoi', title: 'Writing with the agent' },
  ],
}

function respond({
  curated = [post(1), post(2), post(3)],
  series = [SERIES],
  all = [post(1), post(2), post(3, { category: LAM_VIEC })],
  categories = [KIEN_TRUC, LAM_VIEC, RONG],
}: {
  curated?: PostSummary[]
  series?: SeriesSummary[]
  all?: PostSummary[]
  categories?: Category[]
} = {}) {
  vi.mocked(getPosts).mockResolvedValue({
    items: curated,
    meta: { page: 0, size: 50, totalElements: curated.length, totalPages: curated.length > 0 ? 1 : 0 },
  })
  vi.mocked(getSeriesList).mockResolvedValue(series)
  vi.mocked(fetchAllPublishedPosts).mockResolvedValue(all)
  vi.mocked(getCategories).mockResolvedValue(categories)
}

/** One message of this page, in the locale of the current test. */
const text = (key: string, args?: Record<string, string | number>) => msg(`Site.startHere.${key}`, args)

/** The section whose h2 carries this name. */
function section(name: string): HTMLElement {
  const heading = screen.getByRole('heading', { level: 2, name })
  return heading.closest('section') as HTMLElement
}

function jsonLd(container: HTMLElement): Record<string, unknown>[] {
  return Array.from(container.querySelectorAll('script[type="application/ld+json"]')).map(
    (script) => JSON.parse(script.textContent ?? '') as Record<string, unknown>,
  )
}

afterEach(() => {
  vi.mocked(getPosts).mockReset()
  vi.mocked(getSeriesList).mockReset()
  vi.mocked(fetchAllPublishedPosts).mockReset()
  vi.mocked(getCategories).mockReset()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('/start-here', () => {
  it('eyebrow, h1 and lead; one h1, no second <main>', async () => {
    respond()

    const { container } = renderWithIntl(await StartHere(pageProps()))

    expect(screen.getByText(text('eyebrow'))).toBeInTheDocument()
    expect(container.querySelectorAll('h1')).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(text('title'))
    expect(container.querySelector('main')).toBeNull()
  })

  it('sits in the frame with "Best posts" as the current row (the own page: aria-current=page); no section row of its own', async () => {
    respond({ curated: [post(1)] })

    renderWithIntl(await StartHere(pageProps()))

    const frame = screen.getByTestId('browse-frame')
    expect(frame).toHaveAttribute('data-current', 'best')
    expect(frame).toHaveAttribute('data-exact', 'true')
    expect(frame).toContainElement(screen.getByRole('heading', { level: 1 }))
    expect(frame).toContainElement(section(text('readFirst')))
    // The Explore navigation lives in the sidebar: the page itself renders no navigation.
    expect(screen.queryByRole('navigation')).toBeNull()
  })

  it('"Read these first": curated posts in one <ol>, in exactly the backend order by featured_rank', async () => {
    respond({ curated: [post(1), post(2), post(3)] })

    renderWithIntl(await StartHere(pageProps()))

    // Asks only for curated posts, once, wide enough for the whole ordered list (at most 50).
    expect(getPosts).toHaveBeenCalledTimes(1)
    expect(getPosts).toHaveBeenCalledWith({ page: 0, size: 50, featured: true, language: 'vi' })

    const list = section(text('readFirst')).querySelector('ol')!
    const rows = Array.from(list.children) as HTMLElement[]
    expect(rows.map((li) => within(li).getByRole('heading', { level: 3 }).textContent)).toEqual([
      'Chosen post number 1',
      'Chosen post number 2',
      'Chosen post number 3',
    ])
  })

  it('ordinal numbers 01, 02... by position in the list, hidden from screen readers', async () => {
    // The rank has gaps (unselecting a post leaves a gap): the displayed number stays contiguous, because the <ol> already carries
    // the order for screen readers and the number is only a mark for the eyes.
    respond({ curated: [post(1), post(2, { featuredRank: 4 }), post(3, { featuredRank: null })] })

    renderWithIntl(await StartHere(pageProps()))

    const rows = Array.from(section(text('readFirst')).querySelector('ol')!.children) as HTMLElement[]
    rows.forEach((li, i) => {
      const numeral = within(li).getByText(String(i + 1).padStart(2, '0'))
      expect(numeral).toHaveAttribute('aria-hidden', 'true')
    })
  })

  it('a post in a series keeps the series kicker next to the ordinal number', async () => {
    respond({
      curated: [
        post(1, {
          series: { id: 's1', slug: 'series-a', title: 'Series A', position: 2, partNumber: 2, partCount: 3 },
        }),
        post(2),
      ],
    })

    renderWithIntl(await StartHere(pageProps()))

    const [inSeries, alone] = Array.from(section(text('readFirst')).querySelector('ol')!.children) as HTMLElement[]
    expect(within(inSeries!).getByRole('link', { name: 'Series A' })).toHaveAttribute('href', '/series/series-a')
    expect(inSeries!.textContent).toContain(msg('Site.listing.partLabel', { number: '2', total: '3' }))
    // A standalone post: only the ordinal number, no series link.
    expect(alone!.querySelector('a[href^="/series/"]')).toBeNull()
    expect(within(alone!).getByText('02')).toBeInTheDocument()
  })

  it('"Read by series": name (link), description, "n parts · m min read", the parts in order', async () => {
    respond()

    renderWithIntl(await StartHere(pageProps()))
    const block = section(text('bySeries'))

    const name = within(block).getByRole('heading', { level: 3, name: 'Series A' })
    expect(within(name).getByRole('link')).toHaveAttribute('href', '/series/series-a')
    expect(block.textContent).toContain(SERIES.description)
    expect(block.textContent).toContain(
      `${msg('Site.listing.seriesMeta.parts', { count: 3 })} · ${msg('Site.article.readingTime', { minutes: '24' })}`,
    )
    const parts = within(block.querySelector('ol')!).getAllByRole('link')
    expect(parts.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['The first build', '/posts/phan-dau'],
      ['Server component', '/posts/phan-giua'],
      ['Writing with the agent', '/posts/phan-cuoi'],
    ])
  })

  it('"Read by series": a row like /series, cover art on the right, EVERY part even when the series is longer than five parts', async () => {
    const parts = Array.from({ length: 7 }, (_, i) => ({ slug: `dai-${i + 1}`, title: `Long part ${i + 1}` }))
    respond({ series: [{ ...SERIES, postCount: 7, parts }] })

    renderWithIntl(await StartHere(pageProps()))
    const block = section(text('bySeries'))

    // Text on the left, image on the right like "Read these first" right above: no longer a narrow text column pushed to the left.
    // The thumbnail is a link with the same href, hidden from the accessibility tree: the series name is still the only accessible link.
    const thumb = block.querySelector('svg.cover-art')!.closest('a')!
    expect(thumb).toHaveAttribute('href', '/series/series-a')
    expect(thumb).toHaveAttribute('aria-hidden', 'true')
    expect(within(block).getAllByRole('link', { name: 'Series A' })).toHaveLength(1)
    // h3 sized like the post title of "Read these first" (ListRow h3), not as large as the section h2 from 640px.
    expect(within(block).getByRole('heading', { level: 3, name: 'Series A' })).not.toHaveClass('sm:text-xl')
    // A page for newcomers: all seven parts, not cut at five like /series.
    expect(block.querySelectorAll('ol > li')).toHaveLength(7)
    // The parts after the third are folded below sm only: they stay in the markup (7 items above) and the "+4 parts" link is the phone-only exit.
    const folded = Array.from(block.querySelectorAll('ol > li')).map((li) => li.classList.contains('max-sm:hidden'))
    expect(folded).toEqual([false, false, false, true, true, true, true])
    const more = within(block).getByRole('link', {
      name: (name) => name.includes(msg('Site.listing.seriesEntry.moreParts', { count: 4 })),
    })
    expect(more.parentElement).toHaveClass('sm:hidden')
  })

  it('"By category": post count per category, with " posts" for screen readers, categories with 0 posts dropped', async () => {
    respond()

    renderWithIntl(await StartHere(pageProps()))
    const block = section(text('byCategory'))

    // Two "Architecture" posts, one "How I work" post, counted from the published posts.
    const kienTruc = within(block).getByRole('link', { name: `Architecture 2 ${text('postsUnit', { count: 2 })}` })
    expect(kienTruc).toHaveAttribute('href', '/categories/kien-truc')
    expect(within(block).getByRole('link', { name: `How I work 1 ${text('postsUnit', { count: 1 })}` })).toHaveAttribute(
      'href',
      '/categories/cach-toi-lam-viec',
    )
    // " posts" is for screen readers only; the eyes see the number.
    expect(within(kienTruc).getByText(text('postsUnit', { count: 2 }), { exact: false })).toHaveClass('sr-only')
    // Underlined like the series part links on the same page (INLINE_LINK): previously only the other kind was.
    expect(kienTruc).toHaveClass('underline', 'underline-offset-4')
    // The description is shown when there is one.
    expect(block.textContent).toContain('Systems and trade-offs.')
    // A grid, not one column: category names are short, and one column leaves most of the frame width empty.
    expect(kienTruc.closest('ul')).toHaveClass('grid', 'sm:grid-cols-2', 'lg:grid-cols-3')
    // A category with no posts is not an invitation to read.
    expect(within(block).queryByRole('link', { name: /No posts yet/ })).toBeNull()
  })

  it('the closing sentence says the list is chosen by the site owner, not based on views', async () => {
    respond()

    renderWithIntl(await StartHere(pageProps()))

    expect(screen.getByText(text('closing'))).toBeInTheDocument()
  })

  it('no curated posts here but some in the other language: the fallback link replaces the notice', async () => {
    respond({ curated: [] })
    vi.mocked(getPosts).mockImplementation(async ({ page, size, language }) => ({
      items: [],
      meta: { page, size, totalElements: language === 'en' ? 2 : 0, totalPages: 0 },
    }))

    renderWithIntl(await StartHere(pageProps()))

    expect(screen.getByRole('link', { name: msg('Site.languageFallback.link', { language: 'English' }) })).toHaveAttribute(
      'href',
      '/en/start-here',
    )
    expect(screen.queryByText(text('empty'))).toBeNull()
    expect(getSeriesList).toHaveBeenCalledWith('vi')
  })

  it('no curated posts: a notice and a link to /writing, no closing sentence, no JSON-LD', async () => {
    respond({ curated: [] })

    const { container } = renderWithIntl(await StartHere(pageProps()))

    expect(screen.getByText(text('empty'))).toBeInTheDocument()
    expect(screen.getByRole('link', { name: text('allPosts') })).toHaveAttribute('href', '/writing')
    expect(screen.queryByText(text('closing'))).toBeNull()
    expect(jsonLd(container)).toEqual([])
    // The secondary blocks still show: series and categories are still entry points for newcomers.
    expect(screen.getByRole('heading', { level: 2, name: text('bySeries') })).toBeInTheDocument()
  })

  it('a failing curated list makes the page throw (500), like /writing, and does not become the empty notice', async () => {
    const boom = new Error('featured down')
    respond()
    vi.mocked(getPosts).mockRejectedValue(boom)

    const thrown = await StartHere(pageProps()).then(
      () => null,
      (error: unknown) => error,
    )
    expect(thrown).toBe(boom)
  })

  it('a failing series list only hides the series block', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    respond()
    vi.mocked(getSeriesList).mockRejectedValue(new Error('series down'))

    renderWithIntl(await StartHere(pageProps()))

    expect(screen.queryByRole('heading', { name: text('bySeries') })).toBeNull()
    expect(screen.getByRole('heading', { level: 2, name: text('readFirst') })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: text('byCategory') })).toBeInTheDocument()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('series down'))
  })

  it('failing category counts (post list or category list) only hide the category block', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    respond()
    vi.mocked(fetchAllPublishedPosts).mockRejectedValue(new Error('posts down'))
    const first = renderWithIntl(await StartHere(pageProps()))
    expect(screen.queryByRole('heading', { name: text('byCategory') })).toBeNull()
    expect(screen.getByRole('heading', { level: 2, name: text('bySeries') })).toBeInTheDocument()
    first.unmount()

    respond()
    vi.mocked(getCategories).mockRejectedValue(new Error('categories down'))
    renderWithIntl(await StartHere(pageProps()))
    expect(screen.queryByRole('heading', { name: text('byCategory') })).toBeNull()
    expect(screen.getByRole('heading', { level: 2, name: text('readFirst') })).toBeInTheDocument()

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('posts down'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('categories down'))
  })

  it('an empty secondary block leaves no orphan heading', async () => {
    respond({ series: [], all: [] })

    renderWithIntl(await StartHere(pageProps()))

    expect(screen.queryByRole('heading', { name: text('bySeries') })).toBeNull()
    expect(screen.queryByRole('heading', { name: text('byCategory') })).toBeNull()
    expect(screen.getByRole('heading', { level: 2, name: text('readFirst') })).toBeInTheDocument()
  })

  it('JSON-LD: CollectionPage with an ItemList of the curated posts in exactly the right order', async () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://blog.example.com')
    respond({ curated: [post(2), post(1)] })

    const { container } = renderWithIntl(await StartHere(pageProps()))
    const [collection] = jsonLd(container)

    expect(collection).toMatchObject({
      '@type': 'CollectionPage',
      name: text('title'),
      url: 'https://blog.example.com/start-here',
    })
    const list = collection!.mainEntity as { '@type': string; itemListElement: { position: number; url: string }[] }
    expect(list['@type']).toBe('ItemList')
    expect(list.itemListElement.map((i) => [i.position, i.url])).toEqual([
      [1, 'https://blog.example.com/posts/bai-chon-2'],
      [2, 'https://blog.example.com/posts/bai-chon-1'],
    ])
  })

  it('the heading outline goes down without skipping a level', async () => {
    respond()

    const { container } = renderWithIntl(await StartHere(pageProps()))
    const levels = [...container.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => Number(h.tagName[1]))

    expect(levels[0]).toBe(1)
    levels.forEach((level, i) => {
      if (i === 0) return
      expect(level - levels[i - 1]!, `heading ${i}: h${levels[i - 1]} → h${level}`).toBeLessThanOrEqual(1)
    })
  })

  it('renders per request: the Docker build has no API, so the page must not be prerendered', () => {
    expect(dynamic).toBe('force-dynamic')
  })

  it('metadata through pageMetadata: canonical /start-here, og:url equals the canonical', async () => {
    const metadata = await generateMetadata(pageProps())

    expect(metadata.title).toBe(text('title'))
    expect(metadata.alternates?.canonical).toBe('/start-here')
    expect(metadata.openGraph?.url).toBe('/start-here')
    expect(metadata.openGraph?.siteName).toBe(site.name)
    expect(metadata.description).toContain(site.name)
  })
})

describe('/start-here in English', () => {
  it('shows the English copy and links the empty notice to the English writing page', async () => {
    respond({ curated: [] })

    renderWithIntl(await StartHere(pageProps('en')), { locale: 'en' })

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(msg('Site.startHere.title', undefined, 'en'))
    expect(screen.getByText(msg('Site.startHere.eyebrow', undefined, 'en'))).toBeInTheDocument()
    expect(screen.getByText(msg('Site.startHere.empty', undefined, 'en'))).toBeInTheDocument()
    expect(screen.getByRole('link', { name: msg('Site.startHere.allPosts', undefined, 'en') })).toHaveAttribute(
      'href',
      '/en/writing',
    )
    expect(screen.queryByText(msg('Site.startHere.closing', undefined, 'vi'))).toBeNull()
  })

  it('counts categories with the English plural for screen readers and titles the metadata in English', async () => {
    respond()

    renderWithIntl(await StartHere(pageProps('en')), { locale: 'en' })

    expect(screen.getByRole('link', { name: 'Architecture 2 posts' })).toHaveAttribute('href', '/en/categories/kien-truc')
    expect(screen.getByRole('link', { name: 'How I work 1 post' })).toBeInTheDocument()
    expect((await generateMetadata(pageProps('en'))).title).toBe(msg('Site.startHere.title', undefined, 'en'))
  })
})
