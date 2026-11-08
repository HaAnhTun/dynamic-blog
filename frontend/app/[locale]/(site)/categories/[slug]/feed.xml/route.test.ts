// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { postUrl } from '@/components/site/ArticleJsonLd'
import { defaultSiteContent } from '@/content/defaults'
import { DEFAULT_LOCALE } from '@/i18n/config'
import { NotFoundError, getPost, getPosts } from '@/lib/api'
import { feedTitle } from '@/lib/metadata'
import { DEBUG_SLUG } from '@/test/fixtures/vi/category-feed'
import { getCategory } from '@/lib/taxonomy'
import type { Category, PostSummary } from '@/lib/types'
import { GET, fetchCache } from './route'

const { site } = defaultSiteContent(DEFAULT_LOCALE)

// Blocked at the API boundary like app/feed.xml/route.test.ts; lib/feed.ts and lib/markdown.tsx are real.
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  getPosts: vi.fn(),
  getPost: vi.fn(),
}))
vi.mock('@/lib/taxonomy', () => ({ getCategories: vi.fn(), getTags: vi.fn(), getCategory: vi.fn() }))

const ORIGIN = 'https://blog.example.com'
const DEBUG = DEBUG_SLUG

const categories: Category[] = [
  { id: 'c1', name: 'Architecture', slug: 'kien-truc', description: null },
  { id: 'c2', name: 'Debugging & measuring', slug: DEBUG, description: 'When the numbers say otherwise <hypothesis>.' },
]

function post(slug: string, over: Partial<PostSummary> = {}): PostSummary {
  return {
    id: slug,
    title: `Post ${slug}`,
    slug,
    excerpt: null,
    status: 'PUBLISHED',
    category: categories[0]!,
    tags: [],
    publishedAt: '2026-01-01T00:00:00Z',
    featured: false,
    readingMinutes: 1,
    ...over,
  }
}

function serve(posts: PostSummary[]) {
  vi.mocked(getCategory).mockImplementation(async (slug) => {
    const found = categories.find((candidate) => candidate.slug === slug)
    if (!found) throw new NotFoundError('CATEGORY_NOT_FOUND', 'Category not found')
    return found
  })
  vi.mocked(getPosts).mockResolvedValue({ items: posts, meta: { page: 0, size: 20, totalElements: posts.length, totalPages: 1 } })
  vi.mocked(getPost).mockImplementation(async (slug) => {
    const found = posts.find((candidate) => candidate.slug === slug)
    if (!found) throw new NotFoundError('POST_NOT_FOUND', 'Post not found')
    const content = 'See [the other post](/posts/kia) <img src="x.png" onerror="alert(1)"> <script>alert(2)</script>'
    return { ...found, content, createdAt: '2026-01-01T00:00:00Z', updatedAt: found.updatedAt ?? '' }
  })
}

async function feed(slug: string, locale = 'vi') {
  const res = await GET(new Request(`${ORIGIN}/categories/${slug}/feed.xml`), { params: Promise.resolve({ locale, slug }) })
  const xml = await res.text()
  return { res, xml, doc: new DOMParser().parseFromString(xml, 'application/xml') }
}

function channelText(doc: Document, tag: string): string | null {
  const channel = doc.getElementsByTagName('channel')[0]!
  return [...channel.children].find((child) => child.tagName === tag)?.textContent ?? null
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', ORIGIN)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.mocked(getCategory).mockReset()
  vi.mocked(getPosts).mockReset()
  vi.mocked(getPost).mockReset()
  vi.restoreAllMocks()
})

