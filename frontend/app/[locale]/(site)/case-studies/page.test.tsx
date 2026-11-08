import { render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isValidElement, type ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CaseStudiesGroup } from '@/components/site/reader/CaseStudiesGroup'
import { routing } from '@/i18n/routing'
import type { Locale } from '@/i18n/config'
import type { SiteContent } from '@/lib/site-content-types'
import CaseStudiesPage, { generateMetadata as indexMetadata } from './page'
import CaseStudyDetail, { generateMetadata, generateStaticParams } from './[slug]/page'
import { getSiteContent } from '@/lib/site-content'
import { pageProps } from '@/test/page-props'
import { routeDir } from '@/test/routes'
import { lastBrowseFrameCall, resetBrowseFrameCalls } from '@/test/browse-frame-mock'
import { msg } from '@/test/render-intl'

// The real frame renders the sidebar twice under jsdom; the shared stand-in records what the page asked of it.
vi.mock('@/components/site/BrowseFrame', () => import('@/test/browse-frame-mock'))

/**
 * The packaged defaults, with citations added to every case study: the packaged examples cite no post, and the "read more"
 * behavior needs some.
 */
const CITED = vi.hoisted(() => [{ slug: 'first-cited-post' }, { slug: 'second-cited-post' }])
/** Studies appended to the packaged one for a single test (the shipped default has exactly one). */
const extraStudies = vi.hoisted(() => ({ list: [] as { slug: string; title: string }[] }))
vi.mock('@/lib/site-content', async () => {
  const { defaultSiteContent } = await import('@/content/defaults')
  const withCitations = async (locale: Locale): Promise<SiteContent> => {
    const content = defaultSiteContent(locale)
    const cited = content.caseStudies.map((item) => ({ ...item, readMore: CITED }))
    return { ...content, caseStudies: [...cited, ...extraStudies.list.map((extra) => ({ ...cited[0]!, ...extra }))] }
  }
  return { SITE_CONTENT_TAG: 'site-content', getSiteContent: withCitations }
})

const metadata = await indexMetadata(pageProps())

/**
 * The two case study pages. Both are Server Components; the detail page is async, so the test awaits
 * the result before rendering, the way `posts/[slug]/page.test.tsx` does.
 *
 * `fetchAllPublishedPosts` is mocked because the detail page uses it to get the display titles
 * of the cited posts. Mocked at the module boundary, not at `fetch`: what needs proving is that the
 * page uses the real title when there is one and still renders when there is none, not HTTP.
 */
vi.mock('@/lib/published-posts', () => ({ fetchAllPublishedPosts: vi.fn() }))
const { fetchAllPublishedPosts } = await import('@/lib/published-posts')

const notFound = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND')
  }),
)
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  notFound,
}))

const caseStudies = (await getSiteContent('vi')).caseStudies
const study = caseStudies[0]!
const props = (slug: string) => ({ params: Promise.resolve({ locale: 'vi', slug }) }) as never

afterEach(() => {
  extraStudies.list = []
  resetBrowseFrameCalls()
})

describe('/case-studies', () => {
  it('lists every case study, one link each', async () => {
    render(await CaseStudiesPage(pageProps()))

    for (const item of caseStudies) {
      expect(screen.getByRole('link', { name: item.title })).toHaveAttribute('href', `/case-studies/${item.slug}`)
    }
    expect(screen.getAllByRole('listitem')).toHaveLength(caseStudies.length)
  })

  it('shows every case study as a card, not as a hairline row', async () => {
    render(await CaseStudiesPage(pageProps()))

    for (const [index, card] of screen.getAllByRole('listitem').entries()) {
      const classes = card.className.split(/\s+/)
      expect(classes).toEqual(expect.arrayContaining(['rounded-card', 'border']))
      // The rejected pattern: a hairline above every row with the name on the left and the text on the right.
      expect(classes).not.toContain('border-t')
      expect(card.className).not.toMatch(/first:|lg:items-baseline/)
      expect(card.children[0]!.tagName).toBe('H2')
      expect(card.textContent).toContain(caseStudies[index]!.summary)
    }
  })

  it('does not import the hairline row pattern any more', () => {
    const source = readFileSync(join(routeDir(join(process.cwd(), 'app'), '/case-studies')!, 'page.tsx'), 'utf8')

    expect(source).not.toContain('SPLIT_ROW')
    expect(source).not.toContain('border-t')
  })

  it('puts a single study in one full-width card, with no second column', async () => {
    render(await CaseStudiesPage(pageProps()))

    const list = screen.getByRole('list')
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(list.className).not.toContain('lg:grid-cols-2')
    expect(list.className).toContain('grid-cols-1')
  })

  it('uses two columns from lg only with two or more studies', async () => {
    const second = { ...study, slug: 'second-study', title: 'Second study' }
    extraStudies.list = [second]

    render(await CaseStudiesPage(pageProps()))

    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByRole('list').className).toContain('lg:grid-cols-2')
    expect(screen.getByRole('link', { name: 'Second study' })).toHaveAttribute('href', '/case-studies/second-study')
  })

  it('renders inside the browse frame with no current section and the Case studies group as its extra', async () => {
    render(await CaseStudiesPage(pageProps()))

    const frame = screen.getByTestId('browse-frame')
    expect(frame).not.toHaveAttribute('data-current')
    expect(frame).toContainElement(screen.getByRole('heading', { level: 1 }))
    const call = lastBrowseFrameCall()!
    expect(call.current).toBeUndefined()
    expect(isValidElement(call.extra) && call.extra.type).toBe(CaseStudiesGroup)
    expect((call.extra as ReactElement<{ locale: string; current?: string }>).props).toEqual({ locale: 'vi' })
  })

  it('has exactly one h1 and declares its own canonical', async () => {
    const { container } = render(await CaseStudiesPage(pageProps()))

    expect(container.querySelectorAll('h1')).toHaveLength(1)
    // Without a canonical the page inherits the root layout canonical '/' and declares itself a
    // copy of the home page, a bug that really happened on /posts/[slug].
    expect(metadata.alternates?.canonical).toBe('/case-studies')
  })

  it('does not mention the removed /projects path', async () => {
    const { container } = render(await CaseStudiesPage(pageProps()))

    const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'))
    expect(hrefs.filter((href) => href?.startsWith('/projects'))).toEqual([])
  })
})

