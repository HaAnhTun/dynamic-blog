import { render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultSiteContent } from '@/content/defaults'
import { MEASURE_SMALL } from '@/components/site/reader/reader-layout'
import { TEST_LOCALE } from '@/test/intl'
import { fetchAllPublishedPosts } from '@/lib/published-posts'
import { absoluteUrl } from '@/lib/site'
import { getCategories, getTags } from '@/lib/taxonomy'
import type { Category, PostSummary, Tag } from '@/lib/types'
import { glyphName } from '@/test/glyphs'
import TopicsPage, { dynamic, generateMetadata } from './page'
import { pageProps } from '@/test/page-props'
import { VIETNAMESE_SORTED_TAG } from '@/test/fixtures/vi/topics-tags'
import { msg } from '@/test/render-intl'
import { lastBrowseFrameCall, resetBrowseFrameCalls } from '@/test/browse-frame-mock'

const { site } = defaultSiteContent(TEST_LOCALE)

const metadata = await generateMetadata(pageProps())

/*
 * /topics is the index of categories and tags with post counts. Like WritingIndex, the page is an
 * async function that can be called directly; the element tree it returns is rendered with RTL.
 *
 * Post counts are counted from all published posts (same source as the sitemap and feed), not from a counting
 * endpoint. The category list and all posts are the MAIN CONTENT of the page: a failure throws (500), it does not
 * return a "No topics yet." page that looks real.
 */
// The frame (sidebar + main column) is tested once in BrowseFrame.test.tsx; here it records what the page asked for.
vi.mock('@/components/site/BrowseFrame', () => import('@/test/browse-frame-mock'))
vi.mock('@/lib/taxonomy', () => ({ getCategories: vi.fn(), getTags: vi.fn() }))
vi.mock('@/lib/published-posts', () => ({ fetchAllPublishedPosts: vi.fn() }))

const testing: Category = { id: 'c1', name: 'Testing', slug: 'kiem-thu', description: 'Tests worth writing.' }
const arch: Category = { id: 'c2', name: 'Architecture', slug: 'kien-truc', description: null }
const empty: Category = { id: 'c3', name: 'Unwritten', slug: 'chua-viet', description: msg('Admin.dashboard.noPosts.title') }

const java: Tag = { id: 't1', name: 'Java', slug: 'java' }
const ai: Tag = { id: 't2', name: 'ai', slug: 'ai' }
const anh: Tag = { id: 't3', name: VIETNAMESE_SORTED_TAG, slug: 'anh-xa' }
/** In the backend tag list but used by no post, like `Postgres` today. */
const orphan: Tag = { id: 't4', name: 'Postgres', slug: 'postgres' }

function post(n: number, over: Partial<PostSummary> = {}): PostSummary {
  return {
    id: `p${n}`,
    title: `Post ${n}`,
    slug: `bai-${n}`,
    excerpt: null,
    status: 'PUBLISHED',
    category: null,
    tags: [],
    featured: false,
    readingMinutes: 3,
    publishedAt: '2026-10-03T00:00:00Z',
    ...over,
  }
}

/** "Testing": 3 posts, "Architecture": 1 post, "Not written": 0. "Java": 3 posts; "ai" and a tag starting with an accented A: 1 post per tag. */
const posts: PostSummary[] = [
  post(1, { category: testing, tags: [java, ai] }),
  post(2, { category: testing, tags: [java] }),
  post(3, { category: testing, tags: [java, anh] }),
  post(4, { category: arch }),
]

