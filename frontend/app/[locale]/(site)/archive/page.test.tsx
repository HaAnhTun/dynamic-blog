import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchAllPublishedPosts } from '@/lib/published-posts'
import { absoluteUrl } from '@/lib/site'
import type { PostSummary } from '@/lib/types'
import { routeDir } from '@/test/routes'
import ArchivePage, { generateMetadata } from './page'
import { DECEMBER_2025, OCTOBER_2026 } from '@/test/fixtures/vi/archive-months'
import { msg } from '@/test/render-intl'
import { lastBrowseFrameCall, resetBrowseFrameCalls } from '@/test/browse-frame-mock'

/*
 * /archive: one year per page, split by UTC month. The page is an async function that can be called directly,
 * like WritingIndex; `notFound()` is the real next/navigation one: it throws an error carrying the digest
 * 'NEXT_HTTP_ERROR_FALLBACK;404', and the test compares that exact digest instead of checking that a stub was called.
 *
 * The full post list is the primary content: a failure throws (500). Swallowing it into an empty list would turn every
 * `?year=` into a 404 while the API is down, and 404s get cached.
 */
// The frame (sidebar + main column) is tested once in BrowseFrame.test.tsx; here it records what the page asked for.
vi.mock('@/components/site/BrowseFrame', () => import('@/test/browse-frame-mock'))
vi.mock('@/lib/published-posts', () => ({ fetchAllPublishedPosts: vi.fn() }))

function post(slug: string, publishedAt: string, readingMinutes = 4): PostSummary {
  return {
    id: `id-${slug}`,
    title: `Title ${slug}`,
    slug,
    excerpt: null,
    status: 'PUBLISHED',
    category: null,
    tags: [],
    featured: false,
    readingMinutes,
    publishedAt,
  }
}

/** Year 2026: October (2 posts), September (1). Year 2025: December (1), March (1). */
const posts: PostSummary[] = [
  post('t10-b', '2026-10-20T08:00:00Z', 8),
  post('t10-a', '2026-10-03T00:00:00Z'),
  post('t9', '2026-09-15T00:00:00Z'),
  // 23:00Z on 31/12 is already 2026 in UTC+7 (the TZ of the test suite): it must still land in December 2025.
  post('cuoi-nam', '2025-12-31T23:00:00Z'),
  post('t3', '2025-03-01T00:00:00Z'),
]

function respond(all: PostSummary[] = posts) {
  vi.mocked(fetchAllPublishedPosts).mockResolvedValue(all)
}

function props(searchParams: Record<string, string | string[] | undefined> = {}): PageProps<'/[locale]/archive'> {
  return { params: Promise.resolve({ locale: 'vi' }), searchParams: Promise.resolve(searchParams) }
}

async function expectNotFound(pageProps: PageProps<'/[locale]/archive'>, label: string) {
  const thrown = await ArchivePage(pageProps).then(
    () => null,
    (error: unknown) => error,
  )
  expect(thrown, `${label}: ArchivePage returned a page instead of calling notFound()`).not.toBeNull()
  expect((thrown as { digest?: string }).digest, label).toBe('NEXT_HTTP_ERROR_FALLBACK;404')
}

/** Ids of the month h2s on the page, in order. */
function monthIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll('h2')].map((h) => h.id)
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

/** Names and hrefs of the visible posts, in order: the links in the list of each month section. */
function visibleRows(container: HTMLElement): [string | null, string | null][] {
  return [...container.querySelectorAll('section ol li a')].map((a) => [a.textContent, a.getAttribute('href')])
}

afterEach(() => {
  resetBrowseFrameCalls()
  vi.mocked(fetchAllPublishedPosts).mockReset()
  vi.unstubAllEnvs()
})

