import { defaultSiteContent } from '@/content/defaults'
import { TEST_LOCALE } from '@/test/intl'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NotFoundError, getPosts } from '@/lib/api'
import { absoluteUrl } from '@/lib/site'
import { getTag } from '@/lib/taxonomy'
import type { PostSummary, Tag } from '@/lib/types'
import TagArchive, { generateMetadata, revalidate } from './page'
import { DEBUG_SLUG } from '@/test/fixtures/vi/category-feed'
import { msg } from '@/test/render-intl'

// The sidebar frame is tested once (BrowseFrame.test.tsx); here a stand-in records what the page asked for.
vi.mock('@/components/site/BrowseFrame', () => import('@/test/browse-frame-mock'))

const { site } = defaultSiteContent(TEST_LOCALE)

/**
 * Same approach as its neighbour app/categories/[slug]/page.test.tsx, and deliberately
 * the same set of cases: the guards on these two pages must not drift apart, which is
 * this project's own recorded mistake (the post page got the signature guard, the
 * homepage did not).
 */
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  getPosts: vi.fn(),
}))
vi.mock('@/lib/taxonomy', () => ({ getTag: vi.fn() }))

/**
 * Every fixture tag here has a `name` that differs from its `slug`, and that is the
 * point. These three are straight out of `curl -s localhost:8080/api/v1/tags`.
 *
 * For all of Sprint 3a the API returned names only, and lib/types.ts documented at
 * length that a chip could therefore only link to `?tag=<name>` while the backend
 * matched `tags.slug` — so every chip led to an empty list. A fixture whose name and
 * slug were identical ("ai"/"ai") would pass whichever field the code used, and this
 * whole route would be untested where it matters most.
 */
const tags: Tag[] = [
  { id: 't1', name: 'Lessons', slug: 'bai-hoc' },
  { id: 't2', name: 'CI/CD', slug: 'ci-cd' },
  { id: 't3', name: 'Spring Boot', slug: 'spring-boot' },
]

/** The backend detail: the tag with exactly this slug, a 404 for any other. */
function serve(list: Tag[]) {
  vi.mocked(getTag).mockImplementation(async (slug) => {
    const found = list.find((entry) => entry.slug === slug)
    if (!found) throw new NotFoundError('TAG_NOT_FOUND', 'not found')
    return found
  })
}

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

function respond({ totalPages, items }: { totalPages: number; items: PostSummary[] }) {
  serve(tags)
  vi.mocked(getPosts).mockImplementation(async ({ page, size }) => ({
    items,
    meta: { page, size, totalElements: totalPages * size, totalPages },
  }))
}

function props(
  slug: string,
  searchParams: Record<string, string | string[] | undefined> = {},
): PageProps<'/[locale]/tags/[slug]'> {
  return { params: Promise.resolve({ locale: 'vi', slug }), searchParams: Promise.resolve(searchParams) }
}

async function expectNotFound(pageProps: PageProps<'/[locale]/tags/[slug]'>, why: string) {
  const thrown = await TagArchive(pageProps).then(
    () => null,
    (error: unknown) => error,
  )
  expect(thrown, `${why}: rendered a page instead of calling notFound()`).not.toBeNull()
  expect((thrown as { digest?: string }).digest, why).toBe('NEXT_HTTP_ERROR_FALLBACK;404')
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
  vi.mocked(getPosts).mockReset()
  vi.mocked(getTag).mockReset()
  vi.unstubAllEnvs()
})