describe('/case-studies/[slug]', () => {
  it('renders all five parts in the order of a case study', async () => {
    vi.mocked(fetchAllPublishedPosts).mockResolvedValue([])

    const { container } = render(await CaseStudyDetail(props(study.slug)))

    const headings = Array.from(container.querySelectorAll('h2')).map((h) => h.textContent)
    // The order is content, not presentation: with the result before the constraint the reader
    // sees the number before knowing what that number had to get past.
    expect(headings.slice(0, 5)).toEqual([
      msg('Site.caseStudies.problem'),
      msg('Site.caseStudies.constraints'),
      msg('Site.caseStudies.solution'),
      msg('Site.caseStudies.results'),
      msg('Site.caseStudies.ifRedone'),
    ])
  })

  it('prints the source column for every measurement', async () => {
    vi.mocked(fetchAllPublishedPosts).mockResolvedValue([])

    render(await CaseStudyDetail(props(study.slug)))

    // Each row must carry its source onto the screen. A table with only a label and a value
    // is exactly the "results without the method" that portfolios often fall into.
    for (const row of study.results) {
      expect(screen.getByText(row.label)).toBeInTheDocument()
      expect(screen.getByText(row.source)).toBeInTheDocument()
    }
  })

  it('uses the real post title when the API returns it', async () => {
    const first = study.readMore[0]!
    vi.mocked(fetchAllPublishedPosts).mockResolvedValue([{ slug: first.slug, title: 'Real title from the API' }] as never)

    render(await CaseStudyDetail(props(study.slug)))

    expect(screen.getByRole('link', { name: 'Real title from the API' })).toHaveAttribute('href', `/posts/${first.slug}`)
  })

  it('links a cited post under its own language when it differs from the page language', async () => {
    const first = study.readMore[0]!
    vi.mocked(fetchAllPublishedPosts).mockResolvedValue([{ slug: first.slug, title: 'English title', language: 'en' }] as never)

    render(await CaseStudyDetail(props(study.slug)))

    expect(screen.getByRole('link', { name: 'English title' })).toHaveAttribute('href', `/en/posts/${first.slug}`)
  })

  it('still renders when the API is down, only losing the nice labels', async () => {
    // This is the state of `next build` inside a `docker build`: the API is not running yet. Losing the API
    // must cost the label, not the whole page.
    vi.mocked(fetchAllPublishedPosts).mockRejectedValue(new Error('fetch failed'))

    const first = study.readMore[0]!
    render(await CaseStudyDetail(props(study.slug)))

    expect(screen.getByRole('heading', { level: 1, name: study.title })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: first.slug })).toHaveAttribute('href', `/posts/${first.slug}`)
  })

  it('returns 404 for an unknown slug instead of rendering an empty page', async () => {
    vi.mocked(fetchAllPublishedPosts).mockResolvedValue([])

    await expect(CaseStudyDetail(props('khong-ton-tai'))).rejects.toThrow('NEXT_NOT_FOUND')
    expect(notFound).toHaveBeenCalled()
  })

  it('generates static params for exactly the case studies that exist, per locale', async () => {
    const expected = await Promise.all(
      routing.locales.map(async (locale) =>
        (await getSiteContent(locale)).caseStudies.map((item) => ({ locale, slug: item.slug })),
      ),
    )
    expect(await generateStaticParams()).toEqual(expected.flat())
  })

  it('reads the case studies of the page locale', async () => {
    const english = (await getSiteContent('en')).caseStudies[0]!
    const props = { params: Promise.resolve({ locale: 'en', slug: english.slug }) } as never

    const meta = await generateMetadata(props)

    expect(meta.title).toBe(english.title)
    expect(english.title).not.toBe(study.title)
  })

  it('the detail page canonical points to itself', async () => {
    const meta = await generateMetadata(props(study.slug))

    expect(meta.alternates?.canonical).toBe(`/case-studies/${study.slug}`)
    expect(meta.title).toBe(study.title)
  })

  it('does not throw for an unknown slug, because generateMetadata runs before the page', async () => {
    // Throwing here breaks the whole 404 response instead of producing it.
    await expect(generateMetadata(props('khong-ton-tai'))).resolves.toEqual({
      title: msg('Site.caseStudies.notFoundTitle'),
    })
  })
})