describe('/archive', () => {
  it('asks for the page language and offers the other language when only that one has posts', async () => {
    vi.mocked(fetchAllPublishedPosts).mockImplementation(async (language) => (language === 'en' ? posts : []))

    render(await ArchivePage(props()))

    expect(fetchAllPublishedPosts).toHaveBeenCalledWith('vi')
    expect(screen.getByRole('link', { name: msg('Site.languageFallback.link', { language: 'English' }) })).toHaveAttribute(
      'href',
      '/en/archive',
    )
    expect(screen.queryByText(msg('Site.home.empty'))).not.toBeInTheDocument()
  })

  it('defaults to the newest year, one h2 id="thang-YYYY-MM" per month, newest month first', async () => {
    respond()

    const { container } = render(await ArchivePage(props()))

    expect(monthIds(container)).toEqual(['thang-2026-10', 'thang-2026-09'])
    expect(screen.getByRole('heading', { level: 2, name: OCTOBER_2026 })).toBeInTheDocument()
    // The older year is not on this page.
    expect(screen.queryByRole('link', { name: 'Title t3' })).not.toBeInTheDocument()
    expect(screen.getByText(msg('Site.archive.yearSummary', { count: 3, year: 2026 }))).toBeInTheDocument()
  })

  it('each month is a named region listing posts newest first with date, link and minutes', async () => {
    respond()

    render(await ArchivePage(props()))

    const october = screen.getByRole('region', { name: OCTOBER_2026 })
    expect(october).toHaveTextContent(msg('Admin.topics.manager.usageAll', { count: '2' }))
    const rows = within(october).getAllByRole('listitem')
    expect(rows.map((li) => within(li).getByRole('link').textContent)).toEqual(['Title t10-b', 'Title t10-a'])

    const first = rows[0]!
    expect(within(first).getByRole('link')).toHaveAttribute('href', '/posts/t10-b')
    const time = first.querySelector('time')
    expect(time).toHaveAttribute('dateTime', '2026-10-20T08:00:00Z')
    expect(time).toHaveTextContent('20/10')
    // "N min" only from 640px: the compact row on a phone is the date and the title.
    const minutes = within(first).getByText(msg('Site.archive.minutes', { minutes: '8' }))
    expect(minutes.className.split(/\s+/)).toEqual(expect.arrayContaining(['hidden', 'sm:block']))
  })

  it('groups by UTC month: 23:00Z on 31/12/2025 falls in December 2025', async () => {
    respond()

    const { container } = render(await ArchivePage(props({ year: '2025' })))

    expect(monthIds(container)).toEqual(['thang-2025-12', 'thang-2025-03'])
    const december = screen.getByRole('region', { name: DECEMBER_2025 })
    expect(within(december).getByRole('link', { name: 'Title cuoi-nam' })).toBeInTheDocument()
    expect(within(december).getByText('31/12')).toBeInTheDocument()
  })

  it('"By year" chips when there are 2 or more years: newest is /archive, older carries ?year, the current one has aria-current', async () => {
    respond()

    render(await ArchivePage(props({ year: '2025' })))

    const years = screen.getByRole('navigation', { name: msg('Site.archive.byYear') })
    const newest = within(years).getByRole('link', { name: msg('Admin.topics.manager.usageAll', { count: '2026 3' }) })
    const older = within(years).getByRole('link', { name: msg('Admin.topics.manager.usageAll', { count: '2025 2' }) })
    expect(newest).toHaveAttribute('href', '/archive')
    expect(older).toHaveAttribute('href', '/archive?year=2025')
    expect(older).toHaveAttribute('aria-current', 'page')
    expect(newest).not.toHaveAttribute('aria-current')
  })

  it('with only one year there are no year chips', async () => {
    respond(posts.slice(0, 3))

    render(await ArchivePage(props()))

    expect(screen.queryByRole('navigation', { name: msg('Site.archive.byYear') })).not.toBeInTheDocument()
    // Pair of the "yes" assertion: the page is still the archive page of that year.
    expect(screen.getByRole('heading', { level: 2, name: OCTOBER_2026 })).toBeInTheDocument()
  })

  it('the month jump row links to each month section, only when the year has 2 or more months', async () => {
    respond()
    const { unmount } = render(await ArchivePage(props()))

    const jump = screen.getByRole('navigation', { name: msg('Site.archive.byMonth') })
    expect(
      within(jump)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual(['#thang-2026-10', '#thang-2026-09'])
    unmount()

    respond([post('mot-thang', '2026-10-03T00:00:00Z')])
    render(await ArchivePage(props()))
    expect(screen.queryByRole('navigation', { name: msg('Site.archive.byMonth') })).not.toBeInTheDocument()
  })

  it('?year=<newest year> is the same page as the default', async () => {
    respond()

    const { container } = render(await ArchivePage(props({ year: '2026' })))

    expect(monthIds(container)).toEqual(['thang-2026-10', 'thang-2026-09'])
  })

  it('a repeated ?year takes the first value', async () => {
    respond()

    const { container } = render(await ArchivePage(props({ year: ['2025', '2026'] })))

    expect(monthIds(container)).toEqual(['thang-2025-12', 'thang-2025-03'])
  })

  it('404 for a year that is not digits, without asking the API', async () => {
    for (const year of ['abc', '', '2026abc', '20.26', '-2026', ' 2026', '99999']) {
      respond()
      vi.mocked(fetchAllPublishedPosts).mockClear()

      await expectNotFound(props({ year }), `?year=${JSON.stringify(year)}`)
      expect(fetchAllPublishedPosts, `?year=${JSON.stringify(year)} must not reach the API`).not.toHaveBeenCalled()
    }
  })

  it('404 for a year with no posts', async () => {
    respond()

    await expectNotFound(props({ year: '1999' }), '?year=1999')
    await expectNotFound(props({ year: '2027' }), '?year=2027')
  })

  it('reading the full post list failing throws (500), not 404', async () => {
    const boom = new Error('posts unreachable')
    vi.mocked(fetchAllPublishedPosts).mockRejectedValue(boom)

    await expect(ArchivePage(props())).rejects.toBe(boom)
    await expect(ArchivePage(props({ year: '2025' }))).rejects.toBe(boom)
  })

  it('blog with no posts: /archive is 200 with a notice, ?year is 404', async () => {
    respond([])

    const { container } = render(await ArchivePage(props()))
    expect(screen.getByText(msg('Site.home.empty'))).toBeInTheDocument()
    expect(container.querySelector('h2')).toBeNull()

    await expectNotFound(props({ year: '2026' }), 'empty blog ?year=2026')
  })

  it('with posts there is no "No posts yet." sentence', async () => {
    respond()

    render(await ArchivePage(props()))

    expect(screen.queryByText(msg('Site.home.empty'))).not.toBeInTheDocument()
  })

  it('one h1, inside the frame with "Archive" as the current Explore row, h1 to h2 outline with no skipped level', async () => {
    respond()

    const { container } = render(await ArchivePage(props()))

    expect(container.querySelectorAll('h1')).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(msg('Site.footer.links.archive'))
    expect(lastBrowseFrameCall()?.current).toEqual({ key: 'archive', exact: true })
    expect(screen.getByTestId('browse-frame')).toContainElement(screen.getByRole('heading', { level: 1 }))
    expect(screen.queryByRole('navigation', { name: msg('Site.listing.sectionNav.label') })).not.toBeInTheDocument()
    expect(container.querySelector('main')).toBeNull()
    const levels = [...container.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => Number(h.tagName[1]))
    expect(levels).toEqual([1, 2, 2])
  })

  it('3 months: one column capped at max-w-3xl, no xl:grid-cols-2', async () => {
    respond([post('a', '2026-10-03T00:00:00Z'), post('b', '2026-09-15T00:00:00Z'), post('c', '2026-08-01T00:00:00Z')])

    const { container } = render(await ArchivePage(props()))

    const months = container.querySelectorAll('section[aria-labelledby^="thang-"]')
    expect(months).toHaveLength(3)
    const grid = months[0]!.parentElement!
    expect(grid).toHaveClass('grid', 'gap-y-10', 'max-w-3xl')
    expect(grid).not.toHaveClass('xl:grid-cols-2')
    expect(grid.className).not.toContain('space-y')
    expect(screen.getByTestId('browse-frame')).toContainElement(grid)
  })

  it('4 months: two columns from xl, items-start, gap not margins, DOM order = data order, ids and jump row unchanged', async () => {
    respond([
      post('a', '2026-10-03T00:00:00Z'),
      post('b', '2026-09-15T00:00:00Z'),
      post('c', '2026-08-01T00:00:00Z'),
      post('d', '2026-07-01T00:00:00Z'),
    ])

    const { container } = render(await ArchivePage(props()))

    const months = [...container.querySelectorAll('section[aria-labelledby^="thang-"]')]
    expect(months).toHaveLength(4)
    const grid = months[0]!.parentElement!
    expect(grid).toHaveClass('grid', 'items-start', 'gap-x-12', 'gap-y-10', 'xl:grid-cols-2')
    expect(grid).not.toHaveClass('max-w-3xl')
    expect(months.map((m) => m.getAttribute('aria-labelledby'))).toEqual([
      'thang-2026-10',
      'thang-2026-09',
      'thang-2026-08',
      'thang-2026-07',
    ])
    // Each section keeps its top rule and padding, and no margin classes.
    for (const section of months) {
      const rule = section.querySelector('.border-t')!
      expect(rule).toHaveClass('pt-6')
      expect(section.className).not.toMatch(/m[tby]-/)
    }
    // The jump row still has one link per month, in the same order.
    const jump = screen.getByRole('navigation', { name: msg('Site.archive.byMonth') })
    expect(
      within(jump)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual(['#thang-2026-10', '#thang-2026-09', '#thang-2026-08', '#thang-2026-07'])
  })

  it('there is no loading.tsx: it would turn the 404 "year with no posts" into a 200', () => {
    // Same rule as the three list pages (writing/page.test.tsx): with loading.tsx the page becomes
    // a streamed shell, and status 200 is sent before the page body calls notFound(). The directory is
    // looked up from the route tree and must exist, so that the absence assertion is not vacuously true.
    const dir = routeDir(join(process.cwd(), 'app'), '/archive')
    expect(dir, 'nothing serves /archive').toBeDefined()
    for (const file of ['loading.tsx', 'loading.ts', 'loading.jsx', 'loading.js']) {
      expect(existsSync(join(dir as string, file)), `/archive/${file} must not exist`).toBe(false)
    }
  })

  describe('structured data (JSON-LD)', () => {
    it('newest year: CollectionPage /archive carries the exact title, description and canonical of the metadata', async () => {
      vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://blog.example.com')
      respond()

      const { container } = render(await ArchivePage(props()))
      const m = await generateMetadata(props())
      const [page] = jsonLd(container)

      expect(page).toMatchObject({
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: msg('Site.footer.links.archive'),
        description: msg('Site.pageDescriptions.archive'),
        url: 'https://blog.example.com/archive',
      })
      // Same strings as og:title, meta description and canonical: one construction, not two.
      expect(page!.name).toBe(m.openGraph?.title)
      expect(page!.description).toBe(m.description)
      expect(page!.url).toBe(absoluteUrl(m.alternates?.canonical as string))
    })

    it('ItemList is exactly the posts of the year being viewed, in page order: newest month first, newest post first', async () => {
      vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://blog.example.com')
      respond()

      const { container } = render(await ArchivePage(props()))
      const list = itemList(jsonLd(container)[0]!)

      // t10-b (20/10) before t10-a (3/10), then September. The 2025 posts are not on this page.
      expect(list).toEqual([
        { '@type': 'ListItem', position: 1, name: 'Title t10-b', url: 'https://blog.example.com/posts/t10-b' },
        { '@type': 'ListItem', position: 2, name: 'Title t10-a', url: 'https://blog.example.com/posts/t10-a' },
        { '@type': 'ListItem', position: 3, name: 'Title t9', url: 'https://blog.example.com/posts/t9' },
      ])
      expect(list.map((item) => [item.name, new URL(item.url).pathname])).toEqual(visibleRows(container))
    })

    it('older year: url is /archive?year=YYYY, name is the title of that year, position restarts at 1', async () => {
      vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://blog.example.com')
      respond()

      const { container } = render(await ArchivePage(props({ year: '2025' })))
      const m = await generateMetadata(props({ year: '2025' }))
      const [page] = jsonLd(container)

      expect(page).toMatchObject({
        name: msg('Site.archive.yearTitle', { year: '2025' }),
        description: msg('Site.archive.yearDescription', { year: '2025' }),
        url: 'https://blog.example.com/archive?year=2025',
      })
      expect(page!.url).toBe(absoluteUrl(m.alternates?.canonical as string))
      expect(page!.name).toBe(m.openGraph?.title)
      // Each year is a page with its own canonical, not the nth page of a paginated
      // list: count again from 1.
      expect(itemList(page!).map((item) => [item.position, item.name])).toEqual([
        [1, 'Title cuoi-nam'],
        [2, 'Title t3'],
      ])
      expect(itemList(page!).map((item) => [item.name, new URL(item.url).pathname])).toEqual(visibleRows(container))
    })

    it('?year=<newest year>: url is the canonical /archive, not /archive?year=2026', async () => {
      vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://blog.example.com')
      respond()

      const { container } = render(await ArchivePage(props({ year: '2026' })))
      const [page] = jsonLd(container)

      expect(page!.url).toBe('https://blog.example.com/archive')
      expect(page!.name).toBe(msg('Site.footer.links.archive'))
    })

    it('no BreadcrumbList: the page has no visible breadcrumb for it to describe', async () => {
      respond()

      const { container } = render(await ArchivePage(props()))

      expect(screen.queryByRole('navigation', { name: msg('Site.breadcrumb.label') })).not.toBeInTheDocument()
      // Exactly one block, and it is the CollectionPage: the absence assertion is not green just because the page has no JSON-LD at all.
      expect(jsonLd(container).map((block) => block['@type'])).toEqual(['CollectionPage'])
    })

    it('blog with no posts: no JSON-LD at all, not an empty ItemList', async () => {
      respond([])

      const { container } = render(await ArchivePage(props()))

      expect(screen.getByText(msg('Site.home.empty'))).toBeInTheDocument()
      expect(jsonLd(container)).toEqual([])
    })
  })

  describe('generateMetadata', () => {
    it('canonical /archive for the newest year, even when ?year is written explicitly', async () => {
      respond()

      for (const searchParams of [{}, { year: '2026' }]) {
        const m = await generateMetadata(props(searchParams))
        expect(m.alternates?.canonical, JSON.stringify(searchParams)).toBe('/archive')
        expect(m.openGraph?.url, JSON.stringify(searchParams)).toBe('/archive')
        expect(m.title, JSON.stringify(searchParams)).toBe(msg('Site.footer.links.archive'))
      }
    })

    it('canonical /archive?year=YYYY and its own title for an older year', async () => {
      respond()

      const m = await generateMetadata(props({ year: '2025' }))

      expect(m.alternates?.canonical).toBe('/archive?year=2025')
      expect(m.openGraph?.url).toBe('/archive?year=2025')
      expect(m.title).toBe(msg('Site.archive.yearTitle', { year: '2025' }))
    })

    it('does not throw when the API fails or the year is invalid', async () => {
      vi.mocked(fetchAllPublishedPosts).mockRejectedValue(new Error('down'))

      await expect(generateMetadata(props())).resolves.toMatchObject({ alternates: { canonical: '/archive' } })
      await expect(generateMetadata(props({ year: '2025' }))).resolves.toBeDefined()
      await expect(generateMetadata(props({ year: 'abc' }))).resolves.toBeDefined()
    })
  })
})
