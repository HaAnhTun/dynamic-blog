// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { postUrl } from '@/components/site/ArticleJsonLd'
import { ApiError, NotFoundError, getPost } from '@/lib/api'
import type { Post, PostSummary } from '@/lib/types'
import { FEED_LIMIT, feedNotFound, feedUnavailable, rssResponse, type FeedChannel } from './feed'
import { msg } from '@/test/render-intl'
import { HOSTILE_TITLE, RED_WORD } from '@/test/fixtures/vi/feed-text'

// Only blocks at the API boundary; lib/markdown.tsx is real, so sanitizing is proven end to end.
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  getPost: vi.fn(),
}))

const ORIGIN = 'https://blog.example.com'
const CONTENT_NS = 'http://purl.org/rss/1.0/modules/content/'
const CHANNEL: FeedChannel = {
  title: 'Channel',
  link: ORIGIN,
  description: msg('Admin.topics.manager.descriptionLabel'),
  selfPath: '/feed.xml',
}

/** A fresh `updatedAt` on every call: the memo is module state, living across the tests in the file. */
let clock = Date.UTC(2026, 4, 1)
function stamp(): string {
  clock += 60_000
  return new Date(clock).toISOString()
}

function summary(slug: string, over: Partial<PostSummary> = {}): PostSummary {
  return {
    id: slug,
    title: `Post ${slug}`,
    slug,
    excerpt: `Summary of ${slug}.`,
    status: 'PUBLISHED',
    category: null,
    tags: [],
    publishedAt: '2026-01-01T00:00:00Z',
    featured: false,
    readingMinutes: 1,
    updatedAt: stamp(),
    ...over,
  }
}

/** GET /api/v1/posts/{slug} of a post in the list: the same version, content optional. */
function detail(post: PostSummary, content = `Content of ${post.slug}.`): Post {
  return { ...post, content, createdAt: '2026-01-01T00:00:00Z', updatedAt: post.updatedAt ?? '' }
}

function serve(posts: PostSummary[], contents: Record<string, string> = {}) {
  vi.mocked(getPost).mockImplementation(async (slug) => {
    const post = posts.find((candidate) => candidate.slug === slug)
    if (!post) throw new NotFoundError('POST_NOT_FOUND', 'Post not found')
    return detail(post, contents[slug])
  })
}

async function build(posts: PostSummary[]) {
  const res = await rssResponse(CHANNEL, posts)
  const xml = await res.text()
  return { res, xml, doc: new DOMParser().parseFromString(xml, 'application/xml') }
}

function items(doc: Document): Element[] {
  return [...doc.getElementsByTagName('item')]
}

function text(parent: Element | Document, tag: string): string | null {
  return parent.getElementsByTagName(tag)[0]?.textContent ?? null
}

/** `<content:encoded>` by namespace: without the `xmlns:content` declaration it does not match. */
function encoded(item: Element): string | null {
  return item.getElementsByTagNameNS(CONTENT_NS, 'encoded')[0]?.textContent ?? null
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', ORIGIN)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.mocked(getPost).mockReset()
  vi.restoreAllMocks()
})

describe('rssResponse: language of the item', () => {
  it('an item links to the URL of the language of its post: /en for English, unprefixed for the default language', async () => {
    const posts = [summary('hello', { language: 'en' }), summary('xin-chao', { language: 'vi' }), summary('cu', {})]
    serve(posts)

    const { doc } = await build(posts)

    expect(items(doc).map((item) => text(item, 'link'))).toEqual([
      `${ORIGIN}/en/posts/hello`,
      `${ORIGIN}/posts/xin-chao`,
      `${ORIGIN}/posts/cu`,
    ])
    expect(items(doc).map((item) => text(item, 'guid'))).toEqual(items(doc).map((item) => text(item, 'link')))
  })
})

