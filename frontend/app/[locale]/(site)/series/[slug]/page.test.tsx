import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultSiteContent } from '@/content/defaults'
import { TEST_LOCALE } from '@/test/intl'
import { ApiError, NotFoundError } from '@/lib/api'
import { getSeries, getSeriesList } from '@/lib/series'
import type { PostSummary, SeriesDetail, SeriesSummary } from '@/lib/types'
import { routeDir } from '@/test/routes'
import SeriesPage, { generateMetadata } from './page'
import { DEBUG_SLUG } from '@/test/fixtures/vi/category-feed'
import { ALL_SERIES_LINK } from '@/test/fixtures/vi/series-removed'
import { msg } from '@/test/render-intl'
import { PHONE_BUTTON, PHONE_PRIMARY } from '@/components/site/SectionHeading'

// The sidebar frame is tested once (BrowseFrame.test.tsx); here a stand-in records what the page asked for.
vi.mock('@/components/site/BrowseFrame', () => import('@/test/browse-frame-mock'))

const { site } = defaultSiteContent(TEST_LOCALE)

/**
 * Like the archive pages: `SeriesPage` is an async function called directly, and the tree it returns is
 * rendered with RTL. `notFound()` is the real one from next/navigation, so a 404 is recognized by its
 * `digest` and not by a stub having been called.
 *
 * Only lib/series is mocked: the page uses the REAL NotFoundError of lib/api to tell 404 apart from other
 * errors, and lib/fetch-json throws exactly that class (a same-named class in another module makes `instanceof`
 * silently wrong, and the page returns 500 instead of 404).
 */
vi.mock('@/lib/series', () => ({ getSeries: vi.fn(), getSeriesList: vi.fn() }))

const SLUG = 'series-a'

const part = (n: number, extra: Partial<PostSummary> = {}): PostSummary => ({
  id: `p${n}`,
  // The title does not contain the word "Part": if it did, the "Part i" kicker assertion below would be green because of
  // the title and not because of the kicker.
  title: `Post title number ${n}`,
  slug: `bai-so-${n}`,
  excerpt: null,
  status: 'PUBLISHED',
  category: { id: 'c1', name: 'Architecture', slug: 'kien-truc', description: null },
  tags: [],
  publishedAt: '2026-10-03T08:00:00Z',
  featured: false,
  readingMinutes: n + 4,
  series: { id: 's1', slug: SLUG, title: 'Series A', position: n, partNumber: n, partCount: 3 },
  ...extra,
})

const DETAIL: SeriesDetail = {
  id: 's1',
  title: 'Series A',
  slug: SLUG,
  description: 'From the first build to writing together with a coding agent.',
  // The reading order is decided by the backend (series_position); the page keeps it, it does not re-sort by date.
  posts: [part(1), part(2), part(3)],
}

const summary = (n: number, extra: Partial<SeriesSummary> = {}): SeriesSummary => ({
  id: `s${n}`,
  title: `Series number ${n}`,
  slug: `series-so-${n}`,
  description: null,
  postCount: 2,
  readingMinutes: 11,
  latestPublishedAt: '2026-10-03T08:00:00Z',
  parts: [
    { slug: `s${n}-a`, title: 'A' },
    { slug: `s${n}-b`, title: 'B' },
  ],
  ...extra,
})

function props(slug: string): PageProps<'/[locale]/series/[slug]'> {
  return { params: Promise.resolve({ locale: 'vi', slug }), searchParams: Promise.resolve({ locale: 'vi' }) }
}

function respond(detail: SeriesDetail = DETAIL, list: SeriesSummary[] = []) {
  vi.mocked(getSeries).mockResolvedValue(detail)
  vi.mocked(getSeriesList).mockResolvedValue(list)
}

async function settle(pageProps: PageProps<'/[locale]/series/[slug]'>): Promise<unknown> {
  return SeriesPage(pageProps).then(
    () => null,
    (error: unknown) => error,
  )
}