describe('/categories/[slug]/feed.xml', () => {
  it('under /en: the taxonomy and posts are asked for English, items link to /en and the channel is English', async () => {
    serve([post('hello', { language: 'en' })])

    const { doc } = await feed('kien-truc', 'en')

    expect(getCategory).toHaveBeenCalledWith(expect.any(String), 'en')
    expect(getPosts).toHaveBeenCalledWith({ page: 0, size: 20, category: 'kien-truc', language: 'en' })
    expect(channelText(doc, 'language')).toBe('en')
    expect(doc.getElementsByTagName('item')[0]?.getElementsByTagName('link')[0]?.textContent).toBe(postUrl('hello', 'en'))
  })

  it('only published posts of the category, channel named with its own title, page and address, content sanitized', async () => {
    serve([post('moi'), post('ban-nhap', { status: 'DRAFT' }), post('cu')])

    const { res, xml, doc } = await feed('kien-truc')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/rss+xml; charset=utf-8')
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0)
    expect(getPosts).toHaveBeenCalledWith({ page: 0, size: 20, category: 'kien-truc', language: 'vi' })
    expect([...doc.getElementsByTagName('item')].map((item) => item.getElementsByTagName('link')[0]?.textContent)).toEqual([
      postUrl('moi'),
      postUrl('cu'),
    ])
    expect(xml).not.toContain('ban-nhap')

    expect(channelText(doc, 'title')).toBe(await feedTitle(DEFAULT_LOCALE, 'Architecture'))
    expect(channelText(doc, 'link')).toBe(`${ORIGIN}/categories/kien-truc`)
    // A category with no description: the channel must still have a description (RSS requires it).
    expect(channelText(doc, 'description')).toBe(site.positioning)
    const self = doc.getElementsByTagNameNS('http://www.w3.org/2005/Atom', 'link')[0]
    expect(self?.getAttribute('href')).toBe(`${ORIGIN}/categories/kien-truc/feed.xml`)

    const html = doc.getElementsByTagNameNS('http://purl.org/rss/1.0/modules/content/', 'encoded')[0]?.textContent ?? ''
    expect(html).toContain(`href="${ORIGIN}/posts/kia"`)
    expect(html).not.toMatch(/<script|onerror|alert\(/)
  })

  it('the English feed says en and links the /en page and the /en address; items keep the canonical post URLs', async () => {
    serve([post('moi')])

    const { doc } = await feed('kien-truc', 'en')

    expect(channelText(doc, 'language')).toBe('en')
    expect(channelText(doc, 'link')).toBe(`${ORIGIN}/en/categories/${'kien-truc'}`)
    expect(doc.getElementsByTagNameNS('http://www.w3.org/2005/Atom', 'link')[0]?.getAttribute('href')).toBe(
      `${ORIGIN}/en/categories/${'kien-truc'}/feed.xml`,
    )
    expect(doc.getElementsByTagName('item')[0]?.getElementsByTagName('link')[0]?.textContent).toBe(postUrl('moi'))
  })

  it('unknown slug is 404 without asking for the post list; a failed lookup is 503, never 404', async () => {
    // The API returns 200 with an empty page for an unknown category, so a 404 can only come from the category list.
    serve([post('moi')])
    const unknown = await feed('khong-ton-tai')
    expect(unknown.res.status).toBe(404)
    expect(unknown.xml).not.toContain('<rss')
    expect(getPosts).not.toHaveBeenCalled()

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(getCategory).mockRejectedValue(new TypeError('fetch failed'))
    expect((await feed('kien-truc')).res.status).toBe(503)
    vi.mocked(getCategory).mockImplementation(async (slug) => {
      const found = categories.find((candidate) => candidate.slug === slug)
      if (!found) throw new NotFoundError('CATEGORY_NOT_FOUND', 'Category not found')
      return found
    })
    vi.mocked(getPosts).mockRejectedValue(new TypeError('fetch failed'))
    expect((await feed('kien-truc')).res.status).toBe(503)
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('a Vietnamese slug arriving encoded and with decomposed accents still matches; the category description is used and escaped', async () => {
    serve([post('moi')])

    const { res, doc } = await feed(encodeURIComponent(DEBUG.normalize('NFD')))

    expect(res.status).toBe(200)
    expect(getPosts).toHaveBeenCalledWith({ page: 0, size: 20, category: DEBUG, language: 'vi' })
    expect(channelText(doc, 'title')).toBe(await feedTitle(DEFAULT_LOCALE, 'Debugging & measuring'))
    expect(channelText(doc, 'description')).toBe('When the numbers say otherwise <hypothesis>.')
    expect(channelText(doc, 'link')).toBe(`${ORIGIN}/categories/${encodeURIComponent(DEBUG)}`)
  })

  it('reads the backend on every poll, like /feed.xml', () => {
    expect(fetchCache).toBe('force-no-store')
  })
})
