// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { postUrl } from '@/components/site/ArticleJsonLd'
import { defaultSiteContent } from '@/content/defaults'
import { DEFAULT_LOCALE } from '@/i18n/config'
import { NotFoundError, getPost, getPosts } from '@/lib/api'
import { feedTitle } from '@/lib/metadata'
import { getTag } from '@/lib/taxonomy'
import type { PostSummary, Tag } from '@/lib/types'
import { GET, fetchCache } from './route'

const { site } = defaultSiteContent(DEFAULT_LOCALE)

// Like the neighboring category feed: blocked at the API boundary, lib/feed.ts and lib/markdown.tsx are real.
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  getPosts: vi.fn(),
  getPost: vi.fn(),
}))
vi.mock('@/lib/taxonomy', () => ({ getCategories: vi.fn(), getTags: vi.fn(), getTag: vi.fn() }))

const ORIGIN = 'https://blog.example.com'

const tags: Tag[] = [
  { id: 't1', name: 'CI/CD', slug: 'ci-cd' },
  { id: 't2', name: 'AWS', slug: 'aws' },
]

function post(slug: string, over: Partial<PostSummary> = {}): PostSummary {
  return {
    id: slug,
    title: `Post ${slug}`,
    slug,
    excerpt: null,
    status: 'PUBLISHED',
    category: null,
    tags: [tags[0]!],
    publishedAt: '2026-01-01T00:00:00Z',
    featured: false,
    readingMinutes: 1,
    ...over,
  }
}

function serve(posts: PostSummary[]) {
  vi.mocked(getTag).mockImplementation(async (slug) => {
    const found = tags.find((candidate) => candidate.slug === slug)
    if (!found) throw new NotFoundError('TAG_NOT_FOUND', 'Tag not found')
    return found
  })
  vi.mocked(getPosts).mockResolvedValue({ items: posts, meta: { page: 0, size: 20, totalElements: posts.length, totalPages: 1 } })
  vi.mocked(getPost).mockImplementation(async (slug) => {
    const found = posts.find((candidate) => candidate.slug === slug)
    if (!found) throw new NotFoundError('POST_NOT_FOUND', 'Post not found')
    const content = '[Pipeline](./pipeline) <a href="javascript:alert(1)">x</a> <b onmouseover="alert(2)">bold</b>'
    return { ...found, content, createdAt: '2026-01-01T00:00:00Z', updatedAt: found.updatedAt ?? '' }
  })
}

async function feed(slug: string, locale = 'vi') {
  const res = await GET(new Request(`${ORIGIN}/tags/${slug}/feed.xml`), { params: Promise.resolve({ locale, slug }) })
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
  vi.mocked(getTag).mockReset()
  vi.mocked(getPosts).mockReset()
  vi.mocked(getPost).mockReset()
  vi.restoreAllMocks()
})

describe('/tags/[slug]/feed.xml', () => {
  it('under /en: the taxonomy and posts are asked for English, items link to /en and the channel is English', async () => {
    serve([post('hello', { language: 'en' })])

    const { doc } = await feed('ci-cd', 'en')

    expect(getTag).toHaveBeenCalledWith('ci-cd', 'en')
    expect(getPosts).toHaveBeenCalledWith({ page: 0, size: 20, tag: 'ci-cd', language: 'en' })
    expect(channelText(doc, 'language')).toBe('en')
    expect(doc.getElementsByTagName('item')[0]?.getElementsByTagName('link')[0]?.textContent).toBe(postUrl('hello', 'en'))
  })

  it('filters by the tag slug, published posts only; the channel carries the tag name and the site positioning sentence; content sanitized', async () => {
    serve([post('moi'), post('ban-nhap', { status: 'DRAFT' })])

    const { res, xml, doc } = await feed('ci-cd')

    expect(res.status).toBe(200)
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0)
    // `tag.slug` on the wire, not the name: the backend filters by `tags.slug`.
    expect(getPosts).toHaveBeenCalledWith({ page: 0, size: 20, tag: 'ci-cd', language: 'vi' })
    expect([...doc.getElementsByTagName('item')].map((item) => item.getElementsByTagName('link')[0]?.textContent)).toEqual([
      postUrl('moi'),
    ])
    expect(xml).not.toContain('ban-nhap')
    expect(channelText(doc, 'title')).toBe(await feedTitle(DEFAULT_LOCALE, 'CI/CD'))
    expect(channelText(doc, 'link')).toBe(`${ORIGIN}/tags/ci-cd`)
    expect(channelText(doc, 'description')).toBe(site.positioning)
    expect(doc.getElementsByTagNameNS('http://www.w3.org/2005/Atom', 'link')[0]?.getAttribute('href')).toBe(
      `${ORIGIN}/tags/ci-cd/feed.xml`,
    )

    const html = doc.getElementsByTagNameNS('http://purl.org/rss/1.0/modules/content/', 'encoded')[0]?.textContent ?? ''
    // Relative links are resolved against the post URL, not against the feed URL.
    expect(html).toContain(`href="${ORIGIN}/posts/pipeline"`)
    expect(html).not.toMatch(/javascript:|onmouseover|alert\(/)
  })

  it('the English feed says en and links the /en page and the /en address; items keep the canonical post URLs', async () => {
    serve([post('moi')])

    const { doc } = await feed('ci-cd', 'en')

    expect(channelText(doc, 'language')).toBe('en')
    expect(channelText(doc, 'link')).toBe(`${ORIGIN}/en/tags/${'ci-cd'}`)
    expect(doc.getElementsByTagNameNS('http://www.w3.org/2005/Atom', 'link')[0]?.getAttribute('href')).toBe(
      `${ORIGIN}/en/tags/${'ci-cd'}/feed.xml`,
    )
    expect(doc.getElementsByTagName('item')[0]?.getElementsByTagName('link')[0]?.textContent).toBe(postUrl('moi'))
  })

  it('an unknown slug, or a tag name in place of the slug, is 404 without asking for the post list; a failed lookup is 503', async () => {
    serve([post('moi')])
    for (const slug of ['khong-ton-tai', encodeURIComponent('CI/CD')]) {
      expect((await feed(slug)).res.status, slug).toBe(404)
    }
    expect(getPosts).not.toHaveBeenCalled()

    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(getTag).mockRejectedValue(new TypeError('fetch failed'))
    expect((await feed('ci-cd')).res.status).toBe(503)
  })

  it('a tag that has no post in this language yet is an empty feed, not a 404 (the page shows the same tag)', async () => {
    serve([])

    const { res, doc } = await feed('ci-cd', 'en')

    expect(res.status).toBe(200)
    expect(doc.getElementsByTagName('item')).toHaveLength(0)
  })

  it('reads the backend on every poll, like /feed.xml', () => {
    expect(fetchCache).toBe('force-no-store')
  })
})
