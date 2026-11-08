import { defaultSiteContent } from '@/content/defaults'
import { TEST_LOCALE } from '@/test/intl'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NotFoundError, getPosts } from '@/lib/api'
import { absoluteUrl } from '@/lib/site'
import { getCategory } from '@/lib/taxonomy'
import type { Category, PostSummary } from '@/lib/types'
import CategoryArchive, { generateMetadata, revalidate } from './page'
import { DEBUG_SLUG } from '@/test/fixtures/vi/category-feed'
import { msg } from '@/test/render-intl'

// The sidebar frame is tested once (BrowseFrame.test.tsx); here a stand-in records what the page asked for.
vi.mock('@/components/site/BrowseFrame', () => import('@/test/browse-frame-mock'))

const { site } = defaultSiteContent(TEST_LOCALE)

/**
 * Same approach as app/writing/page.test.tsx: `CategoryArchive` is an async Server
 * Component, so it is called as the plain exported async function it is and the
 * returned tree is handed to RTL. `notFound()` is the real one — it throws an Error
 * whose `digest` is 'NEXT_HTTP_ERROR_FALLBACK;404', which is the only way a test can
 * tell a real 404 from a page that carried on rendering.
 */
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  getPosts: vi.fn(),
}))
vi.mock('@/lib/taxonomy', () => ({ getCategory: vi.fn() }))

const categories: Category[] = [
  { id: 'c1', name: 'Architecture', slug: 'kien-truc', description: null },
  {
    id: 'c2',
    name: 'How I work',
    slug: 'cach-toi-lam-viec',
    description: 'Process, verification, and not trusting a green build.',
  },
]

