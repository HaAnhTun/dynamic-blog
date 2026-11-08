// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { postUrl } from '@/components/site/ArticleJsonLd'
import { defaultSiteContent } from '@/content/defaults'
import { DEFAULT_LOCALE } from '@/i18n/config'
import { NotFoundError, getPost, getPosts } from '@/lib/api'
import type { PostSummary } from '@/lib/types'
import { runThroughDataCache, type Answers } from '@/test/next-data-cache'
import { READ_LIMITS } from '@/lib/read-limit'
import { GET } from './route'

/**
 * `GET` is an ordinary exported async function, so these tests call it and parse the
 * `Response` body with a real XML parser. Nothing starts a server.
 *
 * `@/lib/api` is mocked at the module boundary, matching app/sitemap.test.ts: what this
 * file must prove is about the DOCUMENT — that it parses, that it lists exactly the
 * published posts, that its URLs are the same strings the canonical tag uses, and that a
 * hostile title cannot break it. `lib/api.test.ts` owns the envelope behaviour, and
 * lib/published-posts.ts's paging is exercised here only where the feed depends on it.
 *
 * The parser is `DOMParser` from jsdom, which is already the test environment — no new
 * dependency. It is a REAL XML parser in `application/xml` mode: it reports a
 * `<parsererror>` element for an unescaped `&` or `<`, which is what makes the escaping
 * test below mean something rather than being a string comparison dressed up.
 *
 * `getPost` is also blocked (content:encoded needs each post detail), so the error class is real; lib/markdown.tsx
 * is not, so the HTML in the feed goes through exactly the renderer and sanitize schema of the page.
 */
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  getPosts: vi.fn(),
  getPost: vi.fn(),
}))

// The owner filled in an email: the feed must not carry it (the packaged default has none).
const OWNER_EMAIL = 'owner@example.test'
vi.mock('@/lib/site-content', async () => {
  const { defaultSiteContent } = await import('@/content/defaults')
  return {
    getSiteContent: async (locale: 'vi' | 'en') => {
      const content = defaultSiteContent(locale)
      return { ...content, contact: { ...content.contact, email: OWNER_EMAIL } }
    },
  }
})

const { profile, site } = defaultSiteContent(DEFAULT_LOCALE)

const ORIGIN = 'https://blog.example.com'
const CONTENT_NS = 'http://purl.org/rss/1.0/modules/content/'

function post(n: number, over: Partial<PostSummary> = {}): PostSummary {
  return {
    id: `p${n}`,
    title: `Post ${n}`,
    slug: `bai-viet-${n}`,
    excerpt: `Summary of post ${n}.`,
    status: 'PUBLISHED',
    category: null,
    tags: [],
    publishedAt: `2026-01-${String(n).padStart(2, '0')}T00:00:00Z`,
    featured: false,
    readingMinutes: 1,
    ...over,
  }
}

/** Serves `pages` as the backend would — the same stub shape app/sitemap.test.ts uses. */
function stubPosts(pages: PostSummary[][], meta: { totalPages?: number } = {}) {
  vi.mocked(getPosts).mockImplementation(async ({ page, size }) => ({
    items: pages[page] ?? [],
    meta: {
      page,
      size,
      totalElements: pages.flat().length,
      totalPages: meta.totalPages ?? pages.length,
    },
  }))
  // The detail of each post in the list, like GET /api/v1/posts/{slug}; a post outside the list is 404.
  vi.mocked(getPost).mockImplementation(async (slug) => {
    const found = pages.flat().find((candidate) => candidate.slug === slug)
    if (!found) throw new NotFoundError('POST_NOT_FOUND', 'Post not found')
    return { ...found, content: `Content of ${slug}.`, createdAt: '2026-01-01T00:00:00Z', updatedAt: found.updatedAt ?? '' }
  })
}

/** The route context Next hands a handler of `app/[locale]/feed.xml`. */
function context(locale = 'vi') {
  return { params: Promise.resolve({ locale }) }
}

