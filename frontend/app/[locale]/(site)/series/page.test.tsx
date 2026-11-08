import { render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSeriesList } from '@/lib/series'
import type { SeriesSummary } from '@/lib/types'
import SeriesIndex, { generateMetadata } from './page'
import { UPDATED_DATE_TEXT } from '@/test/fixtures/vi/series-removed'
import { msg } from '@/test/render-intl'

// The sidebar frame is tested once (BrowseFrame.test.tsx); here a stand-in records what the page asked for.
vi.mock('@/components/site/BrowseFrame', () => import('@/test/browse-frame-mock'))

/**
 * Same approach as writing/page.test.tsx: call the async page function directly and render the tree it returns;
 * `notFound()` is the real one, recognized by its `digest`.
 *
 * The backend returns the WHOLE series list at once (no pagination), so the page cuts 20
 * series per page itself and decides itself which pages do not exist.
 */
vi.mock('@/lib/series', () => ({ getSeriesList: vi.fn(), getSeries: vi.fn() }))

const parts = (slug: string, count: number) =>
  Array.from({ length: count }, (_, i) => ({ slug: `${slug}-phan-${i + 1}`, title: `Post ${i + 1} of ${slug}` }))

const series = (n: number, extra: Partial<SeriesSummary> = {}): SeriesSummary => ({
  id: `s${n}`,
  title: `Series number ${n}`,
  slug: `series-so-${n}`,
  description: null,
  postCount: 2,
  readingMinutes: 13,
  latestPublishedAt: '2026-10-03T18:23:29.838073Z',
  parts: parts(`series-so-${n}`, 2),
  ...extra,
})

function props(searchParams: Record<string, string | string[] | undefined> = {}): PageProps<'/[locale]/series'> {
  return { params: Promise.resolve({ locale: 'vi' }), searchParams: Promise.resolve(searchParams) }
}

async function expectNotFound(pageProps: PageProps<'/[locale]/series'>, why: string) {
  const thrown = await SeriesIndex(pageProps).then(
    () => null,
    (error: unknown) => error,
  )
  expect(thrown, `${why}: the page rendered instead of calling notFound()`).not.toBeNull()
  expect((thrown as { digest?: string }).digest, why).toBe('NEXT_HTTP_ERROR_FALLBACK;404')
}

/** The series entries on the page, in document order. */
const entries = (container: HTMLElement) => Array.from(container.querySelectorAll('article')) as HTMLElement[]

type ItemListBlock = {
  '@type': string
  name: string
  description?: string
  url: string
  mainEntity: { '@type': string; itemListElement: { position: number; name: string; url: string }[] }
}

/** The JSON-LD blocks on the page, parsed, in document order. */
function jsonLd(container: HTMLElement): ItemListBlock[] {
  return Array.from(container.querySelectorAll('script[type="application/ld+json"]')).map(
    (script) => JSON.parse(script.textContent ?? '') as ItemListBlock,
  )
}

afterEach(() => {
  vi.mocked(getSeriesList).mockReset()
  vi.unstubAllEnvs()
})