/** The parts of the series: the content `<ol>`, not the breadcrumb `<ol>` inside `<nav>`. */
function partItems(container: HTMLElement): HTMLElement[] {
  const list = [...container.querySelectorAll('ol')].find((ol) => ol.closest('nav') === null)
  return list ? (Array.from(list.children) as HTMLElement[]) : []
}

/** The JSON-LD blocks on the page, parsed, in document order. */
function jsonLd(container: HTMLElement): Record<string, unknown>[] {
  return Array.from(container.querySelectorAll('script[type="application/ld+json"]')).map(
    (script) => JSON.parse(script.textContent ?? '') as Record<string, unknown>,
  )
}

afterEach(() => {
  vi.mocked(getSeries).mockReset()
  vi.mocked(getSeriesList).mockReset()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('/series/[slug]', () => {
  it('page top: breadcrumb "Writing" / "Series", h1 series name, description as the lead, meta and the way into part 1', async () => {
    respond()

    const { container } = render(await SeriesPage(props(SLUG)))

    expect(getSeries).toHaveBeenCalledWith(SLUG, 'vi')
    // The visible breadcrumb replaces the old "← All series" link: "Series" is itself the link to every series.
    const crumbs = within(screen.getByRole('navigation', { name: msg('Site.breadcrumb.label') })).getAllByRole('link')
    expect(crumbs.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      [msg('Site.footer.links.writing'), '/writing'],
      ['Series', '/series'],
    ])
    expect(screen.queryByRole('link', { name: ALL_SERIES_LINK })).toBeNull()
    expect(container.querySelectorAll('h1')).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Series A')
    expect(screen.getByText(DETAIL.description!)).toBeInTheDocument()
    // Three parts, 5 + 6 + 7 minutes: the number is computed from the parts actually shown, not invented.
    expect(container.textContent).toContain(
      `${msg('Site.listing.seriesMeta.parts', { count: 3 })} · ${msg('Site.article.readingTime', { minutes: '18' })}`,
    )
    // "Start at part 1" points to the part first in reading order. The arrow is aria-hidden so the
    // accessible name is the text label.
    expect(screen.getByRole('link', { name: msg('Site.series.startAtPart1') })).toHaveAttribute('href', '/posts/bai-so-1')
    // No second <main>: app/layout.tsx holds the only one.
    expect(container.querySelector('main')).toBeNull()
  })

  it('on a phone "Start at part 1" is a 44px filled button; from sm it is the underlined text link of before', async () => {
    respond()

    render(await SeriesPage(props(SLUG)))

    const start = screen.getByRole('link', { name: msg('Site.series.startAtPart1') })
    // The shared phone button recipe (SectionHeading.tsx), filled; the underline of the text link stays for sm and up.
    expect(start.className).toContain(PHONE_BUTTON)
    expect(start.className).toContain(PHONE_PRIMARY)
    expect(start).toHaveClass('max-sm:h-11', 'max-sm:bg-neutral-900', 'max-sm:text-white', 'underline')
  })

  it('the title leads at 1.2 on a phone, the lead is 17px, and the rows of the parts are 20px padded (24px from sm)', async () => {
    respond()

    const { container } = render(await SeriesPage(props(SLUG)))

    expect(screen.getByRole('heading', { level: 1 })).toHaveClass('leading-[1.2]', 'sm:leading-10')
    expect(screen.getByText(DETAIL.description!)).toHaveClass('text-[1.0625rem]', 'leading-relaxed', 'sm:text-lg', 'sm:leading-7')
    for (const row of Array.from(container.querySelector('ol.border-t')!.children)) expect(row).toHaveClass('py-5', 'sm:py-6')
  })

  it('"Other series" rows are hairline-separated 44px title rows on a phone', async () => {
    respond(DETAIL, [summary(1), summary(2)])

    render(await SeriesPage(props(SLUG)))

    const list = screen.getByRole('link', { name: 'Series number 1' }).closest('ul')!
    expect(list).toHaveClass('divide-y', 'sm:divide-y-0', 'sm:space-y-4')
    expect(screen.getByRole('link', { name: 'Series number 1' })).toHaveClass('max-sm:inline-block', 'max-sm:py-2.5')
  })

  it('the whole page sits in the frame with Series as a parent row (aria-current=true): header, parts and "Other series"', async () => {
    respond(DETAIL, [summary(1)])

    const { container } = render(await SeriesPage(props(SLUG)))

    const frame = screen.getByTestId('browse-frame')
    expect(frame).toHaveAttribute('data-current', 'series')
    expect(frame).toHaveAttribute('data-exact', 'false')
    expect(frame).toContainElement(screen.getByRole('heading', { level: 1 }))
    expect(frame).toContainElement(container.querySelector('ol'))
    expect(frame).toContainElement(screen.getByRole('region', { name: msg('Site.series.otherSeries') }))
  })

  it('lists the parts in one <ol> in exactly the backend order, each part a ListRow h2 with the "Part i" kicker', async () => {
    // Publish dates are the reverse of the reading order: if the page sorted by date by mistake, part 3 would come first.
    respond({
      ...DETAIL,
      posts: [
        part(1, { publishedAt: '2026-10-03T08:00:00Z' }),
        part(2, { publishedAt: '2026-10-01T08:00:00Z' }),
        part(3, { publishedAt: '2026-09-01T08:00:00Z' }),
      ],
    })

    const { container } = render(await SeriesPage(props(SLUG)))

    const items = partItems(container)
    expect(items).toHaveLength(3)
    items.forEach((item, i) => {
      const heading = within(item).getByRole('heading', { level: 2 })
      expect(heading).toHaveTextContent(`Post title number ${i + 1}`)
      // Exact match: the kicker is exactly "Part i", not the "Part i/m" of the series kicker.
      expect(within(item).getByText(msg('Site.series.part', { number: i + 1 }))).toBeInTheDocument()
    })

    // The "Part i" kicker REPLACES the default series kicker: on the series page itself, the series name link on
    // each row would only point back to the page being read.
    expect(items.some((item) => item.querySelector(`a[href="/series/${SLUG}"]`) !== null)).toBe(false)
    // Pair of the "yes" assertion: the title of each part is still a link to the post.
    expect(screen.getByRole('link', { name: 'Post title number 2' })).toHaveAttribute('href', '/posts/bai-so-2')
  })

  it('404 when the backend says there is no such series (NotFoundError)', async () => {
    vi.mocked(getSeries).mockRejectedValue(new NotFoundError('SERIES_NOT_FOUND', 'Series not found'))
    vi.mocked(getSeriesList).mockResolvedValue([])

    const thrown = await settle(props('khong-ton-tai'))

    expect(thrown, 'the page rendered instead of calling notFound()').not.toBeNull()
    expect((thrown as { digest?: string }).digest).toBe('NEXT_HTTP_ERROR_FALLBACK;404')
  })

  it('404 even when the backend returns a series with no published part', async () => {
    // The backend promises to return 404 for this case. If some backend version returned 200
    // with an empty list, the page must still not become an empty series page with HTTP 200.
    respond({ ...DETAIL, posts: [] })

    const thrown = await settle(props(SLUG))

    expect((thrown as { digest?: string } | null)?.digest).toBe('NEXT_HTTP_ERROR_FALLBACK;404')
  })

  it('a series that only has parts in the other language shows the fallback link, not a 404', async () => {
    vi.mocked(getSeriesList).mockResolvedValue([])
    vi.mocked(getSeries).mockImplementation(async (_slug, language) => ({
      ...DETAIL,
      posts: language === 'en' ? DETAIL.posts : [],
    }))

    render(await SeriesPage(props(SLUG)))

    expect(screen.getByRole('heading', { level: 1, name: DETAIL.title })).toBeInTheDocument()
    const link = screen.getByRole('link', { name: msg('Site.languageFallback.link', { language: 'English' }) })
    expect(link).toHaveAttribute('href', `/en/series/${SLUG}`)
    // The fallback is inside the frame too, with the same current row as the full page.
    const frame = screen.getByTestId('browse-frame')
    expect(frame).toContainElement(link)
    expect(frame).toHaveAttribute('data-current', 'series')
    expect(frame).toHaveAttribute('data-exact', 'false')
  })

  it('any other backend error is 500, never 404', async () => {
    // 404s get cached; if "could not ask" returned 404, one backend hiccup would make every
    // series page vanish from the index.
    const boom = new ApiError(503, 'UNAVAILABLE', 'down')
    vi.mocked(getSeries).mockRejectedValue(boom)
    vi.mocked(getSeriesList).mockResolvedValue([])

    const thrown = await settle(props(SLUG))

    expect(thrown).toBe(boom)
    expect((thrown as { digest?: string }).digest).toBeUndefined()
  })

  it('decodes a percent-encoded slug and normalizes to NFC before asking the backend', async () => {
    respond({ ...DETAIL, slug: DEBUG_SLUG })

    await SeriesPage(props(encodeURIComponent(DEBUG_SLUG.normalize('NFD'))))

    expect(getSeries).toHaveBeenCalledWith(DEBUG_SLUG.normalize('NFC'), 'vi')
  })

  it('"More series": at most 5, never containing the series being viewed', async () => {
    respond(DETAIL, [
      summary(1),
      summary(2),
      { ...summary(3), slug: SLUG, title: 'Series A' },
      summary(4),
      summary(5),
      summary(6),
      summary(7),
    ])

    render(await SeriesPage(props(SLUG)))

    const heading = screen.getByRole('heading', { level: 2, name: msg('Site.series.otherSeries') })
    const section = heading.closest('section') as HTMLElement
    const links = within(section).getAllByRole('link')
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/series/series-so-1',
      '/series/series-so-2',
      '/series/series-so-4',
      '/series/series-so-5',
      '/series/series-so-6',
    ])
    expect(within(section).queryByRole('link', { name: 'Series A' })).toBeNull()
    expect(section.textContent).toContain(
      `${msg('Site.listing.seriesMeta.parts', { count: 2 })} · ${msg('Site.article.readingTime', { minutes: '11' })}`,
    )
  })

  it('with no other series there is no "More series" block', async () => {
    respond(DETAIL, [{ ...summary(1), slug: SLUG }])

    render(await SeriesPage(props(SLUG)))

    expect(screen.queryByRole('heading', { name: msg('Site.series.otherSeries') })).toBeNull()
    // Pair of the "yes" assertion: the main part is still complete.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Series A')
  })

  it('a failing series list only hides "More series", the page still renders', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(getSeries).mockResolvedValue(DETAIL)
    vi.mocked(getSeriesList).mockRejectedValue(new Error('series list down'))

    const { container } = render(await SeriesPage(props(SLUG)))

    expect(screen.queryByRole('heading', { name: msg('Site.series.otherSeries') })).toBeNull()
    expect(partItems(container)).toHaveLength(3)
    // A block hidden silently means nobody sees the API incident: one log line says why.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('series list down'))
  })

  it('JSON-LD: CollectionPage with an ItemList of the parts in the right order, and a BreadcrumbList "Writing" › "Series" › name', async () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://blog.example.com')
    respond()

    const { container } = render(await SeriesPage(props(SLUG)))
    const blocks = jsonLd(container)

    // name and description are exactly the og:title and meta description of the page (seriesHead).
    const collection = blocks.find((b) => b['@type'] === 'CollectionPage')
    expect(collection).toMatchObject({
      name: msg('Site.series.pageTitle', { title: 'Series A' }),
      description: DETAIL.description,
      url: `https://blog.example.com/series/${SLUG}`,
    })
    const metadata = await generateMetadata(props(SLUG))
    expect(collection!.name).toBe(metadata.openGraph?.title)
    expect(collection!.description).toBe(metadata.description)
    const list = collection!.mainEntity as { '@type': string; itemListElement: { position: number; url: string }[] }
    expect(list['@type']).toBe('ItemList')
    expect(list.itemListElement.map((item) => [item.position, item.url])).toEqual([
      [1, 'https://blog.example.com/posts/bai-so-1'],
      [2, 'https://blog.example.com/posts/bai-so-2'],
      [3, 'https://blog.example.com/posts/bai-so-3'],
    ])

    const breadcrumb = blocks.find((b) => b['@type'] === 'BreadcrumbList')
    expect((breadcrumb!.itemListElement as { name: string; item: string }[]).map((i) => [i.name, i.item])).toEqual([
      [msg('Site.footer.links.writing'), 'https://blog.example.com/writing'],
      ['Series', 'https://blog.example.com/series'],
      ['Series A', `https://blog.example.com/series/${SLUG}`],
    ])

    // The BreadcrumbList describes the path the page really shows: every step except the last (the series itself, already the
    // h1) is a link of the visible breadcrumb, same name, same target.
    const visible = within(screen.getByRole('navigation', { name: msg('Site.breadcrumb.label') }))
      .getAllByRole('link')
      .map((a) => [a.textContent, new URL(a.getAttribute('href')!, 'https://blog.example.com').href])
    expect((breadcrumb!.itemListElement as { name: string; item: string }[]).slice(0, -1).map((i) => [i.name, i.item])).toEqual(
      visible,
    )
  })

  it('the heading outline goes down without skipping a level', async () => {
    respond(DETAIL, [summary(1)])

    const { container } = render(await SeriesPage(props(SLUG)))
    const levels = [...container.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => Number(h.tagName[1]))

    expect(levels[0]).toBe(1)
    expect(levels.filter((l) => l === 1)).toHaveLength(1)
    levels.forEach((level, i) => {
      if (i === 0) return
      expect(level - levels[i - 1]!, `heading ${i}: h${levels[i - 1]} → h${level}`).toBeLessThanOrEqual(1)
    })
  })

  it('there is no loading.tsx in the three new routes, so notFound() is still HTTP 404', () => {
    // Like writing/page.test.tsx: loading.tsx turns the route into a streamed shell, and status 200 is
    // sent before the page body calls notFound(). Every 404 rule above would be green here and wrong at run time.
    const appDir = join(process.cwd(), 'app')
    for (const route of ['/start-here', '/series', '/series/[slug]']) {
      const dir = routeDir(appDir, route)
      expect(dir, `no route serves ${route}`).toBeDefined()
      for (const file of ['loading.tsx', 'loading.ts', 'loading.jsx', 'loading.js']) {
        expect(existsSync(join(dir as string, file)), `${route}/${file}`).toBe(false)
      }
    }
  })

  describe('generateMetadata', () => {
    it('canonical is the slug the backend stores, og:url equals the canonical, the title names the series', async () => {
      vi.mocked(getSeries).mockResolvedValue(DETAIL)

      const m = await generateMetadata(props(SLUG))

      expect(m.alternates?.canonical).toBe(`/series/${SLUG}`)
      expect(m.openGraph?.url).toBe(m.alternates?.canonical)
      expect(m.title).toBe(msg('Site.series.pageTitle', { title: 'Series A' }))
      expect(m.description).toBe(DETAIL.description)
    })

    it('a series with no description still has a description', async () => {
      vi.mocked(getSeries).mockResolvedValue({ ...DETAIL, description: null })

      const m = await generateMetadata(props(SLUG))

      expect(m.description).toBe(msg('Site.series.defaultDescription', { title: 'Series A' }))
    })

    it('promotes the series own feed next to the general feed', async () => {
      vi.mocked(getSeries).mockResolvedValue(DETAIL)

      expect((await generateMetadata(props(SLUG))).alternates?.types).toEqual({
        'application/rss+xml': [
          { url: '/feed.xml', title: site.name },
          { url: `/series/${SLUG}/feed.xml`, title: `Series A — ${site.name}` },
        ],
      })
    })

    it('does not throw on an unknown slug or an API failure: the page body returns the 404/500 itself', async () => {
      vi.mocked(getSeries).mockRejectedValue(new NotFoundError('SERIES_NOT_FOUND', 'x'))
      expect(await generateMetadata(props('khong-ton-tai'))).toEqual({ title: msg('Site.series.notFoundTitle') })

      vi.mocked(getSeries).mockRejectedValue(new Error('down'))
      expect(await generateMetadata(props(SLUG))).toEqual({ title: msg('Site.series.notFoundTitle') })
    })
  })
})