async function feed(locale = 'vi'): Promise<{ res: Response; xml: string; doc: Document }> {
  const res = await GET(new Request(`${ORIGIN}/feed.xml`), context(locale))
  const xml = await res.text()
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  return { res, xml, doc }
}

function items(doc: Document): Element[] {
  return [...doc.getElementsByTagName('item')]
}

function text(parent: Element | Document, tag: string): string | null {
  return parent.getElementsByTagName(tag)[0]?.textContent ?? null
}

/** The `<dc:creator>` of each item, by namespace: without the `xmlns:dc` declaration it does not match. */
function creators(doc: Document): (string | null)[][] {
  return items(doc).map((item) =>
    [...item.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'creator')].map((c) => c.textContent),
  )
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', ORIGIN)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('/feed.xml: one feed per language', () => {
  it('asks the API for the posts of the locale only, and links each item to the language URL of the post', async () => {
    stubPosts([[post(1, { language: 'en' }), post(2, { language: 'en' })]])
    const { doc } = await feed('en')

    expect(vi.mocked(getPosts).mock.calls[0]![0]).toMatchObject({ language: 'en' })
    expect(text(doc, 'language')).toBe('en')
    expect(items(doc).map((item) => text(item, 'link'))).toEqual([postUrl('bai-viet-1', 'en'), postUrl('bai-viet-2', 'en')])
    expect(postUrl('bai-viet-1', 'en')).toBe(`${ORIGIN}/en/posts/bai-viet-1`)
  })

  it('the default locale feed asks for the default language and keeps the unprefixed URLs', async () => {
    stubPosts([[post(1, { language: 'vi' })]])
    const { doc } = await feed('vi')

    expect(vi.mocked(getPosts).mock.calls[0]![0]).toMatchObject({ language: 'vi' })
    expect(text(doc, 'language')).toBe('vi')
    expect(text(items(doc)[0]!, 'link')).toBe(`${ORIGIN}/posts/bai-viet-1`)
  })
})

describe('/feed.xml: allowance per address', () => {
  it('answers 429 with Retry-After to the 121st poll of one address in a minute, without asking the backend', async () => {
    stubPosts([[post(1)]])
    const poll = (ip: string) => GET(new Request(`${ORIGIN}/feed.xml`, { headers: { 'x-forwarded-for': ip } }), context('vi'))
    for (let i = 0; i < READ_LIMITS.feed.limit; i++) expect((await poll('203.0.113.60')).status).toBe(200)
    vi.mocked(getPosts).mockClear()

    const refused = await poll('203.0.113.60')

    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    expect(getPosts).not.toHaveBeenCalled()
    expect((await poll('203.0.113.61')).status).toBe(200)
  }, 60_000)
})