function respond(all: PostSummary[] = posts, categories: Category[] = [testing, empty, arch]) {
  vi.mocked(getCategories).mockResolvedValue(categories)
  vi.mocked(getTags).mockResolvedValue([java, ai, anh, orphan])
  vi.mocked(fetchAllPublishedPosts).mockResolvedValue(all)
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

afterEach(() => {
  resetBrowseFrameCalls()
  vi.mocked(getCategories).mockReset()
  vi.mocked(getTags).mockReset()
  vi.mocked(fetchAllPublishedPosts).mockReset()
  vi.unstubAllEnvs()
})

describe('/topics', () => {
  it('has exactly one h1 "Topics", inside the frame with "Topics" as the current Explore row, no <main> of its own', async () => {
    respond()

    const { container } = render(await TopicsPage(pageProps()))

    expect(container.querySelectorAll('h1')).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(msg('Site.footer.links.topics'))
    expect(lastBrowseFrameCall()?.current).toEqual({ key: 'topics', exact: true })
    expect(screen.getByTestId('browse-frame')).toContainElement(screen.getByRole('heading', { level: 1 }))
    expect(screen.queryByRole('navigation', { name: msg('Site.listing.sectionNav.label') })).not.toBeInTheDocument()
    expect(container.querySelector('main')).toBeNull()
  })

  it('Categories: link name by slug, with folder icon, post count and description; a category with 0 posts is absent', async () => {
    respond()

    render(await TopicsPage(pageProps()))

    const section = screen.getByRole('region', { name: msg('Site.writing.categories') })
    expect(within(section).getByRole('heading', { level: 2, name: msg('Site.writing.categories') })).toHaveAttribute(
      'id',
      'chuyen-muc',
    )

    const items = within(section).getAllByRole('listitem')
    // The order of the category list (API order), like the filter strip on /writing.
    expect(items.map((li) => within(li).getByRole('link').textContent)).toEqual(['Testing', 'Architecture'])

    const link = within(items[0]!).getByRole('link', { name: 'Testing' })
    expect(link).toHaveAttribute('href', '/categories/kiem-thu')
    expect(glyphName(link.querySelector('svg'))).toBe('FolderIcon')
    expect(items[0]).toHaveTextContent(msg('Admin.topics.manager.usageAll', { count: '3' }))
    expect(items[0]).toHaveTextContent('Tests worth writing.')
    // No description means no empty description paragraph.
    expect(items[1]).toHaveTextContent(msg('Admin.topics.manager.usageAll', { count: '1' }))
    expect(items[1]!.querySelector('p')).toBeNull()

    expect(within(section).queryByRole('link', { name: 'Unwritten' })).not.toBeInTheDocument()
  })

  it('Categories are a card grid (sm:grid-cols-2 xl:grid-cols-3), not hairline rows; tags stay chips', async () => {
    respond()

    render(await TopicsPage(pageProps()))

    const section = screen.getByRole('region', { name: msg('Site.writing.categories') })
    const list = within(section).getByRole('list')
    expect(list).toHaveClass('grid', 'gap-4', 'sm:grid-cols-2', 'xl:grid-cols-3')
    expect(list).not.toHaveClass('divide-y')
    for (const card of within(list).getAllByRole('listitem')) {
      expect(card).toHaveClass('rounded-card', 'border', 'border-neutral-200', 'p-4', 'sm:p-5', 'dark:border-neutral-800')
      // A stretched link: the card is the positioning context and the anchor's ::after covers it, so the whole card is the hit area.
      expect(card).toHaveClass('relative')
      expect(within(card).getByRole('link')).toHaveClass('after:absolute', 'after:inset-0')
    }
    // The description keeps a readable measure.
    expect(within(list).getByText('Tests worth writing.')).toHaveClass(MEASURE_SMALL)
    // Tags are chips (rounded-full), not cards.
    const tags = within(screen.getByRole('region', { name: msg('Site.article.tagsLabel') })).getAllByRole('link')
    for (const chip of tags) expect(chip).toHaveClass('rounded-full')
  })

  it('Tags: chip with count, most posts first then by Vietnamese alphabet; a tag with 0 posts is absent', async () => {
    respond()

    render(await TopicsPage(pageProps()))

    const section = screen.getByRole('region', { name: msg('Site.article.tagsLabel') })
    expect(within(section).getByRole('heading', { level: 2, name: msg('Site.article.tagsLabel') })).toHaveAttribute('id', 'the')

    const chips = within(section).getAllByRole('link')
    // "ai" before the accented-A tag in Vietnamese order; by character code it is the other way round.
    expect(chips.map((a) => a.getAttribute('href'))).toEqual(['/tags/java', '/tags/ai', '/tags/anh-xa'])
    expect(
      within(section).getByRole('link', { name: msg('Admin.topics.manager.usageAll', { count: 'Java 3' }) }),
    ).toBeInTheDocument()
    expect(
      within(section).getByRole('link', { name: msg('Admin.topics.manager.usageAll', { count: 'ai 1' }) }),
    ).toBeInTheDocument()

    // Postgres is in the backend tag list but no post uses it: a link to an empty tag
    // page is not a topic.
    expect(screen.queryByRole('link', { name: /Postgres/ })).not.toBeInTheDocument()
  })

  it('asks for the page language and offers the other language when only that one has topics', async () => {
    vi.mocked(getCategories).mockResolvedValue([])
    vi.mocked(fetchAllPublishedPosts).mockImplementation(async (language) => (language === 'en' ? posts : []))

    render(await TopicsPage(pageProps()))

    expect(getCategories).toHaveBeenCalledWith('vi')
    expect(fetchAllPublishedPosts).toHaveBeenCalledWith('vi')
    expect(screen.getByRole('link', { name: msg('Site.languageFallback.link', { language: 'English' }) })).toHaveAttribute(
      'href',
      '/en/topics',
    )
    expect(screen.queryByText(msg('Site.topics.empty'))).not.toBeInTheDocument()
  })

  it('no topics at all (new blog) says so plainly, and has no empty section', async () => {
    respond([], [testing])

    render(await TopicsPage(pageProps()))

    expect(screen.getByText(msg('Site.topics.empty'))).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: msg('Site.writing.categories') })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: msg('Site.article.tagsLabel') })).not.toBeInTheDocument()
  })

  it('with topics there is no "No topics yet." sentence', async () => {
    respond()

    render(await TopicsPage(pageProps()))

    expect(screen.queryByText(msg('Site.topics.empty'))).not.toBeInTheDocument()
  })

  it('a failing category list throws (500), it does not render an empty page', async () => {
    respond()
    const boom = new Error('categories unreachable')
    vi.mocked(getCategories).mockRejectedValue(boom)

    await expect(TopicsPage(pageProps())).rejects.toBe(boom)
  })

  it('reading all posts failing throws (500): if they cannot be counted there is nothing to show', async () => {
    respond()
    const boom = new Error('posts unreachable')
    vi.mocked(fetchAllPublishedPosts).mockRejectedValue(boom)

    // Swallowing the error here gives "No topics yet." with HTTP 200, a page that looks real and is wrong.
    await expect(TopicsPage(pageProps())).rejects.toBe(boom)
  })

  describe('structured data (JSON-LD)', () => {
    it('CollectionPage /topics carries the exact title, description and canonical that the metadata declares', async () => {
      vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://blog.example.com')
      respond()

      const { container } = render(await TopicsPage(pageProps()))
      const [page] = jsonLd(container)

      expect(page).toMatchObject({
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: msg('Site.footer.links.topics'),
        description: msg('Site.pageDescriptions.topics'),
        url: 'https://blog.example.com/topics',
      })
      // Same strings as og:title, meta description and canonical: one construction, not two.
      expect(page!.name).toBe(metadata.openGraph?.title)
      expect(page!.description).toBe(metadata.description)
      expect(page!.url).toBe(absoluteUrl(metadata.alternates?.canonical as string))
    })

    it('ItemList is the topics the page shows: categories then tags, in the right order, only topics that have posts', async () => {
      vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://blog.example.com')
      respond()

      const { container } = render(await TopicsPage(pageProps()))
      const list = itemList(jsonLd(container)[0]!)

      // "Not written" (0 posts) and "Postgres" (used by no post) are not on the page, so they are not
      // here either. Tags in chip order: most posts first, then Vietnamese alphabet ("ai" before the accented-A tag).
      expect(list.map((item) => [item.position, item.name, item.url])).toEqual([
        [1, 'Testing', 'https://blog.example.com/categories/kiem-thu'],
        [2, 'Architecture', 'https://blog.example.com/categories/kien-truc'],
        [3, 'Java', 'https://blog.example.com/tags/java'],
        [4, 'ai', 'https://blog.example.com/tags/ai'],
        [5, VIETNAMESE_SORTED_TAG, 'https://blog.example.com/tags/anh-xa'],
      ])

      // Matches the visible links, in document order: the category links then the tag chips. The chip URL
      // is built by TagCountChips in another file, so this is where the two sides get caught when they disagree.
      const visible = [
        ...within(screen.getByRole('region', { name: msg('Site.writing.categories') })).getAllByRole('link'),
        ...within(screen.getByRole('region', { name: msg('Site.article.tagsLabel') })).getAllByRole('link'),
      ]
      expect(list.map((item) => new URL(item.url).pathname)).toEqual(visible.map((a) => a.getAttribute('href')))
      list.forEach((item, i) => expect(visible[i]).toHaveTextContent(item.name))
    })

    it('no BreadcrumbList: the page has no visible breadcrumb for it to describe', async () => {
      respond()

      const { container } = render(await TopicsPage(pageProps()))

      expect(screen.queryByRole('navigation', { name: msg('Site.breadcrumb.label') })).not.toBeInTheDocument()
      // Exactly one block, and it is the CollectionPage: the absence assertion is not green just because the page has no JSON-LD at all.
      expect(jsonLd(container).map((block) => block['@type'])).toEqual(['CollectionPage'])
    })

    it('no topics at all: no JSON-LD at all, not an empty ItemList', async () => {
      respond([], [testing])

      const { container } = render(await TopicsPage(pageProps()))

      expect(screen.getByText(msg('Site.topics.empty'))).toBeInTheDocument()
      expect(jsonLd(container)).toEqual([])
    })
  })

  it('renders per request: the Docker build has no API to prerender with', () => {
    expect(dynamic).toBe('force-dynamic')
  })

  it('metadata: its own title, canonical and og:url', () => {
    const m = metadata

    expect(m.title).toBe(msg('Site.footer.links.topics'))
    expect(m.alternates?.canonical).toBe('/topics')
    expect(m.openGraph?.url).toBe('/topics')
    expect(m.openGraph?.siteName).toBe(site.name)
  })
})
