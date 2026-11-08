// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { postUrl } from '@/components/site/ArticleJsonLd'
import { defaultSiteContent } from '@/content/defaults'
import { DEFAULT_LOCALE } from '@/i18n/config'
import { ApiError, NotFoundError, getPost } from '@/lib/api'
import { feedTitle } from '@/lib/metadata'
import { getSeries } from '@/lib/series'
import type { PostSummary, SeriesDetail } from '@/lib/types'
import { GET, fetchCache } from './route'
import { msg } from '@/test/render-intl'

const { site } = defaultSiteContent(DEFAULT_LOCALE)

// Blocked at the API boundary like the other feeds; lib/feed.ts and lib/markdown.tsx are real.
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  getPost: vi.fn(),
}))
vi.mock('@/lib/series', () => ({ getSeries: vi.fn(), getSeriesList: vi.fn() }))

const ORIGIN = 'https://blog.example.com'
const SLUG = 'series-a'

/** Part n in reading order, published on January n. */
function part(n: number, over: Partial<PostSummary> = {}): PostSummary {
  return {
    id: `p${n}`,
    title: `Part ${n}`,
    slug: `phan-${n}`,
    excerpt: null,
    status: 'PUBLISHED',
    category: null,
    tags: [],
    publishedAt: `2026-01-${String(n).padStart(2, '0')}T00:00:00Z`,
    featured: false,
    readingMinutes: 1,
    ...over,
  }
}

function serve(series: SeriesDetail) {
  vi.mocked(getSeries).mockResolvedValue(series)
  vi.mocked(getPost).mockImplementation(async (slug) => {
    const found = series.posts.find((candidate) => candidate.slug === slug)
    if (!found) throw new NotFoundError('POST_NOT_FOUND', 'Post not found')
    const content = 'Next up: [the next part](/posts/phan-sau) <svg onload="alert(1)"></svg><script>alert(2)</script>'
    return { ...found, content, createdAt: '2026-01-01T00:00:00Z', updatedAt: found.updatedAt ?? '' }
  })
}

async function feed(slug: string, locale = 'vi') {
  const res = await GET(new Request(`${ORIGIN}/series/${slug}/feed.xml`), { params: Promise.resolve({ locale, slug }) })
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
  vi.mocked(getSeries).mockReset()
  vi.mocked(getPost).mockReset()
  vi.restoreAllMocks()
})

describe('/series/[slug]/feed.xml', () => {
  it('under /en: the series is read in English and the items link to /en', async () => {
    serve({ id: 's1', title: 'Building a blog', slug: SLUG, description: null, posts: [part(1, { language: 'en' })] })

    const { doc } = await feed(SLUG, 'en')

    expect(getSeries).toHaveBeenCalledWith(SLUG, 'en')
    expect(doc.getElementsByTagName('item')[0]?.getElementsByTagName('link')[0]?.textContent).toBe(postUrl('phan-1', 'en'))
  })

  it('published parts, newest first, at most 20; the series channel; sanitized content', async () => {
    // The reading order is 1..24, so the feed must reverse it; the draft part (the newest date) never gets in.
    const parts = [...Array.from({ length: 24 }, (_, index) => part(index + 1)), part(25, { status: 'DRAFT' })]
    serve({ id: 's1', title: 'Building <this> blog', slug: SLUG, description: null, posts: parts })

    const { res, xml, doc } = await feed(SLUG)

    expect(res.status).toBe(200)
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0)
    expect(getSeries).toHaveBeenCalledWith(SLUG, 'vi')
    expect([...doc.getElementsByTagName('item')].map((item) => item.getElementsByTagName('link')[0]?.textContent)).toEqual(
      Array.from({ length: 20 }, (_, index) => postUrl(`phan-${24 - index}`)),
    )
    expect(xml).not.toContain('phan-25')
    expect(channelText(doc, 'title')).toBe(await feedTitle(DEFAULT_LOCALE, 'Building <this> blog'))
    expect(channelText(doc, 'link')).toBe(`${ORIGIN}/series/${SLUG}`)
    expect(channelText(doc, 'description')).toBe(site.positioning)
    expect(doc.getElementsByTagNameNS('http://www.w3.org/2005/Atom', 'link')[0]?.getAttribute('href')).toBe(
      `${ORIGIN}/series/${SLUG}/feed.xml`,
    )

    const html = doc.getElementsByTagNameNS('http://purl.org/rss/1.0/modules/content/', 'encoded')[0]?.textContent ?? ''
    expect(html).toContain(`href="${ORIGIN}/posts/phan-sau"`)
    expect(html).not.toMatch(/<svg|onload|<script|alert\(/)
  })

  it('the English feed says en and links the /en page and the /en address; items keep the canonical post URLs', async () => {
    serve({ id: 's1', title: 'Building a blog', slug: SLUG, description: null, posts: [part(1)] })

    const { doc } = await feed(SLUG, 'en')

    expect(channelText(doc, 'language')).toBe('en')
    expect(channelText(doc, 'link')).toBe(`${ORIGIN}/en/series/${SLUG}`)
    expect(doc.getElementsByTagNameNS('http://www.w3.org/2005/Atom', 'link')[0]?.getAttribute('href')).toBe(
      `${ORIGIN}/en/series/${SLUG}/feed.xml`,
    )
    expect(doc.getElementsByTagName('item')[0]?.getElementsByTagName('link')[0]?.textContent).toBe(postUrl('phan-1'))
  })

  it('unknown series (backend 404) or one with no parts left is 404; any other error is 503', async () => {
    vi.mocked(getSeries).mockRejectedValue(new NotFoundError('SERIES_NOT_FOUND', 'Series not found'))
    expect((await feed('khong-ton-tai')).res.status).toBe(404)

    serve({ id: 's1', title: 'Empty', slug: SLUG, description: msg('Admin.topics.manager.descriptionLabel'), posts: [] })
    expect((await feed(SLUG)).res.status).toBe(404)

    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(getSeries).mockRejectedValue(new ApiError(500, 'INTERNAL_ERROR', 'boom'))
    const failed = await feed(SLUG)
    expect(failed.res.status).toBe(503)
    expect(failed.xml).not.toContain('<rss')
  })

  it('reads the backend on every poll, like /feed.xml', () => {
    expect(fetchCache).toBe('force-no-store')
  })
})