describe('/tags/[slug]', () => {
  it('filters by the tag SLUG and shows the tag NAME in the heading', async () => {
    respond({ totalPages: 2, items: [summary(1), summary(2)] })

    const { container } = render(await TagArchive(props('bai-hoc')))

    // The slug goes on the wire. `getPosts({ tag })` filters on `tags.slug`
    // (PostSpecifications), so passing the tag name here matches nothing — and that is
    // the bug this route exists to fix rather than repeat.
    expect(getPosts).toHaveBeenCalledWith({ page: 0, size: 10, tag: 'bai-hoc', language: 'vi' })

    // The name goes on the page. Showing 'bai-hoc' as a heading would be the same
    // mistake in reverse: readable to the database, not to the reader.
    expect(container.querySelectorAll('h1')).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Lessons')
    expect(screen.getByRole('heading', { level: 1 })).not.toHaveTextContent('bai-hoc')

    expect(container.querySelectorAll('li > article')).toHaveLength(2)
    expect(container.querySelector('main')).toBeNull()
    expect(screen.getByRole('link', { name: msg('Site.taxonomy.backToAll') })).toHaveAttribute('href', '/writing')
  })

  it('sits in the frame with Topics as the parent row (aria-current=true): header, list and pagination are its children', async () => {
    respond({ totalPages: 2, items: [summary(1), summary(2)] })

    const { container } = render(await TagArchive(props('bai-hoc')))

    const frame = screen.getByTestId('browse-frame')
    expect(frame).toHaveAttribute('data-current', 'topics')
    expect(frame).toHaveAttribute('data-exact', 'false')
    expect(frame).toContainElement(screen.getByRole('heading', { level: 1 }))
    expect(frame).toContainElement(container.querySelector('li > article'))
    expect(frame).toContainElement(screen.getByRole('navigation', { name: msg('Site.pagination.label') }))
    // The JSON-LD stays a sibling of the frame, outside the main column.
    const ld = container.querySelector('script[type="application/ld+json"]')
    expect(ld).not.toBeNull()
    expect(frame).not.toContainElement(ld as HTMLElement)
  })

  it('works for a tag whose name contains a slash', async () => {
    // 'CI/CD' is the fixture that catches a name-based href or a name-based API
    // parameter structurally rather than by value: a slash in a path segment changes
    // the shape of the URL, so /tags/CI/CD is not even this route.
    respond({ totalPages: 1, items: [summary(1)] })

    render(await TagArchive(props('ci-cd')))

    expect(getPosts).toHaveBeenCalledWith({ page: 0, size: 10, tag: 'ci-cd', language: 'vi' })
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('CI/CD')
  })

  it('pages within the tag, keeping the slug in every pager href', async () => {
    respond({ totalPages: 5, items: [summary(1)] })

    render(await TagArchive(props('spring-boot', { page: '3' })))

    expect(getPosts).toHaveBeenCalledWith({ page: 3, size: 10, tag: 'spring-boot', language: 'vi' })
    expect(screen.getByText('Trang 4 / 5')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: msg('Site.pagination.previous') })).toHaveAttribute(
      'href',
      '/tags/spring-boot?page=2',
    )
    expect(screen.getByRole('link', { name: /sau/i })).toHaveAttribute('href', '/tags/spring-boot?page=4')
  })

  it('404s a slug that matches no tag, instead of an empty list', async () => {
    respond({ totalPages: 3, items: [] })

    await expectNotFound(props('khong-ton-tai'), 'unknown slug')
    expect(getPosts).not.toHaveBeenCalled()
  })

  it('404s when the reader was sent the tag NAME instead of its slug', async () => {
    // The precise regression. A chip built from `tag.name` produces
    // /tags/B%C3%A0i%20h%E1%BB%8Dc, which decodes to the tag name (with diacritics) and matches no slug —
    // so this URL must be a 404 and not a 200 with an empty list, which is what a
    // name-tolerant `find` would quietly give it.
    respond({ totalPages: 3, items: [summary(1)] })

    await expectNotFound(props(encodeURIComponent('Lessons')), 'a name-built href')
  })

  it('404s a slug that differs only by case or by trailing text', async () => {
    for (const slug of ['Bai-Hoc', 'BAI-HOC', 'bai-hoc-x', 'bai', '']) {
      respond({ totalPages: 3, items: [summary(1)] })
      await expectNotFound(props(slug), `slug=${JSON.stringify(slug)}`)
      vi.mocked(getPosts).mockReset()
      vi.mocked(getTag).mockReset()
    }
  })

  it('decodes a percent-encoded slug before matching it', async () => {
    // Route params are not url-decoded by Next. Every slug in the live database is
    // ASCII today, so dropping normalizeSlug would break nothing visible — until the
    // first tag whose slug keeps a diacritic.
    serve([{ id: 't9', name: 'Debugging', slug: DEBUG_SLUG }])
    vi.mocked(getPosts).mockResolvedValue({
      items: [summary(1)],
      meta: { page: 0, size: 10, totalElements: 1, totalPages: 1 },
    })

    render(await TagArchive(props(encodeURIComponent(DEBUG_SLUG))))

    expect(getPosts).toHaveBeenCalledWith({ page: 0, size: 10, tag: DEBUG_SLUG, language: 'vi' })
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Debugging')
  })

  it('404s a page index too large to be a real request, without asking the API', async () => {
    for (const page of ['10001', '2147483647', '2147483648', '9999999999999999999999']) {
      respond({ totalPages: 3, items: [summary(1)] })
      vi.mocked(getPosts).mockClear()
      vi.mocked(getTag).mockClear()

      await expectNotFound(props('bai-hoc', { page }), `?page=${page}`)

      expect(getPosts, `?page=${page} must not reach the API`).not.toHaveBeenCalled()
      expect(getTag, `?page=${page} must not reach the API`).not.toHaveBeenCalled()
    }
  })

  it('falls back to the first page for a ?page the API should never be sent', async () => {
    for (const page of ['abc', '-1', '', 'Infinity', '1.5', '0x2', '2abc', '+2', ' ']) {
      respond({ totalPages: 3, items: [summary(1)] })

      render(await TagArchive(props('bai-hoc', { page })))

      expect(getPosts, `?page=${page}`).toHaveBeenCalledWith({
        page: 0,
        size: 10,
        tag: 'bai-hoc',
        language: 'vi',
      })
      vi.mocked(getPosts).mockReset()
    }
  })

  it('takes the first value when ?page is repeated', async () => {
    respond({ totalPages: 9, items: [summary(1)] })

    render(await TagArchive(props('bai-hoc', { page: ['2', '5'] })))

    expect(getPosts).toHaveBeenCalledWith({ page: 2, size: 10, tag: 'bai-hoc', language: 'vi' })
  })

  it('404s for a page past the last one instead of showing an empty list', async () => {
    for (const page of ['2', '99']) {
      respond({ totalPages: 2, items: [] })

      await expectNotFound(props('bai-hoc', { page }), `?page=${page}`)

      vi.mocked(getPosts).mockReset()
      vi.mocked(getTag).mockReset()
    }
  })

  it('asks for the tag in the page language and offers the other language when it has no posts here', async () => {
    serve(tags)
    vi.mocked(getPosts).mockImplementation(async ({ page, size, language }) => {
      const total = language === 'en' ? 2 : 0
      return { items: [], meta: { page, size, totalElements: total, totalPages: total > 0 ? 1 : 0 } }
    })

    render(await TagArchive(props('bai-hoc')))

    expect(getTag).toHaveBeenCalledWith('bai-hoc', 'vi')
    expect(screen.getByRole('link', { name: msg('Site.languageFallback.link', { language: 'English' }) })).toHaveAttribute(
      'href',
      '/en/tags/bai-hoc',
    )
    expect(screen.queryByText(msg('Site.taxonomy.tagEmpty'))).not.toBeInTheDocument()
  })

  it('renders the empty state for a real but unused tag rather than 404ing', async () => {
    respond({ totalPages: 0, items: [] })

    const { container } = render(await TagArchive(props('bai-hoc')))

    expect(screen.getByText(msg('Site.taxonomy.tagEmpty'))).toBeInTheDocument()
    expect(container.querySelector('article')).toBeNull()
    expect(screen.queryByRole('navigation', { name: msg('Site.pagination.label') })).not.toBeInTheDocument()
  })

  it('404s for a page other than the first of an empty tag', async () => {
    respond({ totalPages: 0, items: [] })

    await expectNotFound(props('bai-hoc', { page: '1' }), 'page 1 of an empty tag')
  })

  it('lets a tag-list failure be a 500 and never a 404', async () => {
    const boom = new Error('tags unreachable')
    vi.mocked(getTag).mockRejectedValue(boom)
    vi.mocked(getPosts).mockResolvedValue({
      items: [],
      meta: { page: 0, size: 10, totalElements: 0, totalPages: 0 },
    })

    const thrown = await TagArchive(props('bai-hoc')).then(
      () => null,
      (error: unknown) => error,
    )
    expect(thrown).toBe(boom)
    expect((thrown as { digest?: string }).digest).toBeUndefined()
  })

  it('has a heading outline that descends without skipping a level', async () => {
    respond({ totalPages: 2, items: [summary(1), summary(2)] })

    const { container } = render(await TagArchive(props('bai-hoc')))

    // A jump from h1 to h3 tells a screen-reader user a level is missing. jsdom applies
    // no Tailwind, so `sr-only` headings are counted here too — correct for an outline.
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

  it('declares the revalidate window the route is supposed to have', () => {
    expect(revalidate).toBe(300)
  })

  describe('structured data (JSON-LD)', () => {
    it('CollectionPage carries the exact title, description and canonical that the page metadata declares', async () => {
      vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://blog.example.com')
      respond({ totalPages: 1, items: [summary(1)] })

      // "CI/CD": the name has a "/" while the slug does not. A URL built from the name would no longer be this route.
      const { container } = render(await TagArchive(props('ci-cd')))
      const m = await generateMetadata(props('ci-cd'))
      const [page] = jsonLd(container)

      expect(page).toMatchObject({
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: msg('Site.taxonomy.tagTitle', { name: 'CI/CD' }),
        description: msg('Site.taxonomy.tagDescription', { name: 'CI/CD' }),
        url: 'https://blog.example.com/tags/ci-cd',
      })
      // Same strings as og:title, meta description and canonical: one construction, not two.
      expect(page!.name).toBe(m.openGraph?.title)
      expect(page!.description).toBe(m.description)
      expect(page!.url).toBe(absoluteUrl(m.alternates?.canonical as string))
    })

    it('ItemList is exactly the posts this page shows, in the order shown, absolute URLs from position 1', async () => {
      vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://blog.example.com')
      respond({ totalPages: 2, items: [summary(2), summary(1)] })

      const { container } = render(await TagArchive(props('bai-hoc')))
      const list = itemList(jsonLd(container)[0]!)

      expect(list).toEqual([
        { '@type': 'ListItem', position: 1, name: 'Post 2', url: 'https://blog.example.com/posts/bai-viet-2' },
        { '@type': 'ListItem', position: 2, name: 'Post 1', url: 'https://blog.example.com/posts/bai-viet-1' },
      ])
      expect(list.map((item) => [item.name, new URL(item.url).pathname])).toEqual(visibleRows(container))
    })

    it('?page=n: url is the canonical keeping the page number, position continues after the previous pages', async () => {
      vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://blog.example.com')
      respond({ totalPages: 5, items: [summary(31), summary(32)] })

      const { container } = render(await TagArchive(props('spring-boot', { page: '3' })))
      const m = await generateMetadata(props('spring-boot', { page: '3' }))
      const [page] = jsonLd(container)

      expect(page!.url).toBe('https://blog.example.com/tags/spring-boot?page=3')
      expect(page!.url).toBe(absoluteUrl(m.alternates?.canonical as string))
      // ?page counts from 0, position counts from 1: page 3 with 10 posts per page starts with the 31st post.
      expect(itemList(page!).map((item) => item.position)).toEqual([31, 32])
    })

    it('no BreadcrumbList: the "← All posts" link is the way back, not a breadcrumb', async () => {
      respond({ totalPages: 1, items: [summary(1)] })

      const { container } = render(await TagArchive(props('bai-hoc')))

      expect(screen.queryByRole('navigation', { name: msg('Site.breadcrumb.label') })).not.toBeInTheDocument()
      expect(screen.getByRole('link', { name: msg('Site.taxonomy.backToAll') })).toBeInTheDocument()
      // Exactly one block, and it is the CollectionPage: the absence assertion is not green just because the page has no JSON-LD at all.
      expect(jsonLd(container).map((block) => block['@type'])).toEqual(['CollectionPage'])
    })

    it('tag with no posts: no JSON-LD at all, not an empty ItemList', async () => {
      respond({ totalPages: 0, items: [] })

      const { container } = render(await TagArchive(props('bai-hoc')))

      expect(screen.getByText(msg('Site.taxonomy.tagEmpty'))).toBeInTheDocument()
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
      serve(tags)

      const m = await generateMetadata(props('bai-hoc'))

      expect(m.openGraph?.url).toBe(m.alternates?.canonical)
      expect(m.openGraph?.url).toBe('/tags/bai-hoc')
      expect(m.openGraph?.title).toBe(msg('Site.taxonomy.tagTitle', { name: 'Lessons' }))
      expect(m.twitter?.title).toBe(msg('Site.taxonomy.tagTitle', { name: 'Lessons' }))
      // Lost by the two routes that DID write their own openGraph block. Present here
      // because the helper restates it for every route.
      expect(m.openGraph?.locale).toBe('vi_VN')
      expect(m.openGraph?.siteName).toBe(site.name)
    })

    it('names the tag and sets its own canonical URL', async () => {
      serve(tags)

      expect(await generateMetadata(props('bai-hoc'))).toMatchObject({
        title: msg('Site.taxonomy.tagTitle', { name: 'Lessons' }),
        description: msg('Site.taxonomy.tagDescription', { name: 'Lessons' }),
        // The canonical is built from the slug, not the name: a canonical URL
        // containing the tag name would point at a 404.
        alternates: { canonical: '/tags/bai-hoc' },
      })

      expect(await generateMetadata(props('ci-cd', { page: '2' }))).toMatchObject({
        alternates: { canonical: '/tags/ci-cd?page=2' },
      })
    })

    it('promotes the tag own feed next to the general feed, by slug, on every page of it', async () => {
      serve(tags)

      for (const searchParams of [{}, { page: '2' }]) {
        expect((await generateMetadata(props('ci-cd', searchParams))).alternates?.types).toEqual({
          'application/rss+xml': [
            { url: '/feed.xml', title: site.name },
            { url: '/tags/ci-cd/feed.xml', title: `CI/CD — ${site.name}` },
          ],
        })
      }
    })

    it('does not throw for an unknown slug or an unreachable API', async () => {
      serve(tags)
      expect(await generateMetadata(props('khong-ton-tai'))).toEqual({
        title: msg('Site.taxonomy.tagNotFoundTitle'),
      })

      vi.mocked(getTag).mockRejectedValue(new Error('down'))
      expect(await generateMetadata(props('bai-hoc'))).toEqual({ title: msg('Site.taxonomy.tagNotFoundTitle') })
    })
  })
})