describe('/series', () => {
  it('asks for the series of the page language and offers the other language when only that one has series', async () => {
    vi.mocked(getSeriesList).mockImplementation(async (language) => (language === 'en' ? [series(1)] : []))

    render(await SeriesIndex(props()))

    expect(getSeriesList).toHaveBeenCalledWith('vi')
    expect(screen.getByRole('link', { name: msg('Site.languageFallback.link', { language: 'English' }) })).toHaveAttribute(
      'href',
      '/en/series',
    )
    expect(screen.queryByText(msg('Site.series.empty'))).not.toBeInTheDocument()
  })

  it('h1 "Series" inside the frame with Series as the current Explore row (the own page: aria-current=page), no section row of its own', async () => {
    vi.mocked(getSeriesList).mockResolvedValue([series(1)])

    const { container } = render(await SeriesIndex(props()))

    expect(container.querySelectorAll('h1')).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Series')
    const frame = screen.getByTestId('browse-frame')
    expect(frame).toHaveAttribute('data-current', 'series')
    expect(frame).toHaveAttribute('data-exact', 'true')
    expect(frame).toContainElement(screen.getByRole('heading', { level: 1 }))
    // The Explore navigation lives in the sidebar now: the page itself renders no navigation.
    expect(screen.queryByRole('navigation')).toBeNull()
    expect(container.querySelector('main')).toBeNull()
  })

  it('each series: h2 link to the series page, description, meta, the parts in order and the way into part 1', async () => {
    vi.mocked(getSeriesList).mockResolvedValue([
      series(1, {
        title: 'Series B',
        slug: 'series-b',
        description: 'Three posts in one series.',
        postCount: 3,
        readingMinutes: 27,
        parts: parts('pipeline', 3),
      }),
    ])

    const { container } = render(await SeriesIndex(props()))
    const [entry] = entries(container)

    const heading = within(entry!).getByRole('heading', { level: 2 })
    expect(within(heading).getByRole('link')).toHaveAttribute('href', '/series/series-b')
    expect(heading).toHaveTextContent('Series B')
    expect(entry!.textContent).toContain('Three posts in one series.')
    // Name and description share one cell (column 1, row 1): below 640px the description starts beside the thumbnail instead of
    // below it.
    const description = within(entry!).getByText('Three posts in one series.')
    expect(description.parentElement).toBe(heading.parentElement)
    expect(heading.parentElement).toHaveClass('col-start-1', 'row-start-1')
    // Dates are UTC like every date on the site: 18:23Z on the 3rd is already the 4th in the time zone vitest pins.
    expect(entry!.textContent).toContain(
      `${msg('Site.listing.seriesMeta.parts', { count: 3 })} · ${msg('Site.listing.seriesMeta.readingMinutes', { minutes: 27 })} · ${msg('Site.listing.seriesMeta.updated', { date: UPDATED_DATE_TEXT, time: (chunks: string) => chunks } as never)}`,
    )
    expect(entry!.querySelector('time')).toHaveAttribute('dateTime', '2026-10-03T18:23:29.838073Z')

    const listed = within(entry!.querySelector('ol')!).getAllByRole('link')
    expect(listed.map((a) => a.getAttribute('href'))).toEqual([
      '/posts/pipeline-phan-1',
      '/posts/pipeline-phan-2',
      '/posts/pipeline-phan-3',
    ])
    // Each series has a link with the same text "Start at part 1": the sr-only part says which series when
    // a screen reader lists links out of context. The arrow is aria-hidden.
    expect(
      within(entry!).getByRole('link', {
        name: `${msg('Site.listing.seriesEntry.startAtPartOne')} ${msg('Site.listing.seriesEntry.ofSeries', { title: 'Series B' })}`,
      }),
    ).toHaveAttribute('href', '/posts/pipeline-phan-1')
    // With three parts all three are shown: there is no "+k more parts".
    expect(entry!.textContent).not.toMatch(new RegExp(msg('Site.listing.seriesEntry.moreParts', { count: 3 }).replace('+3 ', '')))
  })

  it('a long series: the first 5 parts, then "+k more parts" leading to the series page', async () => {
    vi.mocked(getSeriesList).mockResolvedValue([series(1, { postCount: 8, parts: parts('dai', 8) })])

    const { container } = render(await SeriesIndex(props()))
    const [entry] = entries(container)

    expect(entry!.querySelectorAll('ol > li')).toHaveLength(5)
    expect(entry!.textContent).not.toContain('Post 6 of dai')
    const more = within(entry!).getByRole('link', {
      name: `${msg('Site.listing.seriesEntry.moreParts', { count: 3 })} ${msg('Site.listing.seriesEntry.ofSeries', { title: 'Series number 1' })}`,
    })
    expect(more).toHaveAttribute('href', '/series/series-so-1')
  })

  it('the thumbnail is the series cover art inside a link with the same href, hidden from the accessibility tree', async () => {
    vi.mocked(getSeriesList).mockResolvedValue([series(1)])

    const { container } = render(await SeriesIndex(props()))
    const [entry] = entries(container)

    const art = entry!.querySelector('svg.cover-art')
    expect(art).not.toBeNull()
    const thumb = art!.closest('a')!
    expect(thumb).toHaveAttribute('href', '/series/series-so-1')
    expect(thumb).toHaveAttribute('aria-hidden', 'true')
    expect(thumb).toHaveAttribute('tabindex', '-1')
    // The series name is the ONLY accessible link to the series page: the thumbnail link has no name.
    expect(within(entry!).getAllByRole('link', { name: 'Series number 1' })).toHaveLength(1)
  })

  it('keeps the backend order (newest post first), does not re-sort', async () => {
    vi.mocked(getSeriesList).mockResolvedValue([series(3), series(1), series(2)])

    const { container } = render(await SeriesIndex(props()))

    expect(entries(container).map((e) => e.querySelector('h2')?.textContent)).toEqual([
      'Series number 3',
      'Series number 1',
      'Series number 2',
    ])
  })

  it('empty is a 200 page "No series yet.", no pagination', async () => {
    vi.mocked(getSeriesList).mockResolvedValue([])

    const { container } = render(await SeriesIndex(props()))

    expect(screen.getByText(msg('Site.series.empty'))).toBeInTheDocument()
    expect(container.querySelector('article')).toBeNull()
    expect(screen.queryByRole('navigation', { name: msg('Site.pagination.label') })).toBeNull()
  })

  it('paginates 20 series per page', async () => {
    const all = Array.from({ length: 25 }, (_, i) => series(i + 1))
    vi.mocked(getSeriesList).mockResolvedValue(all)

    const first = render(await SeriesIndex(props()))
    expect(entries(first.container)).toHaveLength(20)
    expect(screen.getByText('Trang 1 / 2')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /sau/i })).toHaveAttribute('href', '/series?page=1')
    first.unmount()

    const second = render(await SeriesIndex(props({ page: '1' })))
    expect(entries(second.container).map((e) => e.querySelector('h2')?.textContent)).toEqual([
      'Series number 21',
      'Series number 22',
      'Series number 23',
      'Series number 24',
      'Series number 25',
    ])
  })

  it('404 for a page past the last page, and for ?page=1 when there is no series at all', async () => {
    vi.mocked(getSeriesList).mockResolvedValue(Array.from({ length: 25 }, (_, i) => series(i + 1)))
    await expectNotFound(props({ page: '2' }), '?page=2 of 2 pages')

    vi.mocked(getSeriesList).mockResolvedValue([])
    await expectNotFound(props({ page: '1' }), '?page=1 when empty')
  })

  it('404 for an absurd page number without asking the backend', async () => {
    vi.mocked(getSeriesList).mockResolvedValue([series(1)])

    for (const page of ['10001', '9999999999999999999999']) {
      await expectNotFound(props({ page }), `?page=${page}`)
    }
    expect(getSeriesList).not.toHaveBeenCalled()
  })

  it('?page that is not a run of digits is the first page', async () => {
    vi.mocked(getSeriesList).mockResolvedValue([series(1)])

    for (const page of ['abc', '-1', '1.5', '0x1', '']) {
      const { container, unmount } = render(await SeriesIndex(props({ page })))
      expect(entries(container), `?page=${page}`).toHaveLength(1)
      unmount()
    }
  })

  it('backend failure is 500: the series list is the main content, not a secondary block', async () => {
    // "No series yet." while the API is down is a green page that is wrong; only 500 tells the truth.
    const boom = new Error('series down')
    vi.mocked(getSeriesList).mockRejectedValue(boom)

    const thrown = await SeriesIndex(props()).then(
      () => null,
      (error: unknown) => error,
    )
    expect(thrown).toBe(boom)
  })

  describe('JSON-LD', () => {
    it('CollectionPage with an ItemList of the series in the order the page shows; name, description, url belong to the page itself', async () => {
      vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://blog.example.com')
      vi.mocked(getSeriesList).mockResolvedValue([series(3), series(1), series(2)])

      const { container } = render(await SeriesIndex(props()))
      const blocks = jsonLd(container)

      expect(blocks).toHaveLength(1)
      const [page] = blocks
      const metadata = await generateMetadata(props())
      expect(page).toMatchObject({
        '@type': 'CollectionPage',
        name: 'Series',
        description: metadata.description,
        url: 'https://blog.example.com/series',
      })
      expect(page!.mainEntity['@type']).toBe('ItemList')
      // Exactly the visible title links, in the same order: the list is the series, not the parts.
      const visible = entries(container).map((entry) => entry.querySelector('h2 a')!.getAttribute('href'))
      expect(page!.mainEntity.itemListElement.map((item) => [item.position, item.name, new URL(item.url).pathname])).toEqual([
        [1, 'Series number 3', visible[0]],
        [2, 'Series number 1', visible[1]],
        [3, 'Series number 2', visible[2]],
      ])
    })

    it('later page: canonical keeps the page number, and the numbering continues from the previous page (21...)', async () => {
      vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://blog.example.com')
      vi.mocked(getSeriesList).mockResolvedValue(Array.from({ length: 25 }, (_, i) => series(i + 1)))

      const { container } = render(await SeriesIndex(props({ page: '1' })))
      const [page] = jsonLd(container)

      expect(page!.url).toBe('https://blog.example.com/series?page=1')
      expect(page!.mainEntity.itemListElement.map((item) => item.position)).toEqual([21, 22, 23, 24, 25])
      expect(page!.mainEntity.itemListElement[0]!.name).toBe('Series number 21')
    })

    it('no series yet: no JSON-LD (an empty ItemList is a false claim)', async () => {
      vi.mocked(getSeriesList).mockResolvedValue([])

      const { container } = render(await SeriesIndex(props()))

      expect(jsonLd(container)).toEqual([])
    })
  })

  it('the heading outline goes down without skipping a level', async () => {
    vi.mocked(getSeriesList).mockResolvedValue([series(1), series(2)])

    const { container } = render(await SeriesIndex(props()))
    const levels = [...container.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => Number(h.tagName[1]))

    expect(levels[0]).toBe(1)
    levels.forEach((level, i) => {
      if (i === 0) return
      expect(level - levels[i - 1]!).toBeLessThanOrEqual(1)
    })
  })

  describe('generateMetadata', () => {
    it('canonical /series, and keeps the page number on later pages', async () => {
      const m = await generateMetadata(props())
      expect(m.alternates?.canonical).toBe('/series')
      expect(m.openGraph?.url).toBe(m.alternates?.canonical)
      expect(m.title).toBe('Series')

      const paged = await generateMetadata(props({ page: '1' }))
      expect(paged.alternates?.canonical).toBe('/series?page=1')
      expect(paged.openGraph?.url).toBe('/series?page=1')
    })
  })
})