describe('rssResponse', () => {
  it('valid XML with Unicode and & < > " \' ]]> in title, summary, content; content:encoded is sanitized HTML, absolute URLs', async () => {
    const ESC = String.fromCharCode(27)
    const hostile = HOSTILE_TITLE
    const post = summary('bai-doc-hai', { title: hostile, excerpt: hostile })
    serve([post], {
      'bai-doc-hai': [
        `## ${hostile}`,
        '',
        'Open <script>alert(1)</script> <img src="x.png" onerror="alert(2)"> [click](javascript:alert(3)) <a href="/a" onclick="alert(4)">a</a> <a href="JaVaScRiPt:alert(5)">b</a>',
        '',
        '[another post](/posts/khac) [section](#muc)',
        '',
        '![diagram](/media/0b5c3f1e-2d4a-4b6c-8d9e-0f1a2b3c4d5e.png#640x480)',
        '',
        '```js',
        `if (a[b[0]]>c) log("${ESC}[31m${RED_WORD}")`,
        '```',
      ].join('\n'),
    })

    const { res, xml, doc } = await build([post])

    expect(res.headers.get('content-type')).toBe('application/rss+xml; charset=utf-8')
    // Real parser: a stray `&`, `<` or control character is a parsererror.
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0)
    expect(doc.documentElement.lookupNamespaceURI('content')).toBe(CONTENT_NS)
    expect(xml).not.toContain('CDATA')
    const item = items(doc)[0]!
    expect(text(item, 'title')).toBe(hostile)
    expect(text(item, 'description')).toBe(hostile)

    const html = encoded(item)!
    const body = new DOMParser().parseFromString(html, 'text/html').body
    expect(body.querySelector('h2')?.textContent).toBe(hostile)
    expect(body.querySelector('script')).toBeNull()
    for (const el of body.querySelectorAll('*')) {
      for (const attr of el.attributes) {
        expect(attr.name, `<${el.tagName.toLowerCase()} ${attr.name}>`).not.toMatch(/^on/i)
        expect(attr.value, `<${el.tagName.toLowerCase()} ${attr.name}>`).not.toMatch(/^\s*javascript:/i)
      }
    }
    expect(html).not.toMatch(/alert\(1\)/)

    const hrefs = [...body.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'))
    expect(hrefs).toEqual(expect.arrayContaining([`${ORIGIN}/posts/khac`, `${postUrl('bai-doc-hai')}#muc`, `${ORIGIN}/a`]))
    expect(hrefs.every((href) => href!.startsWith(`${ORIGIN}/`))).toBe(true)
    const img = body.querySelector('img[src*="/media/"]')!
    expect(img.getAttribute('src')).toBe(`${ORIGIN}/media/0b5c3f1e-2d4a-4b6c-8d9e-0f1a2b3c4d5e.png`)
    expect([img.getAttribute('width'), img.getAttribute('height')]).toEqual(['640', '480'])
    expect(html).not.toContain('#640x480')

    // A bare code block, its `]]>` comes back verbatim; the ESC character (forbidden by XML 1.0) is dropped instead of corrupting the document.
    const code = body.querySelector('pre > code.language-js')!
    expect(code.textContent).toContain('if (a[b[0]]>c) log("[31m' + RED_WORD + '")')
    expect(xml).not.toContain(ESC)
  })

  it('the default locale channel says vi and points its self link at the unprefixed feed', async () => {
    const { doc } = await build([])
    expect(text(doc, 'language')).toBe('vi')
    expect(doc.getElementsByTagName('atom:link')[0]?.getAttribute('href')).toBe(`${ORIGIN}/feed.xml`)
  })

  it('an English channel says en and carries the /en self link, items keep the canonical post URLs', async () => {
    const posts = [summary('mot-bai')]
    serve(posts)
    const res = await rssResponse({ ...CHANNEL, link: `${ORIGIN}/en`, locale: 'en' }, posts)
    const doc = new DOMParser().parseFromString(await res.text(), 'application/xml')
    expect(text(doc, 'language')).toBe('en')
    expect(doc.getElementsByTagName('atom:link')[0]?.getAttribute('href')).toBe(`${ORIGIN}/en/feed.xml`)
    expect(items(doc).map((item) => text(item, 'link'))).toEqual([postUrl('mot-bai')])
  })

  it('a draft never enters the feed: status in the list as well as in the detail', async () => {
    const draft = summary('ban-nhap', { status: 'DRAFT' })
    const unpublished = summary('vua-go')
    const kept = summary('con-lai')
    vi.mocked(getPost).mockImplementation(async (slug) =>
      slug === 'vua-go' ? { ...detail(unpublished), status: 'DRAFT' } : detail(kept),
    )

    const { xml, doc } = await build([draft, unpublished, kept])

    expect(items(doc).map((item) => text(item, 'link'))).toEqual([postUrl('con-lai')])
    expect(xml).not.toContain('ban-nhap')
    expect(xml).not.toContain('vua-go')
    expect(getPost).not.toHaveBeenCalledWith('ban-nhap')
  })

  it('detail 404 (post just unpublished) drops the item; another error keeps the item without content:encoded, and is not remembered', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const gone = summary('vua-xoa')
    const broken = summary('loi-tam')
    const fine = summary('binh-thuong')
    vi.mocked(getPost).mockImplementation(async (slug) => {
      if (slug === 'vua-xoa') throw new NotFoundError('POST_NOT_FOUND', 'Post not found')
      if (slug === 'loi-tam') throw new ApiError(502, undefined, 'Bad gateway')
      return detail(fine)
    })

    const { doc } = await build([gone, broken, fine])

    const [first, second] = items(doc)
    expect(items(doc).map((item) => text(item, 'link'))).toEqual([postUrl('loi-tam'), postUrl('binh-thuong')])
    expect(encoded(first!)).toBeNull()
    expect(text(first!, 'description')).toBe('Summary of loi-tam.')
    expect(encoded(second!)).toContain('Content of binh-thuong.')
    expect(warn).toHaveBeenCalledTimes(1)

    // Next poll: the failed post and the 404 post are asked again, the rendered post is not.
    vi.mocked(getPost).mockClear()
    await build([gone, broken, fine])
    expect(
      vi
        .mocked(getPost)
        .mock.calls.map(([slug]) => slug)
        .sort(),
    ).toEqual(['loi-tam', 'vua-xoa'])
  })

  it('remembers HTML per post + updatedAt: same updatedAt means no detail call, changed updatedAt reads again, missing always reads', async () => {
    const post = summary('nho')
    serve([post], { nho: 'Version one.' })
    expect(encoded(items((await build([post])).doc)[0]!)).toContain('Version one.')
    expect(getPost).toHaveBeenCalledTimes(1)

    vi.mocked(getPost).mockClear()
    expect(encoded(items((await build([post])).doc)[0]!)).toContain('Version one.')
    expect(getPost).not.toHaveBeenCalled()

    const edited = { ...post, updatedAt: stamp() }
    serve([edited], { nho: 'Version two.' })
    expect(encoded(items((await build([edited])).doc)[0]!)).toContain('Version two.')
    expect(getPost).toHaveBeenCalledTimes(1)

    // An old backend does not send updatedAt on the list: never remember by slug alone.
    const unversioned = { ...edited, updatedAt: undefined }
    serve([unversioned], { nho: 'Version three.' })
    vi.mocked(getPost).mockClear()
    await build([unversioned])
    expect(encoded(items((await build([unversioned])).doc)[0]!)).toContain('Version three.')
    expect(getPost).toHaveBeenCalledTimes(2)
  })

  it(`at most ${FEED_LIMIT} items, and at most 4 detail requests at once`, async () => {
    const posts = Array.from({ length: 25 }, (_, index) => summary(`gioi-han-${index}`))
    let inFlight = 0
    let peak = 0
    vi.mocked(getPost).mockImplementation(async (slug) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight -= 1
      return detail(posts.find((post) => post.slug === slug)!)
    })

    const { doc } = await build(posts)

    expect(items(doc).map((item) => text(item, 'link'))).toEqual(posts.slice(0, FEED_LIMIT).map((post) => postUrl(post.slug)))
    expect(getPost).toHaveBeenCalledTimes(FEED_LIMIT)
    expect(peak).toBe(4)
  })

  it('lastBuildDate is the latest change among the present items: updatedAt, or publishedAt when missing or older', async () => {
    const edited = summary('sua-sau', { publishedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-03-03T00:00:00Z' })
    const unversioned = summary('khong-ngay-sua', { publishedAt: '2026-02-02T00:00:00Z', updatedAt: undefined })
    // A post imported from elsewhere may carry an updatedAt older than its publish date; a page cannot change before it exists.
    const imported = summary('nhap-ve', { publishedAt: '2026-02-20T00:00:00Z', updatedAt: '2025-12-01T00:00:00Z' })
    // Dropped because of a detail 404: its date is not counted.
    const gone = summary('da-go', { updatedAt: '2026-12-12T00:00:00Z' })
    serve([edited, unversioned, imported])

    expect(text((await build([edited, unversioned, imported, gone])).doc, 'lastBuildDate')).toBe('Tue, 03 Mar 2026 00:00:00 GMT')
    expect(text((await build([unversioned, imported])).doc, 'lastBuildDate')).toBe('Fri, 20 Feb 2026 00:00:00 GMT')
  })
})

/**
 * A feed is read on every poll (it never goes through the data cache, so a withdrawn post disappears at once), and the response says so:
 * without a freshness rule a shared cache (CloudFront, Fastly, an nginx `proxy_cache_valid`) applies a default of its own and keeps an
 * old feed, with the whole text of every item, or a 503 that has outlived the incident (docs/SECURITY.md, "Caching").
 */
describe('feed responses say how long a cache may keep them', () => {
  const translate = (key: string) => key

  it('a feed is revalidated on every request', async () => {
    const { res } = await build([])
    const rule = res.headers.get('cache-control') ?? ''
    expect(rule).toContain('max-age=0')
    expect(rule).toContain('must-revalidate')
    expect(rule).not.toMatch(/s-maxage/)
  })

  it('a 503 is never stored, and tells a reader when to come back', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const res = feedUnavailable(new Error('backend down'), translate)
    expect(res.status).toBe(503)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('a 404 for a slug that matches nothing is revalidated, not kept', () => {
    const res = feedNotFound(translate)
    expect(res.status).toBe(404)
    expect(res.headers.get('cache-control')).toContain('max-age=0')
    expect(res.headers.get('cache-control')).toContain('must-revalidate')
  })
})