describe('/feed.xml', () => {
  it('answers 200 with the RSS content type', async () => {
    stubPosts([[post(1)]])
    const { res } = await feed()

    expect(res.status).toBe(200)
    // The type is what makes a browser offer to subscribe and what a reader checks before
    // parsing. `text/xml` would parse and would still be wrong.
    expect(res.headers.get('content-type')).toBe('application/rss+xml; charset=utf-8')
  })

  it('tells a shared cache to revalidate on every request, on the feed and on the answers that are not one', async () => {
    stubPosts([[post(1)]])
    expect((await feed()).res.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
    expect((await feed('fr')).res.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
  })

  it('produces a document a real XML parser accepts', async () => {
    stubPosts([[post(1), post(2)]])
    const { doc } = await feed()

    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0)
    expect(doc.documentElement.tagName).toBe('rss')
    expect(doc.documentElement.getAttribute('version')).toBe('2.0')
  })

  it('lists the published posts and nothing else', async () => {
    stubPosts([[post(1), post(2, { status: 'DRAFT' }), post(3)]])
    const { doc, xml } = await feed()

    expect(items(doc)).toHaveLength(2)
    // Not just "two items": the draft's slug must appear nowhere at all. A feed that
    // pushes an unpublished article has already delivered it to every subscriber, and
    // unpublishing it afterwards does not take it back.
    expect(xml).not.toContain('bai-viet-2')
  })

  it('spells each URL exactly as the canonical tag and the copy-link button do', async () => {
    stubPosts([[post(1)]])
    const { doc } = await feed()

    const item = items(doc)[0]!
    // `postUrl` is the shared definition — components/site/ArticleJsonLd.tsx. Comparing
    // against it rather than against a literal is what stops the feed drifting into a
    // second spelling of every article's URL.
    expect(text(item, 'link')).toBe(postUrl('bai-viet-1'))
    expect(text(item, 'guid')).toBe(postUrl('bai-viet-1'))
    expect(item.getElementsByTagName('guid')[0]?.getAttribute('isPermaLink')).toBe('true')
  })

  it('builds the same absolute URLs however NEXT_PUBLIC_SITE_URL is written', async () => {
    // The same awkward values app/sitemap.test.ts and app/robots.test.ts check, for the
    // same reason: an empty `NEXT_PUBLIC_SITE_URL=` line in a .env file is a normal way to
    // write one you have not filled in, and a trailing slash is as likely as not.
    for (const configured of [ORIGIN, `${ORIGIN}/`, '', undefined]) {
      if (configured === undefined) vi.stubEnv('NEXT_PUBLIC_SITE_URL', '')
      else vi.stubEnv('NEXT_PUBLIC_SITE_URL', configured)

      stubPosts([[post(1)]])
      const { doc } = await feed()

      expect(text(items(doc)[0]!, 'link')).toBe(postUrl('bai-viet-1'))
      expect(text(doc, 'link')).not.toMatch(/\/$/)
    }
  })

  it('escapes the characters that would otherwise break the document', async () => {
    // Naive interpolation passes every other test in this file and fails this one. The
    // assertion is not "the string contains &amp;" — it is that a real parser still reads
    // the document AND round-trips the exact original text.
    const hostile = 'Sign & less than < greater than > "quotes" \'apostrophes\''
    stubPosts([[post(1, { title: hostile, excerpt: 'A & B <c> ]]> d' })]])

    const { doc } = await feed()

    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0)
    expect(text(items(doc)[0]!, 'title')).toBe(hostile)
    // `]]>` specifically: it is the sequence that would terminate a CDATA section early,
    // and this pins that CDATA is not reintroduced here later as a "simplification".
    expect(text(items(doc)[0]!, 'description')).toBe('A & B <c> ]]> d')
  })

  it('carries the whole post in content:encoded, sanitized, with absolute links; the summary stays in description', async () => {
    stubPosts([[post(1)]])
    vi.mocked(getPost).mockResolvedValue({
      ...post(1),
      content: [
        'Read [the previous part](/posts/bai-viet-0) <a href="/x" onclick="alert(1)">x</a> <script>alert(2)</script>',
        '[click](javascript:alert(3)) ![diagram](/media/0b5c3f1e-2d4a-4b6c-8d9e-0f1a2b3c4d5e.png#640x480) ]]>',
      ].join('\n\n'),
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })

    const { doc } = await feed()

    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0)
    const item = items(doc)[0]!
    expect(text(item, 'description')).toBe('Summary of post 1.')
    const html = item.getElementsByTagNameNS(CONTENT_NS, 'encoded')[0]?.textContent ?? ''
    expect(html).toContain(`href="${ORIGIN}/posts/bai-viet-0"`)
    expect(html).toContain(`src="${ORIGIN}/media/0b5c3f1e-2d4a-4b6c-8d9e-0f1a2b3c4d5e.png"`)
    expect(html).toContain(']]>')
    expect(html).not.toMatch(/<script|onclick|javascript:|alert\(|#640x480/i)
  })

  it('writes dates in the format RSS requires, and omits the ones it does not have', async () => {
    stubPosts([
      [post(1, { publishedAt: '2026-01-05T12:30:00Z' }), post(2, { publishedAt: null }), post(3, { publishedAt: 'not-a-date' })],
    ])

    const { doc, xml } = await feed()
    const [first, second, third] = items(doc)

    // RFC-822, not ISO-8601. A reader that cannot parse the date treats the item as undated
    // and sorts it to the bottom forever.
    expect(text(first!, 'pubDate')).toBe('Mon, 05 Jan 2026 12:30:00 GMT')
    expect(text(first!, 'pubDate')).toMatch(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/)

    // Absent, not empty, and above all not the string `new Date('not-a-date').toUTCString()`
    // returns — which is the literal "Invalid Date", with nothing thrown to say so.
    expect(second!.getElementsByTagName('pubDate')).toHaveLength(0)
    expect(third!.getElementsByTagName('pubDate')).toHaveLength(0)
    expect(xml).not.toContain('Invalid Date')
  })

  it('dates the channel from the newest post rather than from the clock', async () => {
    stubPosts([[post(1, { publishedAt: '2026-01-01T00:00:00Z' }), post(2, { publishedAt: '2026-03-03T00:00:00Z' })]])
    const { doc } = await feed()

    // The newest, not the first seen — and a real date, so a reader can tell a poll that
    // found nothing from one that did. `new Date()` here would claim a change every poll.
    expect(text(doc, 'lastBuildDate')).toBe('Tue, 03 Mar 2026 00:00:00 GMT')
  })

  it('omits lastBuildDate entirely on a blog with no dated posts', async () => {
    stubPosts([[post(1, { publishedAt: null })]])
    const { doc } = await feed()

    expect(doc.getElementsByTagName('lastBuildDate')).toHaveLength(0)
  })

  it('does not put an email address in the feed, even when the site owner filled one in', async () => {
    stubPosts([[post(1)]])
    const { doc, xml } = await feed()

    // The item `<managingEditor>`, `<webMaster>` and `<author>` are all defined by RSS as an
    // email address. The site owner filled in `contact.email`, but that field drives the visible contact links
    // on the page; copying it into the feed is a different decision (see
    // app/feed.xml/route.ts). The "has" assertion goes along: that address does exist, and the author name
    // is still present in the channel title — the feed just does not carry the address.
    for (const tag of ['managingEditor', 'webMaster', 'author']) {
      expect(doc.getElementsByTagName(tag), `${tag} must not be emitted`).toHaveLength(0)
    }
    expect(xml).not.toContain(OWNER_EMAIL)
    expect(text(doc.getElementsByTagName('channel')[0]!, 'title')).toBe(site.name)
    // Pinned on purpose: the author name now also appears in each post `<dc:creator>` — a name, not an address.
    expect(creators(doc)).toEqual([[profile.name]])
  })

  it('one <dc:creator> per post: the site owner is profile.name, another author is their own name, escaped', async () => {
    const hostile = 'Smith & <Jones> "B"'
    stubPosts([
      [
        post(1),
        post(2, { author: { displayName: 'admin', githubLogin: 'admin', avatarUrl: null, siteOwner: true } }),
        post(3, { author: { displayName: hostile, githubLogin: 'tranthibich', avatarUrl: null, siteOwner: false } }),
      ],
    ])

    const { doc } = await feed()

    // A real parser: an unescaped `&` or `<` is a parsererror, and the name must come back verbatim.
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0)
    expect(creators(doc)).toEqual([[profile.name], [profile.name], [hostile]])
  })

  it('states its own address so a reader can re-find it', async () => {
    stubPosts([[post(1)]])
    const { doc } = await feed()

    const self = doc.getElementsByTagNameNS('http://www.w3.org/2005/Atom', 'link')[0]
    expect(self?.getAttribute('href')).toBe(`${ORIGIN}/feed.xml`)
    expect(self?.getAttribute('rel')).toBe('self')
  })

  it('the English feed says en, links the /en home and states the /en address, items keep the canonical post URLs', async () => {
    stubPosts([[post(1)]])
    const { doc } = await feed('en')

    expect(text(doc, 'language')).toBe('en')
    expect(text(doc, 'link')).toBe(`${ORIGIN}/en`)
    const self = doc.getElementsByTagNameNS('http://www.w3.org/2005/Atom', 'link')[0]
    expect(self?.getAttribute('href')).toBe(`${ORIGIN}/en/feed.xml`)
    expect(text(items(doc)[0]!, 'link')).toBe(postUrl('bai-viet-1'))
  })

  it('answers 404 for a locale the site does not have', async () => {
    stubPosts([[post(1)]])
    expect((await feed('fr')).res.status).toBe(404)
  })

  it('shares the post selection with the sitemap instead of repeating it', async () => {
    // Two overlapping pages, the shape app/sitemap.test.ts uses: a post published between
    // two requests shifts the ordering under the cursor, so the same article legitimately
    // comes back twice.
    stubPosts([
      [post(1), post(2)],
      [post(2), post(3)],
    ])
    const { doc } = await feed()

    expect(items(doc)).toHaveLength(3)
    // 100 per page, because that is the most the backend will give. A feed asking for the
    // default 20 would silently stop at post 21, with no error anywhere.
    for (const call of vi.mocked(getPosts).mock.calls) {
      expect(call[0]?.size).toBe(100)
    }
  })

  it('answers 503 rather than an empty feed when the posts cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(getPosts).mockRejectedValue(new TypeError('fetch failed'))

    const res = await GET(new Request(`${ORIGIN}/feed.xml`), context())

    // A 200 with zero items reads to a feed reader as "every article was deleted", and some
    // will drop what they have already stored. 503 means "ask again", which is true.
    expect(res.status).toBe(503)
    // Never stored: a cached 503 would outlive the incident.
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.text()).not.toContain('<rss')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('names each post by its category and tags, without repeating a term', async () => {
    stubPosts([
      [
        post(1, {
          category: { id: 'c1', name: 'Architecture', slug: 'kien-truc', description: null },
          tags: [
            // Deliberately the same name as the category: a real blog can have exactly this
            // (a post in "Architecture" tagged "Architecture"), and the same term twice is noise.
            { id: 't1', name: 'Architecture', slug: 'kien-truc' },
            { id: 't2', name: 'AWS', slug: 'aws' },
          ],
        }),
      ],
    ])

    const { doc } = await feed()
    const names = [...items(doc)[0]!.getElementsByTagName('category')].map((c) => c.textContent)

    expect(names).toEqual(['Architecture', 'AWS'])
  })
})

