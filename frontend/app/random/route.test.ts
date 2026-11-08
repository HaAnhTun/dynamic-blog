// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_LOCALE } from '@/i18n/config'
import { fetchAllPublishedPosts } from '@/lib/published-posts'
import type { PostSummary } from '@/lib/types'
import { GET } from './route'
import { ACCENTED_SLUG_RANDOM } from '@/test/fixtures/vi/apiUnit-routes'

vi.mock('@/lib/published-posts', () => ({ fetchAllPublishedPosts: vi.fn() }))

function post(slug: string): PostSummary {
  return {
    id: `id-${slug}`,
    title: slug,
    slug,
    excerpt: null,
    status: 'PUBLISHED',
    category: null,
    tags: [],
    featured: false,
    readingMinutes: 2,
    publishedAt: '2026-10-03T00:00:00Z',
  }
}

/** The origin `next dev` and `next start` give `request.url`: their own host and port. */
const SITE = 'http://localhost:3000'

/** A click on "Read a random post": GET /random, carrying the page it was made on as Referer (or none). */
function click(referer?: string, url = `${SITE}/random`): Request {
  return new Request(url, referer === undefined ? undefined : { headers: { referer } })
}

beforeEach(() => {
  vi.mocked(fetchAllPublishedPosts).mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('GET /random', () => {
  it('with posts, 307 to one post, a relative Location', async () => {
    vi.mocked(fetchAllPublishedPosts).mockResolvedValue([post('mot'), post('hai'), post('ba')])
    vi.spyOn(Math, 'random').mockReturnValue(0.5)

    const res = await GET(click())

    expect(res.status).toBe(307)
    // Relative: an absolute Location built from the Host behind a reverse proxy can point at the wrong origin.
    expect(res.headers.get('location')).toBe('/posts/hai')
  })

  it('picks by Math.random across the whole list, including the first and last posts', async () => {
    vi.mocked(fetchAllPublishedPosts).mockResolvedValue([post('dau'), post('giua'), post('cuoi')])
    const random = vi.spyOn(Math, 'random')

    random.mockReturnValue(0)
    expect((await GET(click())).headers.get('location')).toBe('/posts/dau')
    random.mockReturnValue(0.9999)
    expect((await GET(click())).headers.get('location')).toBe('/posts/cuoi')
  })

  it('is never cached: every click must be a new pick', async () => {
    vi.mocked(fetchAllPublishedPosts).mockResolvedValue([post('mot')])

    const cacheControl = (await GET(click())).headers.get('cache-control') ?? ''

    expect(cacheControl).toContain('no-store')
    expect(cacheControl).toContain('private')
    expect(cacheControl).toContain('max-age=0')
  })

  it('the slug is encoded like every other post link', async () => {
    vi.mocked(fetchAllPublishedPosts).mockResolvedValue([post(ACCENTED_SLUG_RANDOM)])

    expect((await GET(click())).headers.get('location')).toBe('/posts/ti%E1%BA%BFng%20vi%E1%BB%87t')
  })

  it('with no posts yet, goes to /writing', async () => {
    vi.mocked(fetchAllPublishedPosts).mockResolvedValue([])

    const res = await GET(click())

    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('/writing')
  })

  it('when reading posts fails, still 307 to /writing, never 500, and logs a warning', async () => {
    vi.mocked(fetchAllPublishedPosts).mockRejectedValue(new Error('API down'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const res = await GET(click(`${SITE}/posts/hai`))

    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('/writing')
    expect(res.headers.get('cache-control')).toContain('no-store')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('API down'))
  })

  it('asks for the visitor language: the default one without a prefix, /en under the English site', async () => {
    vi.mocked(fetchAllPublishedPosts).mockResolvedValue([{ ...post('one'), language: 'en' }])
    vi.spyOn(Math, 'random').mockReturnValue(0)

    const res = await GET(click(`${SITE}/en/writing`))

    expect(fetchAllPublishedPosts).toHaveBeenCalledWith('en')
    expect(res.headers.get('location')).toBe('/en/posts/one')
    await GET(click(`${SITE}/writing`))
    expect(fetchAllPublishedPosts).toHaveBeenLastCalledWith(DEFAULT_LOCALE)
  })

  it('recognises /en/posts/<slug> as the current post', async () => {
    vi.mocked(fetchAllPublishedPosts).mockResolvedValue([
      { ...post('one'), language: 'en' },
      { ...post('two'), language: 'en' },
    ])
    vi.spyOn(Math, 'random').mockReturnValue(0)

    expect((await GET(click(`${SITE}/en/posts/one`))).headers.get('location')).toBe('/en/posts/two')
  })

  it('falls back to /writing of the visitor language, and to every language when theirs has no post', async () => {
    vi.mocked(fetchAllPublishedPosts).mockResolvedValue([])
    expect((await GET(click(`${SITE}/en/about`))).headers.get('location')).toBe('/en/writing')
    expect(fetchAllPublishedPosts).toHaveBeenCalledTimes(2)
    expect(fetchAllPublishedPosts).toHaveBeenLastCalledWith()
  })
})

/**
 * "Read a random post" clicked from a post must not send the reader back to that same post.
 *
 * The post being read comes from the Referer: the link to /random is a same-origin `<a rel="nofollow">` (Footer, the "Discover" block,
 * /writing), and the `Referrer-Policy: strict-origin-when-cross-origin` of next.config.ts sends the full
 * path for a same-origin request — next-config.test.ts pins that policy for /posts/*.
 */
describe('GET /random: does not re-pick the post being read', () => {
  const THREE = [post('mot'), post('hai'), post('ba')]

  it.each([
    ['plain path', `${SITE}/posts/hai`],
    ['with a query', `${SITE}/posts/hai?utm_source=rss`],
  ])('Referer is a post page (%s): never picks that post, even when Math.random lands exactly on it', async (_label, referer) => {
    vi.mocked(fetchAllPublishedPosts).mockResolvedValue(THREE)
    const random = vi.spyOn(Math, 'random')

    // 0.5 across three posts is 'hai', exactly the post being read; the other values cover both ends of the range.
    const picked = new Set<string | null>()
    for (const value of [0, 0.34, 0.5, 0.66, 0.9999]) {
      random.mockReturnValue(value)
      picked.add((await GET(click(referer))).headers.get('location'))
    }

    // Not just "no 'hai'": the other two posts are both reachable, from the start to the end of the list.
    expect(picked).toEqual(new Set(['/posts/mot', '/posts/ba']))
  })

  it('a blog with a single post: still redirects to it, even when the reader is on that very post', async () => {
    vi.mocked(fetchAllPublishedPosts).mockResolvedValue([post('mot')])

    const res = await GET(click(`${SITE}/posts/mot`))

    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('/posts/mot')
  })

  it('the slug in the Referer is read the way the post page reads params: decoded once, then NFC', async () => {
    // "a Vietnamese phrase with diacritics" written in decomposed form (e + combining mark) in the URL: normalizeSlug, the function the post page uses,
    // brings it back to the exact prebuilt slug of the post.
    const composed = ACCENTED_SLUG_RANDOM
    vi.mocked(fetchAllPublishedPosts).mockResolvedValue([post(composed), post('khac')])
    vi.spyOn(Math, 'random').mockReturnValue(0)

    const referer = `${SITE}/posts/${encodeURIComponent(composed.normalize('NFD'))}`

    expect((await GET(click(referer))).headers.get('location')).toBe('/posts/khac')
  })

  it('behind a reverse proxy: a Referer on the public origin (NEXT_PUBLIC_SITE_URL) is still the same site', async () => {
    // `request.url` under `next start` carries the host and port Next is listening on (resolve-routes.js), not the
    // domain the reader sees; that domain is NEXT_PUBLIC_SITE_URL.
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://blog.example.com')
    vi.mocked(fetchAllPublishedPosts).mockResolvedValue(THREE)
    vi.spyOn(Math, 'random').mockReturnValue(0.5)

    const res = await GET(click('https://blog.example.com/posts/hai', 'http://0.0.0.0:3000/random'))

    // 0.5 across the remaining two posts ['mot', 'ba'] is 'ba'.
    expect(res.headers.get('location')).toBe('/posts/ba')
  })

  it.each([
    ['another site', 'https://blog-khac.example/posts/hai'],
    ['same host, other port', 'http://localhost:3001/posts/hai'],
    ['a page that is not a post', `${SITE}/tags/hai`],
    ['a sub-path of a post', `${SITE}/posts/hai/opengraph-image`],
    ['broken percent-encoding', `${SITE}/posts/%E0%A4%A`],
    ['not a URL', '/posts/hai'],
    ['empty', ''],
  ])('Referer is %s: ignored, picks across the whole list, no warning', async (_label, referer) => {
    vi.mocked(fetchAllPublishedPosts).mockResolvedValue(THREE)
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const res = await GET(click(referer))

    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('/posts/hai')
    expect(warn).not.toHaveBeenCalled()
  })
})