/** The backend detail: the category with exactly this slug, a 404 for any other. */
function serve(list: Category[]) {
  vi.mocked(getCategory).mockImplementation(async (slug) => {
    const found = list.find((entry) => entry.slug === slug)
    if (!found) throw new NotFoundError('CATEGORY_NOT_FOUND', 'not found')
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

/** Echoes the requested page back in `meta.page`, as the backend does. */
function respond({ totalPages, items }: { totalPages: number; items: PostSummary[] }) {
  serve(categories)
  vi.mocked(getPosts).mockImplementation(async ({ page, size }) => ({
    items,
    meta: { page, size, totalElements: totalPages * size, totalPages },
  }))
}

function props(
  slug: string,
  searchParams: Record<string, string | string[] | undefined> = {},
): PageProps<'/[locale]/categories/[slug]'> {
  return { params: Promise.resolve({ locale: 'vi', slug }), searchParams: Promise.resolve(searchParams) }
}

async function expectNotFound(pageProps: PageProps<'/[locale]/categories/[slug]'>, why: string) {
  const thrown = await CategoryArchive(pageProps).then(
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
  vi.mocked(getCategory).mockReset()
  vi.unstubAllEnvs()
})

describe('/categories/[slug]', () => {
  it('filters the list by the category slug and names it in the heading', async () => {
    respond({ totalPages: 2, items: [summary(1), summary(2)] })

    const { container } = render(await CategoryArchive(props('cach-toi-lam-viec')))

    expect(getPosts).toHaveBeenCalledWith({ page: 0, size: 10, category: 'cach-toi-lam-viec', language: 'vi' })
    expect(container.querySelectorAll('li > article')).toHaveLength(2)

    // One h1, naming what is filtered, and no second <main> — app/layout.tsx owns the
    // document's only one.
    expect(container.querySelectorAll('h1')).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('How I work')
    expect(container.querySelector('main')).toBeNull()

    // The way back. Without it an archive is a dead end for anyone who arrived from a
    // search result rather than from /writing.
    expect(screen.getByRole('link', { name: msg('Site.taxonomy.backToAll') })).toHaveAttribute('href', '/writing')

    expect(screen.getByText('Process, verification, and not trusting a green build.')).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: msg('Site.pagination.label') })).toBeInTheDocument()
  })

  it('sits in the frame with Topics as the parent row (aria-current=true): header, list and pagination are its children', async () => {
    respond({ totalPages: 2, items: [summary(1), summary(2)] })

    const { container } = render(await CategoryArchive(props('cach-toi-lam-viec')))

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

  it('post rows do not repeat the category the h1 already states (showCategory={false})', async () => {
    const kienTruc = categories[0]!
    respond({
      totalPages: 1,
      items: [
        { ...summary(1), category: kienTruc },
        { ...summary(2), category: kienTruc },
      ],
    })

    const { container } = render(await CategoryArchive(props('kien-truc')))

    // Every row here belongs to this category: an "Architecture" link on each row is a link to
    // the very page being read. The category name is left only in the h1.
    expect(container.querySelector('a[href^="/categories/"]')).toBeNull()
    expect(screen.queryByRole('link', { name: 'Architecture' })).not.toBeInTheDocument()
    // Pair of the "yes" assertion: the h1 carries the category name, and both rows still have their titled link.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Architecture')
    expect(container.querySelectorAll('li > article')).toHaveLength(2)
    expect(screen.getByRole('link', { name: 'Post 1' })).toHaveAttribute('href', '/posts/bai-viet-1')
  })

  it('pages within the category, keeping the slug in every pager href', async () => {
    respond({ totalPages: 5, items: [summary(1)] })

    render(await CategoryArchive(props('kien-truc', { page: '3' })))

    expect(getPosts).toHaveBeenCalledWith({ page: 3, size: 10, category: 'kien-truc', language: 'vi' })
    expect(screen.getByText(msg('Site.pagination.status', { page: 4, total: 5 }))).toBeInTheDocument()
    // A basePath of '/writing' or '/' here would send every pager link off the archive
    // and silently drop the filter, with the pager label still reading correctly.
    expect(screen.getByRole('link', { name: msg('Site.pagination.previous') })).toHaveAttribute(
      'href',
      '/categories/kien-truc?page=2',
    )
    expect(screen.getByRole('link', { name: msg('Site.pagination.next') })).toHaveAttribute(
      'href',
      '/categories/kien-truc?page=4',
    )
  })

  it('404s a slug that matches no category, instead of an empty list', async () => {
    respond({ totalPages: 3, items: [] })

    // THE soft-404 rule. The API answers 200 with an empty page for an unknown
    // category — measured — so a page that trusted it would render a heading naming a
    // category that does not exist, with HTTP 200 on it, and a search engine would
    // index /categories/<any typo> forever.
    await expectNotFound(props('khong-ton-tai'), 'unknown slug')

    // And it must not have asked for posts: the question "does this category exist" is
    // answerable without a listing call, and a soft 404 that still costs a query is
    // both wrong and slow.
    expect(getPosts).not.toHaveBeenCalled()
  })

  it('404s a slug that differs only by case or by trailing text', async () => {
    // `find` is an exact comparison on purpose. A case-insensitive or `startsWith`
    // match would make /categories/Kien-Truc and /categories/kien-truc-x both 200,
    // which is duplicate content pointing at the same list.
    for (const slug of ['Kien-Truc', 'KIEN-TRUC', 'kien-truc-x', 'kien', '']) {
      respond({ totalPages: 3, items: [summary(1)] })
      await expectNotFound(props(slug), `slug=${JSON.stringify(slug)}`)
      vi.mocked(getPosts).mockReset()
      vi.mocked(getCategory).mockReset()
    }
  })

  it('decodes a percent-encoded slug before matching it', async () => {
    // Route params are NOT url-decoded by Next (searchParams are), so a link to a slug
    // with any non-ASCII character arrives encoded. Dropping normalizeSlug would 404
    // every such archive while the plain-ASCII ones kept working — a bug that only one
    // half of the data can see.
    serve([{ id: 'c9', name: 'Debugging', slug: DEBUG_SLUG, description: null }])
    vi.mocked(getPosts).mockResolvedValue({
      items: [summary(1)],
      meta: { page: 0, size: 10, totalElements: 1, totalPages: 1 },
    })

    render(await CategoryArchive(props(encodeURIComponent(DEBUG_SLUG))))

    expect(getPosts).toHaveBeenCalledWith({ page: 0, size: 10, category: DEBUG_SLUG, language: 'vi' })
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Debugging')
  })

  it('404s a page index too large to be a real request, without asking the API', async () => {
    for (const page of ['10001', '2147483647', '2147483648', '9999999999999999999999']) {
      respond({ totalPages: 3, items: [summary(1)] })
      vi.mocked(getPosts).mockClear()
      vi.mocked(getCategory).mockClear()

      await expectNotFound(props('kien-truc', { page }), `?page=${page}`)

      expect(getPosts, `?page=${page} must not reach the API`).not.toHaveBeenCalled()
      // The MAX_PAGE refusal is first, before the existence check too: an absurd page
      // of a real category is still a page that does not exist, knowable without any
      // network call at all.
      expect(getCategory, `?page=${page} must not reach the API`).not.toHaveBeenCalled()
    }
  })

  it('falls back to the first page for a ?page the API should never be sent', async () => {
    for (const page of ['abc', '-1', '', 'Infinity', '1.5', '0x2', '2abc', '+2', ' ']) {
      respond({ totalPages: 3, items: [summary(1)] })

      render(await CategoryArchive(props('kien-truc', { page })))

      expect(getPosts, `?page=${page}`).toHaveBeenCalledWith({
        page: 0,
        size: 10,
        category: 'kien-truc',
        language: 'vi',
      })
      vi.mocked(getPosts).mockReset()
    }
  })

  it('takes the first value when ?page is repeated', async () => {
    respond({ totalPages: 9, items: [summary(1)] })

    render(await CategoryArchive(props('kien-truc', { page: ['2', '5'] })))

    expect(getPosts).toHaveBeenCalledWith({ page: 2, size: 10, category: 'kien-truc', language: 'vi' })
  })

  it('404s for a page past the last one instead of showing an empty list', async () => {
    for (const page of ['2', '99']) {
      respond({ totalPages: 2, items: [] })

      await expectNotFound(props('kien-truc', { page }), `?page=${page}`)

      vi.mocked(getPosts).mockReset()
      vi.mocked(getCategory).mockReset()
    }
  })

  it('asks for the category in the page language and offers the other language when it has no posts here', async () => {
    serve(categories)
    vi.mocked(getPosts).mockImplementation(async ({ page, size, language }) => {
      const total = language === 'en' ? 2 : 0
      return { items: [], meta: { page, size, totalElements: total, totalPages: total > 0 ? 1 : 0 } }
    })

    render(await CategoryArchive(props('kien-truc')))

    expect(getCategory).toHaveBeenCalledWith('kien-truc', 'vi')
    expect(getPosts).toHaveBeenCalledWith({ page: 0, size: 1, category: 'kien-truc', language: 'en' })
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Architecture')
    expect(screen.getByRole('link', { name: msg('Site.languageFallback.link', { language: 'English' }) })).toHaveAttribute(
      'href',
      '/en/categories/kien-truc',
    )
    expect(screen.queryByText(msg('Site.taxonomy.categoryEmpty'))).not.toBeInTheDocument()
  })

  it('renders the empty state for a real but empty category rather than 404ing', async () => {
    // A category that exists and has nothing published yet is a real page. totalPages
    // is 0, so a rule written as `current >= meta.totalPages` alone would 404 it.
    respond({ totalPages: 0, items: [] })

    const { container } = render(await CategoryArchive(props('kien-truc')))

    expect(screen.getByText(msg('Site.taxonomy.categoryEmpty'))).toBeInTheDocument()
    expect(container.querySelector('article')).toBeNull()
    expect(screen.queryByRole('navigation', { name: msg('Site.pagination.label') })).not.toBeInTheDocument()
  })

  it('404s for a page other than the first of an empty category', async () => {
    respond({ totalPages: 0, items: [] })

    await expectNotFound(props('kien-truc', { page: '1' }), 'page 1 of an empty category')
  })

  it('lets a category-list failure be a 500 and never a 404', async () => {
    // The tempting shape is `get{Kind}().catch(() => [])`, and it is the worst bug
    // available on this page: a transport blip would make EVERY category archive 404 at
    // once, and 404s get cached. "I could not tell" must be a 500. lib/taxonomy.ts
    // throws on a non-2xx for exactly this reason.
    const boom = new Error('categories unreachable')
    vi.mocked(getCategory).mockRejectedValue(boom)
    vi.mocked(getPosts).mockResolvedValue({
      items: [],
      meta: { page: 0, size: 10, totalElements: 0, totalPages: 0 },
    })

    const thrown = await CategoryArchive(props('kien-truc')).then(
      () => null,
      (error: unknown) => error,
    )
    expect(thrown).toBe(boom)
    expect((thrown as { digest?: string }).digest).toBeUndefined()
  })

  it('has a heading outline that descends without skipping a level', async () => {
    respond({ totalPages: 2, items: [summary(1), summary(2)] })

    const { container } = render(await CategoryArchive(props('kien-truc')))

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
      respond({ totalPages: 2, items: [summary(1), summary(2)] })

      const { container } = render(await CategoryArchive(props('cach-toi-lam-viec')))
      const m = await generateMetadata(props('cach-toi-lam-viec'))
      const [page] = jsonLd(container)

      expect(page).toMatchObject({
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        // The page title, not only the h1: "Architecture" is both a category and a tag on this site,
        // and "Category: …" is what tells the two pages apart.
        name: msg('Site.taxonomy.categoryTitle', { name: 'How I work' }),
        description: 'Process, verification, and not trusting a green build.',
        url: 'https://blog.example.com/categories/cach-toi-lam-viec',
      })
      // Same strings as og:title, meta description and canonical: one construction, not two.
      expect(page!.name).toBe(m.openGraph?.title)
      expect(page!.description).toBe(m.description)
      expect(page!.url).toBe(absoluteUrl(m.alternates?.canonical as string))
    })

    it('category with no description: description is the metadata description sentence, not left empty', async () => {
      respond({ totalPages: 1, items: [summary(1)] })

      const { container } = render(await CategoryArchive(props('kien-truc')))
      const m = await generateMetadata(props('kien-truc'))
      const [page] = jsonLd(container)

      expect(page!.description).toBe(msg('Site.taxonomy.categoryDescription', { name: 'Architecture' }))
      expect(page!.description).toBe(m.description)
    })

    it('ItemList is exactly the posts this page shows, in the order shown, absolute URLs from position 1', async () => {
      vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://blog.example.com')
      respond({ totalPages: 2, items: [summary(2), summary(1)] })

      const { container } = render(await CategoryArchive(props('kien-truc')))
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

      const { container } = render(await CategoryArchive(props('kien-truc', { page: '3' })))
      const m = await generateMetadata(props('kien-truc', { page: '3' }))
      const [page] = jsonLd(container)

      expect(page!.url).toBe('https://blog.example.com/categories/kien-truc?page=3')
      expect(page!.url).toBe(absoluteUrl(m.alternates?.canonical as string))
      // ?page counts from 0, position counts from 1: page 3 with 10 posts per page starts with the 31st post.
      expect(itemList(page!).map((item) => item.position)).toEqual([31, 32])
    })

    it('no BreadcrumbList: the "← All posts" link is the way back, not a breadcrumb', async () => {
      respond({ totalPages: 1, items: [summary(1)] })

      const { container } = render(await CategoryArchive(props('kien-truc')))

      expect(screen.queryByRole('navigation', { name: msg('Site.breadcrumb.label') })).not.toBeInTheDocument()
      expect(screen.getByRole('link', { name: msg('Site.taxonomy.backToAll') })).toBeInTheDocument()
      // Exactly one block, and it is the CollectionPage: the absence assertion is not green just because the page has no JSON-LD at all.
      expect(jsonLd(container).map((block) => block['@type'])).toEqual(['CollectionPage'])
    })

    it('category with no posts: no JSON-LD at all, not an empty ItemList', async () => {
      respond({ totalPages: 0, items: [] })

      const { container } = render(await CategoryArchive(props('kien-truc')))

      expect(screen.getByText(msg('Site.taxonomy.categoryEmpty'))).toBeInTheDocument()
      expect(jsonLd(container)).toEqual([])
    })
  })

  describe('generateMetadata', () => {
    /**
     * og:url must BE the canonical, and og:title must describe this page.
     *
     * Measured on the running dev server before lib/metadata.ts existed: this route
     * emitted `og:title = "the owner name"` and `og:url = "http://localhost:3000"` —
     * the homepage's — because it declared `title`/`description`/`alternates` but no
     * `openGraph`, and Next inherits that object whole rather than deriving it from the
     * page's own title. A share of this page rendered the homepage's card.
     */
    it('describes ITSELF in the share card, not the homepage', async () => {
      serve(categories)

      const m = await generateMetadata(props('kien-truc', { page: '2' }))

      expect(m.openGraph?.url).toBe(m.alternates?.canonical)
      expect(m.openGraph?.url).toBe('/categories/kien-truc?page=2')
      expect(m.openGraph?.title).toBe(msg('Site.taxonomy.categoryTitle', { name: 'Architecture' }))
      expect(m.twitter?.title).toBe(msg('Site.taxonomy.categoryTitle', { name: 'Architecture' }))
      // Lost by the two routes that DID write their own openGraph block. Present here
      // because the helper restates it for every route.
      expect(m.openGraph?.locale).toBe('vi_VN')
      expect(m.openGraph?.siteName).toBe(site.name)
    })

    it('names the category and sets its own canonical URL', async () => {
      serve(categories)

      expect(await generateMetadata(props('cach-toi-lam-viec'))).toMatchObject({
        title: msg('Site.taxonomy.categoryTitle', { name: 'How I work' }),
        description: 'Process, verification, and not trusting a green build.',
        // Without this, Next inherits `alternates: { canonical: '/' }` from
        // app/layout.tsx and every archive declares itself a duplicate of the homepage
        // — measured live on /posts/[slug], which does exactly that today.
        alternates: { canonical: '/categories/cach-toi-lam-viec' },
      })

      // Page kept, not collapsed to page one.
      expect(await generateMetadata(props('kien-truc', { page: '2' }))).toMatchObject({
        alternates: { canonical: '/categories/kien-truc?page=2' },
      })

      // A category with no description still needs one for the <meta>.
      expect(await generateMetadata(props('kien-truc'))).toMatchObject({
        title: msg('Site.taxonomy.categoryTitle', { name: 'Architecture' }),
        description: msg('Site.taxonomy.categoryDescription', { name: 'Architecture' }),
      })
    })

    it('promotes the category own feed next to the general feed, on every page of it', async () => {
      serve(categories)

      for (const searchParams of [{}, { page: '2' }]) {
        expect((await generateMetadata(props('kien-truc', searchParams))).alternates?.types).toEqual({
          'application/rss+xml': [
            { url: '/feed.xml', title: site.name },
            { url: '/categories/kien-truc/feed.xml', title: `Architecture — ${site.name}` },
          ],
        })
      }
    })

    it('does not throw for an unknown slug or an unreachable API', async () => {
      // The page body answers 404 / 500. generateMetadata runs for the same request and
      // must not turn either into an unhandled error, which would replace the page's own
      // answer with a 500.
      serve(categories)
      expect(await generateMetadata(props('khong-ton-tai'))).toEqual({
        title: msg('Site.taxonomy.categoryNotFoundTitle'),
      })

      vi.mocked(getCategory).mockRejectedValue(new Error('down'))
      expect(await generateMetadata(props('kien-truc'))).toEqual({
        title: msg('Site.taxonomy.categoryNotFoundTitle'),
      })
    })
  })
})