/**
 * V6 P3-7: the 20 newest posts, not every post ever published.
 *
 * The API answers newest first (`sort=latest` is `publishedAt DESC`, PostService.listPublished), so
 * the stubs below are written in that order — the order the feed actually receives.
 */
describe('/feed.xml: the newest twenty', () => {
  /** n posts as the API returns them: post n (the newest) first, post 1 last. */
  function newestFirst(n: number, over: (number: number) => Partial<PostSummary> = () => ({})): PostSummary[] {
    return Array.from({ length: n }, (_, index) => post(n - index, over(n - index)))
  }

  it('carries the 20 newest posts, newest first, and dates the channel from them', async () => {
    stubPosts([newestFirst(25)])
    const { doc } = await feed()

    // Posts 25 down to 6: the five oldest stay on the site and in the sitemap, not in the feed.
    expect(items(doc).map((item) => text(item, 'link'))).toEqual(
      Array.from({ length: 20 }, (_, index) => postUrl(`bai-viet-${25 - index}`)),
    )
    const dates = items(doc).map((item) => Date.parse(text(item, 'pubDate')!))
    expect(dates).toEqual([...dates].sort((a, b) => b - a))
    expect(text(doc, 'lastBuildDate')).toBe('Sun, 25 Jan 2026 00:00:00 GMT')
  })

  it('counts only what it may publish: a draft among the newest does not take a slot', async () => {
    // The cap applies AFTER the published filter of lib/published-posts.ts. Capping the request
    // instead (`size: 20`) would let a leaked draft cost a real article its place.
    stubPosts([newestFirst(25, (number) => (number === 25 ? { status: 'DRAFT' } : {}))])
    const { doc } = await feed()

    const links = items(doc).map((item) => text(item, 'link'))
    expect(links).toHaveLength(20)
    expect(links[0]).toBe(postUrl('bai-viet-24'))
    expect(links[19]).toBe(postUrl('bai-viet-5'))
    expect(links).not.toContain(postUrl('bai-viet-25'))
  })
})

/**
 * V6 P3-8: the posts behind the feed are read on every poll.
 *
 * getPosts asks for `revalidate: 300` under the `posts` tag, which only the admin's Server Actions
 * clear, so an article published by seed/push.py or straight through the API reached subscribers up
 * to five minutes late — later in practice, since a reader polls rarely and a rare poll of a stale
 * entry is answered with the stale copy while Next refreshes it in the background.
 *
 * Run through Next's own fetch (test/next-data-cache.ts) with the real lib/api.ts, over a data cache
 * that still holds the list from before the write.
 */
describe('/feed.xml: the backend, read on every poll (V6 P3-8)', () => {
  afterEach(() => {
    vi.doMock('@/lib/api', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@/lib/api')>()),
      getPosts: vi.fn(),
      getPost: vi.fn(),
    }))
    vi.resetModules()
  })

  /** app/feed.xml/route.ts over the real lib/api.ts, not the stub the rest of this file uses. */
  async function realRouteModule() {
    vi.doUnmock('@/lib/api')
    vi.resetModules()
    return import('./route')
  }

  /** The list, and (V7b D13) each listed post's detail, which content:encoded is rendered from. */
  function backendWith(posts: PostSummary[]): Answers {
    return (path) => {
      const found = posts.find((candidate) => path === `/api/v1/posts/${candidate.slug}`)
      if (found) return { data: { ...found, content: `Content of ${found.slug}.`, updatedAt: found.publishedAt } }
      return { data: posts, pagination: { page: 0, size: 100, totalElements: posts.length, totalPages: 1 } }
    }
  }

  // Post 2 was published outside the admin after the data cache was filled.
  const live = backendWith([post(2), post(1)])
  const cached = backendWith([post(1)])

  async function itemLinks(res: Response): Promise<(string | null)[]> {
    const doc = new DOMParser().parseFromString(await res.text(), 'application/xml')
    // Every item has its full content: the detail has been read, from the backend or the cache depending on the test.
    for (const item of items(doc)) {
      expect(item.getElementsByTagNameNS(CONTENT_NS, 'encoded')[0]?.textContent).toMatch(/^<p>Content of bai-viet-\d\.<\/p>$/)
    }
    return items(doc).map((item) => text(item, 'link'))
  }

  it('declares fetchCache = force-no-store', async () => {
    const mod = await realRouteModule()

    expect(mod.fetchCache).toBe('force-no-store')
  })

  it('carries a post published outside the admin on the very next poll, without touching the data cache', async () => {
    const mod = await realRouteModule()

    const run = await runThroughDataCache({ fetchCache: mod.fetchCache }, { live, cached }, () =>
      mod.GET(new Request(`${ORIGIN}/feed.xml`), context()),
    )

    expect(await itemLinks(run.result)).toEqual([postUrl('bai-viet-2'), postUrl('bai-viet-1')])
    expect(run.cacheReads).toEqual([])
    expect(run.cacheWrites).toEqual([])
    // The list, then the detail of each item for content:encoded, also straight from the backend. The order
    // among the details is not fixed: they run in parallel.
    expect(run.backend[0]).toBe('/api/v1/posts?page=0&size=100&lang=vi')
    expect(run.backend.slice(1).sort()).toEqual(['/api/v1/posts/bai-viet-1', '/api/v1/posts/bai-viet-2'])
  })

  it('without it, the poll would be answered from the data cache', async () => {
    // The feed as it was before V6 P3-8, and the control for the test above: the same harness and
    // the same getPosts DO serve the old list when nothing overrides its `revalidate: 300`.
    const mod = await realRouteModule()

    const run = await runThroughDataCache({}, { live, cached }, () => mod.GET(new Request(`${ORIGIN}/feed.xml`), context()))

    expect(await itemLinks(run.result)).toEqual([postUrl('bai-viet-1')])
    expect(run.backend).toEqual([])
    expect(run.cacheReads).toEqual(['/api/v1/posts?page=0&size=100&lang=vi', '/api/v1/posts/bai-viet-1'])
  })
})
