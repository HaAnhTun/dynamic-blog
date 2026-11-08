import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen, within } from '@testing-library/react'
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaRef, Page, Post, PostSummary, SeriesDetail } from '@/lib/types'
import type { Session } from '@/lib/session-client'
import { postPath } from '@/components/site/ArticleJsonLd'
import { MIN_TOC_ENTRIES } from '@/components/site/ArticleView'
import { githubStartHref } from '@/components/site/GitHubLoginLink'
import { ApiError, NotFoundError, getPost, getPostRedirect, getPosts } from '@/lib/api'
import { getDiscovery, type Discovery } from '@/lib/discovery'
import { getSeries } from '@/lib/series'
import { getSiteContent } from '@/lib/site-content'
import type { Locale } from '@/i18n/config'
import PostPage, { generateMetadata, generateStaticParams, revalidate } from './page'
import { defaultSiteContent } from '@/content/defaults'
import { TEST_LOCALE } from '@/test/intl'
import { routing } from '@/i18n/routing'
import { IntlWrapper } from '@/test/intl'
import { NFC_SLUG, OLD_SLUG, PUBLISHED_DATE_TEXT, UPDATED_DATE_TEXT } from '@/test/fixtures/vi/post-page'
import { msg } from '@/test/render-intl'
import { ARTICLE_SLOT, BODY_SLOT, END_SLOT, HERO_SLOT, READER_GRID } from '@/components/site/reader/reader-layout'

const { site, profile } = defaultSiteContent(TEST_LOCALE)
const PROFILE_NAME = profile.name

/** The accessible names of the two rails (`Site.reader`), and what the page names its table of contents. */
const LEFT_LABEL = msg('Site.reader.leftLabel')
const RAIL_LABEL = msg('Site.reader.railLabel')
const TOC_NAME = msg('Site.article.toc')

/**
 * jsdom applies no Tailwind, so the table of contents is in the render TWICE: the inline `<details>` inside the article
 * (below `rail:`) and the plain list of the reading rail (from `rail:`). Both carry the name `Site.article.toc`, so a
 * single-element `getByRole('navigation', { name })` throws "multiple elements". Each assertion asks for the variant it means.
 */
const tocNavs = () => screen.getAllByRole('navigation', { name: TOC_NAME })
const inlineToc = () => tocNavs().find((nav) => nav.closest('[data-reader-body]'))!
const railToc = () => tocNavs().find((nav) => nav.closest(`aside[aria-label="${RAIL_LABEL}"]`))!
/** The reading rail (right) and the left rail, as named landmarks. */
const railAside = () => screen.getByRole('complementary', { name: RAIL_LABEL })
/** The rail's share link of a destination: the phone's Share menu in the same toolbar has links of the same names, so ask for the named list. */
const railShareLink = (target: string) =>
  within(within(railAside()).getByRole('list', { name: msg('Site.share.label') })).getByRole('link', {
    name: msg('Site.share.shareOn', { target }),
  })
const leftAside = () => screen.getByRole('complementary', { name: LEFT_LABEL })
/** The left rail has two CSS-switched copies (jsdom shows both): the sticky desktop block and the closed mobile `<details>`. */
const leftDesktop = () => leftAside().querySelector<HTMLElement>('[data-rail-sticky]')!
const leftMobile = () => leftAside().querySelector<HTMLElement>('details[data-rail-phone]')!

/**
 * `PostPage`, `generateMetadata` and `generateStaticParams` are async Server
 * Component exports, so RTL cannot render them — but they are ordinary exported
 * async functions, so they are called directly here and the tree they return is
 * rendered. Same approach as `app/page.test.tsx`, and for the same reason: pulling
 * the slug handling out into a helper would test the helper and leave the page
 * untested, which is where the whole of this task lives.
 *
 * Only the API is mocked, and only its request functions — `importOriginal`
 * keeps `NotFoundError` and `ApiError` the real classes, so the `instanceof` check
 * in the page is tested against the same constructor `lib/api.ts` actually throws.
 * A hand-rolled stand-in class would make the `instanceof` branch pass here while
 * the page 500s in production. `getPostRedirect` is in the list for the
 * reason README gives about this spread: an export left real here makes a real
 * network call from the test.
 *
 * `renderMarkdown` is deliberately NOT mocked. The table-of-contents assertions
 * below compare each link's fragment against the ids in the rendered body, and that
 * comparison is only worth anything if both sides come out of the real pipeline.
 *
 * `notFound()` is the real one from next/navigation: it throws an Error whose
 * `digest` is 'NEXT_HTTP_ERROR_FALLBACK;404'. Asserting a mock was called cannot
 * tell a real 404 from a page that carried on rendering.
 */
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  getPost: vi.fn(),
  getPostRedirect: vi.fn(),
  getPosts: vi.fn(),
}))

/**
 * Two new secondary sources of the page: the post series and the "What to read next" block. Both are mocked,
 * because the real ones hit the network: lib/discovery gathers from fetchAllPublishedPosts and /posts?sort=popular.
 * `importOriginal` lets lib/discovery keep `shouldShowViews` and the real constants: the view threshold
 * on the page must be that module's threshold, not a copy inside the test.
 */
vi.mock('@/lib/series', () => ({ getSeries: vi.fn(), getSeriesList: vi.fn() }))
/**
 * The site content, as test/intl-setup.tsx gives it (the packaged defaults, no network), but as a spy so the hero cases can give
 * the owner a profile picture; `mockReset` in `afterEach` puts the default implementation back.
 */
vi.mock('@/lib/site-content', async () => {
  const { defaultSiteContent } = await import('@/content/defaults')
  const { DEFAULT_LOCALE } = await import('@/i18n/config')
  return {
    SITE_CONTENT_TAG: 'site-content',
    getSiteContent: vi.fn(async (locale: Locale) => defaultSiteContent(locale)),
    getDefaultSiteContent: async () => defaultSiteContent(DEFAULT_LOCALE),
  }
})
vi.mock('@/lib/discovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/discovery')>()),
  getDiscovery: vi.fn(),
}))

/**
 * The like button and the comment area are client-side islands, reading the session from the browser-side
 * store. Here the store stays at "asking", exactly as in the server render, where this page is prerendered for
 * everyone: no real fetch, and the two islands sit in their inert placeholders. The behavior after the session
 * answers has its own tests (LikeButton.test.tsx, comments/CommentSection.test.tsx, with the real store).
 */
const session = vi.hoisted(() => ({ value: { status: 'loading' } as Session }))
vi.mock('@/lib/session-client', () => ({
  useSession: () => session.value,
  setAnonymous: vi.fn(),
  logout: vi.fn(),
}))

/** The "What to read next" block has nothing: DiscoveryGrid returns null, the older tests do not see it. */
const NO_DISCOVERY: Discovery = {
  popular: null,
  recent: null,
  series: null,
  seriesTotal: 0,
  tags: null,
  tagTotal: 0,
  months: null,
  blogroll: [],
}

/**
 * `readingMinutes` is on the wire and is NOT on `Post`.
 *
 * Verified against the running backend rather than assumed:
 *   curl -s "localhost:8080/api/v1/posts?size=1" → "readingMinutes":12
 * and PostResponse/PostSummaryResponse both declare the field. `lib/types.ts` does
 * not, and that file belongs to another agent this run, so the fixture widens `Post`
 * here instead of the type being fixed. `ArticlePost` is assignable to `Post`, so
 * `mockResolvedValue` still typechecks against the real signature.
 */
type ArticlePost = Post & { readingMinutes: number }

const post: ArticlePost = {
  id: '1',
  title: 'Performance problem statement',
  slug: 'dat-van-de',
  excerpt: 'A short write-up.',
  category: { id: 'c1', name: 'Technology', slug: 'cong-nghe', description: null },
  // Tags carry their slug now, which is what lets a chip link to ?tag=<slug>. The name
  // and the slug are deliberately different here: a fixture where they match cannot tell
  // a component that links by slug from one that links by name, and linking by name is
  // the defect this shape was introduced to fix.
  tags: [{ id: 't1', name: 'Spring Boot', slug: 'spring-boot' }],
  // 17:30Z is already the 29th in Asia/Ho_Chi_Minh, which vitest.config.mts pins as
  // the test timezone. That is what makes the `timeZone: 'UTC'` assertion below real
  // rather than vacuous — on a UTC host the option could be deleted with nothing
  // noticing.
  publishedAt: '2026-09-28T17:30:00Z',
  // Three headings: the table of contents only shows from MIN_TOC_ENTRIES (3) entries. Pinned again on purpose: the old fixture
  // had two, and the table of contents tests below count by these three entries.
  content: '## Problem statement\n\nOne paragraph.\n\n### Details\n\nTwo paragraphs.\n\n## Conclusion\n\nThree paragraphs.',
  status: 'PUBLISHED',
  featured: false,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-02T00:00:00Z',
  readingMinutes: 12,
}

/** An uploaded cover image. The dimensions are not the numbers in the mockup. */
const COVER: MediaRef = {
  id: '6f1c2a7e-3b4d-4c5e-8f90-1a2b3c4d5e6f',
  fileName: '6f1c2a7e-3b4d-4c5e-8f90-1a2b3c4d5e6f.jpg',
  width: 1600,
  height: 1067,
  altText: 'A whiteboard with a diagram of three queues',
  dominantColor: '#5a6b7c',
}

const summary = (slug: string, extra: Partial<PostSummary> = {}): PostSummary => ({
  id: slug,
  title: slug,
  slug,
  excerpt: null,
  status: 'PUBLISHED',
  category: null,
  tags: [],
  publishedAt: null,
  featured: false,
  readingMinutes: 1,
  ...extra,
})

const listing = (items: PostSummary[]): Page<PostSummary> => ({
  items,
  meta: { page: 0, size: items.length, totalElements: items.length, totalPages: 1 },
})

/**
 * Every published post, newest first as the API returns them: ONE list for both the related posts and the previous/next posts.
 *
 * PINNED AGAIN ON PURPOSE. Previously the page made two different requests: related posts asked
 * `getPosts({ category })`, previous/next asked one page of 50 posts, and the fixture split the two answers
 * by whether `category` was present. Now both read `fetchAllPublishedPosts()` (the real one, paging
 * through `getPosts({ page, size: 100 })`): the same request that "What to read next" already makes, which Next merges into one. So
 * there is only one fixture, and which post is "related" is decided by its score (same category, shared tags)
 * and not by the fixture placing it in a separate list. `summary()` has no category and no tags: it
 * only enters the related block when a test gives it something in common.
 */
function stubPublished(posts: PostSummary[]) {
  vi.mocked(getPosts).mockImplementation(async ({ page }) => (page === 0 ? listing(posts) : listing([])))
}

/** Same category as `post`: enough for a post to enter the related block (score 2). */
const IN_CATEGORY: Partial<PostSummary> = { category: post.category }

/** Publish date number `n` of September (a larger number is a newer post): the order inside the related block. */
const day = (n: number) => `2026-09-${String(n).padStart(2, '0')}T08:00:00Z`

/**
 * The page tree with every async Server Component awaited in place. `LeftRail` is an async component (it reads server
 * translators), which React Testing Library cannot render; calling it here, with the props the page gave it, keeps the test
 * on the real component instead of a stand-in. Sync components and host elements are left alone.
 */
async function resolveAsync(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map((child) => resolveAsync(child)))
  if (!isValidElement(node)) return node
  const element = node as ReactElement<{ children?: ReactNode }>
  if (typeof element.type === 'function' && element.type.constructor.name === 'AsyncFunction') {
    const component = element.type as unknown as (props: unknown) => Promise<ReactNode>
    return resolveAsync(await component(element.props))
  }
  if (element.props.children === undefined) return element
  const children = await resolveAsync(element.props.children)
  return cloneElement(element, undefined, ...(Array.isArray(children) ? children : [children]))
}

/** `PostPage` with its async children resolved, ready for `render` or `renderToString`. */
async function renderPage(pageProps: PageProps<'/[locale]/posts/[slug]'>): Promise<ReactNode> {
  return resolveAsync(await PostPage(pageProps))
}

function props(slug: string): PageProps<'/[locale]/posts/[slug]'> {
  return { params: Promise.resolve({ locale: 'vi', slug }), searchParams: Promise.resolve({}) }
}

// a slug with Vietnamese diacritics composed, then the same text decomposed: 8 codepoints against 11. The
// two render identically and are not equal, and only one of them is the slug the
// backend stored.
const NFD_SLUG = NFC_SLUG.normalize('NFD')

/** The "updated" line without its <time> tag, and its fixed text up to the date. */
const updatedText = (date: string): string => msg('Site.article.updated', { date, time: (chunks: string) => chunks } as never)
const UPDATED_PREFIX = updatedText('').trim()

/** The views unit ("views"), without the number. */
const VIEWS_UNIT = new RegExp(msg('Site.article.views', { count: '', n: 2 }).trim())

const sendBeacon = vi.fn<(url: string, data?: BodyInit | null) => boolean>()

beforeEach(() => {
  // Every PostPage render reads the published list (related posts, previous/next). Both
  // helpers swallow their own failure and return nothing, so a test that left `getPosts`
  // un-stubbed would still pass — and would be passing because the page caught a
  // TypeError from destructuring `undefined`, not because the page is right. An explicit
  // empty list makes "no related posts" mean "the API returned none", which is what the
  // assertions below claim.
  stubPublished([])
  // Same reason for the "What to read next" block: empty means "the API has nothing", not "the page swallowed an error".
  vi.mocked(getDiscovery).mockResolvedValue(NO_DISCOVERY)
  // ViewBeacon runs on every render: a fake sendBeacon so no request leaves the process,
  // and a clean sessionStorage so each test starts like a new session.
  sessionStorage.clear()
  sendBeacon.mockReset().mockReturnValue(true)
  Object.defineProperty(navigator, 'sendBeacon', { value: sendBeacon, configurable: true, writable: true })
})

afterEach(() => {
  vi.mocked(getPost).mockReset()
  vi.mocked(getPostRedirect).mockReset()
  vi.mocked(getPosts).mockReset()
  vi.mocked(getSeries).mockReset()
  vi.mocked(getDiscovery).mockReset()
  vi.mocked(getSiteContent).mockReset()
  delete (navigator as { sendBeacon?: unknown }).sendBeacon
  session.value = { status: 'loading' }
  vi.unstubAllGlobals()
})

describe('PostPage', () => {
  it('asks the API for the slug in the URL and renders the post', async () => {
    vi.mocked(getPost).mockResolvedValue(post)

    const { container } = render(await renderPage(props('dat-van-de')))

    expect(getPost).toHaveBeenCalledTimes(1)
    expect(getPost).toHaveBeenCalledWith('dat-van-de')
    expect(screen.getByRole('heading', { level: 1, name: 'Performance problem statement' })).toBeInTheDocument()
    expect(screen.getByText('Technology')).toBeInTheDocument()
    // Through the real Markdown pipeline: proves `post.content` is what gets
    // rendered, not the excerpt or the title.
    expect(screen.getByText('One paragraph.')).toBeInTheDocument()
    // Post bodies arrive as Markdown, so Tailwind can never scan them for class
    // names — `prose` is the only thing styling them, and nothing else in the suite
    // would notice it going missing.
    expect(container.querySelector('div.prose')).not.toBeNull()
  })

  it('percent-decodes the slug exactly once', async () => {
    vi.mocked(getPost).mockResolvedValue(post)

    // Next does not decode `params` (it does decode `searchParams`), so a Vietnamese
    // slug arrives percent-encoded and has to be decoded here.
    render(await renderPage(props(encodeURIComponent(NFC_SLUG))))
    expect(getPost).toHaveBeenCalledWith(NFC_SLUG)

    // And exactly once. `normalizeSlug` is not idempotent: on double-encoded input a
    // second pass peels a second layer, so a page that normalized before handing off
    // *and* an api.ts that normalized again would ask for the composed slug here. The
    // request has to be for the once-decoded form, which is what the URL named.
    vi.mocked(getPost).mockClear()
    render(await renderPage(props(encodeURIComponent(encodeURIComponent(NFC_SLUG)))))
    expect(getPost).toHaveBeenCalledWith(encodeURIComponent(NFC_SLUG))
  })

  it('normalizes a decomposed slug to NFC before asking the API', async () => {
    vi.mocked(getPost).mockResolvedValue(post)

    render(await renderPage(props(NFD_SLUG)))

    expect(getPost).toHaveBeenCalledWith(NFC_SLUG)
    // Not merely "was called with the NFC form": without `.normalize('NFC')` the
    // call is made with a string that looks identical in every failure message.
    expect(getPost).not.toHaveBeenCalledWith(NFD_SLUG)
  })

  it('renders the published date in UTC so it does not shift with the server', async () => {
    vi.mocked(getPost).mockResolvedValue(post)

    const { container } = render(await renderPage(props('dat-van-de')))
    const time = container.querySelector('time')

    expect(time).toHaveAttribute('dateTime', '2026-09-28T17:30:00Z')
    // 2026-09-28T17:30:00Z is 2026-09-29 00:30 in the pinned test timezone, so
    // dropping `timeZone: 'UTC'` moves this to 29 and fails.
    expect(time?.textContent).toContain('28')
    expect(time?.textContent).not.toContain('29')
    // And the locale and style, which a day-number assertion cannot see: 'vi-VN' →
    // 'en-US' and dateStyle 'long' → 'short' both left the suite green, so a
    // Vietnamese blog could quietly start printing "September 28, 2026" or "28/9/26".
    expect(time?.textContent).toBe(PUBLISHED_DATE_TEXT)
  })

  it('omits the date and the category when the post has neither', async () => {
    vi.mocked(getPost).mockResolvedValue({ ...post, publishedAt: null, category: null })

    const { container } = render(await renderPage(props('dat-van-de')))

    // The test above proves both can render, so these absences are discriminating.
    // Elements rather than text: a guard loosened to `publishedAt !== undefined`
    // renders an empty <time>, which an absent-text assertion would not see.
    expect(container.querySelector('time')).toBeNull()
    // The previous version of this test asserted `container.querySelector('span')`
    // was null. That was never a guard for the date or the category — neither is a
    // <span> — and it became actively wrong once the metadata row grew a reading-time
    // <span>, which this fixture does carry. The element-level guards for the two
    // nullable fields live in ReadingMeta.test.tsx, where the markup is; what belongs
    // here is that no category link reaches the page.
    expect(screen.queryByText('Technology')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Technology' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument()
  })

  it('404s an unknown slug instead of rendering a broken page', async () => {
    // The backend answers 404 with an {"error":{…}} envelope, which a client that
    // reads `.data.title` turns into a 500. lib/api.ts raises NotFoundError instead;
    // this is the half that has to turn it into a real 404.
    vi.mocked(getPost).mockRejectedValue(new NotFoundError('POST_NOT_FOUND', 'no such post'))
    // Before the 404, the page asks whether this is the old path of a post. It is not.
    vi.mocked(getPostRedirect).mockResolvedValue(null)

    await expect(PostPage(props('khong-ton-tai'))).rejects.toMatchObject({
      digest: 'NEXT_HTTP_ERROR_FALLBACK;404',
    })
    expect(getPostRedirect).toHaveBeenCalledWith('khong-ton-tai')
  })

  it('rethrows a 503 rather than reporting the post as missing', async () => {
    // `catch { notFound() }` — no instanceof check — passes the test above and turns
    // every outage into a permanent-looking 404 that a crawler will happily cache.
    const failure = new ApiError(503, 'UPSTREAM', 'database is down')
    vi.mocked(getPost).mockRejectedValue(failure)

    const thrown = await PostPage(props('dat-van-de')).then(
      () => null,
      (error: unknown) => error,
    )

    // Identity, not shape: proves the original error propagates untouched rather
    // than being re-wrapped or swapped for a 404 digest.
    expect(thrown).toBe(failure)
    // And no old path lookup: only a real 404 can be a slug that changed.
    expect(getPostRedirect).not.toHaveBeenCalled()
  })

  it('404s a slug the backend refuses (400) instead of throwing a 500 and a stack trace (issue 106)', async () => {
    // A backend 400 for a slug it will not take is a fact about the URL the visitor typed, not an outage: it is a not found.
    vi.mocked(getPost).mockRejectedValue(new ApiError(400, 'VALIDATION_ERROR', 'API responded 400'))

    await expect(PostPage(props('dat-van-de'))).rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' })
    // No old-path lookup either: the slug was never one a post could have.
    expect(getPostRedirect).not.toHaveBeenCalled()
  })

  it.each([
    ['a NUL byte', 'a%00b'],
    ['an encoded slash', '..%2F..%2Fx'],
    ['an encoded backslash', 'a%5Cb'],
    ['a control character', 'a%0Ab'],
    ['more than 255 characters', 'x'.repeat(256)],
  ])('404s a slug with %s without asking the backend (issue 106)', async (_label, slug) => {
    await expect(PostPage(props(slug))).rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' })
    await expect(generateMetadata(props(slug))).resolves.toEqual({ title: msg('Site.article.notFoundTitle') })
    expect(getPost).not.toHaveBeenCalled()
    expect(getPostRedirect).not.toHaveBeenCalled()
  })

  it('still rethrows a 5xx next to the new 400 rule (issue 106)', async () => {
    const failure = new ApiError(500, 'INTERNAL_ERROR', 'API responded 500')
    vi.mocked(getPost).mockRejectedValue(failure)

    const thrown = await PostPage(props('dat-van-de')).then(
      () => null,
      (error: unknown) => error,
    )

    expect(thrown).toBe(failure)
  })

  it('declares the revalidate window the route is supposed to have', () => {
    // Nothing else in the suite observes this, and neither the build nor the
    // typechecker cares what number it is.
    expect(revalidate).toBe(300)
  })

  it('leaves dynamicParams at its default so late posts are not 404s', async () => {
    // The other half of this route's build-resilience guarantee, and the half nothing
    // held. `export const dynamicParams = false` keeps every gate green — tests, lint,
    // typecheck and build — and then, on a build that ran with the API unreachable and
    // therefore prerendered nothing, every post URL answers 404 while the homepage still
    // links to them. Measured, both ways.
    const mod = await import('./page')

    expect(mod).not.toHaveProperty('dynamicParams')
  })
})

/**
 * Changing the slug of a published post does not kill the old link. The backend remembers the old slug; the post page,
 * when getPost returns 404, asks `getPostRedirect` and redirects PERMANENTLY (308) to the current slug.
 *
 * `permanentRedirect` is the real one from next/navigation: it throws an error with the digest
 * `NEXT_REDIRECT;replace;<url>;308;`. Asserting the digest, as with notFound(), is what tells a real
 * redirect apart from a page that keeps rendering or a temporary 307.
 */
describe('PostPage old path', () => {
  const missing = () => vi.mocked(getPost).mockRejectedValue(new NotFoundError('POST_NOT_FOUND', 'no such post'))

  it('old slug of a published post: 308 to the current slug, URL encoded', async () => {
    missing()
    vi.mocked(getPostRedirect).mockResolvedValue('duong-dan-moi')

    await expect(PostPage(props('duong-dan-cu'))).rejects.toMatchObject({
      digest: 'NEXT_REDIRECT;replace;/posts/duong-dan-moi;308;',
    })
    expect(getPost).toHaveBeenCalledWith('duong-dan-cu')
    expect(getPostRedirect).toHaveBeenCalledWith('duong-dan-cu')
  })

  it('asks with the exact normalized slug that getPost uses (decoded once, NFC), and encodes the target slug', async () => {
    missing()
    vi.mocked(getPostRedirect).mockResolvedValue(NFC_SLUG)

    await expect(PostPage(props(encodeURIComponent(OLD_SLUG.normalize('NFD'))))).rejects.toMatchObject({
      digest: `NEXT_REDIRECT;replace;${postPath(NFC_SLUG)};308;`,
    })
    // One slug, two calls: normalizing twice would peel an extra layer of encoding (normalizeSlug is not
    // idempotent), and the lookup would ask for a different slug than the one that just 404ed.
    expect(getPost).toHaveBeenCalledWith(OLD_SLUG)
    expect(getPostRedirect).toHaveBeenCalledWith(OLD_SLUG)
    expect(postPath(NFC_SLUG)).toBe(`/posts/${encodeURIComponent(NFC_SLUG)}`)
  })

  it('target equal to the asked slug (two caches disagreeing): 404, no circular redirect', async () => {
    missing()
    // The NFD form of the same text too: compared after normalization, like the asked slug itself.
    for (const target of [NFC_SLUG, NFC_SLUG.normalize('NFD')]) {
      vi.mocked(getPostRedirect).mockResolvedValue(target)
      await expect(PostPage(props(NFC_SLUG)), target).rejects.toMatchObject({
        digest: 'NEXT_HTTP_ERROR_FALLBACK;404',
      })
    }
  })

  it('failed lookup (503): the error passes through intact, it does not become a 404 that crawlers would cache', async () => {
    missing()
    const failure = new ApiError(503, 'UPSTREAM', 'database is down')
    vi.mocked(getPostRedirect).mockRejectedValue(failure)

    const thrown = await PostPage(props('duong-dan-cu')).then(
      () => null,
      (error: unknown) => error,
    )

    expect(thrown).toBe(failure)
  })
})

describe('PostPage table of contents', () => {
  /** The links of a TOC variant, by text. */
  const linkTexts = (nav: HTMLElement) =>
    within(nav)
      .getAllByRole('link')
      .map((link) => link.textContent)

  /**
   * Load-bearing for accessibility, not decoration. Task 6 made the heading anchors
   * `aria-hidden` with `tabIndex: -1` — an accessible name on a descendant anchor is
   * folded into the heading's own name — which leaves this table of contents as the
   * only route to a section that assistive tech or the keyboard can use.
   */
  it('is a labelled landmark whose links carry the heading text, in both variants', async () => {
    vi.mocked(getPost).mockResolvedValue(post)

    render(await renderPage(props('dat-van-de')))

    // jsdom shows both variants; CSS shows one of them at a time. Exactly one in the article and exactly one in the rail.
    expect(tocNavs()).toHaveLength(2)
    expect(inlineToc()).not.toBe(railToc())
    for (const nav of [inlineToc(), railToc()]) {
      // getAllByRole ignores aria-hidden subtrees, so this fails if the entries are
      // hidden from the accessibility tree the way the heading anchors are, and the
      // text comparison fails if they are replaced by an icon.
      expect(linkTexts(nav)).toEqual(['Problem statement', 'Details', 'Conclusion'])
      // Reachable by accessible name, which is what a screen-reader user does.
      expect(within(nav).getByRole('link', { name: 'Details' })).toBeInTheDocument()
    }
  })

  it('keys entries by id, so two sections with the same heading text are distinct', async () => {
    // Task 6 dedupes toc *ids* specifically so that these keys are unique — github-slugger
    // gives two identical headings the heading slug and the same slug with the `-1` suffix. Keying by `entry.text`
    // instead compiles, renders, and leaves every other assertion in this suite green;
    // React reports it only as a console error, which nothing was watching.
    // The same title three times: the table of contents only shows from three entries, and three identical keys are still
    // what this test catches.
    vi.mocked(getPost).mockResolvedValue({
      ...post,
      content: '## Introduction\n\nOne.\n\n## Introduction\n\nTwo.\n\n## Introduction\n\nThree.',
    })
    const errors: unknown[][] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args)
    })

    try {
      render(await renderPage(props('dat-van-de')))
    } finally {
      spy.mockRestore()
    }

    // Positive control: both sections really are in the toc with the same text, which is
    // what makes a text-based key a duplicate. Checked in each variant: each has its own list.
    for (const nav of [inlineToc(), railToc()]) {
      expect(linkTexts(nav)).toEqual(['Introduction', 'Introduction', 'Introduction'])
    }
    expect(errors.flat().join(' ')).not.toContain('same key')
  })

  it('points every entry at an id that exists in the rendered body', async () => {
    vi.mocked(getPost).mockResolvedValue(post)

    const { container } = render(await renderPage(props('dat-van-de')))

    for (const nav of [inlineToc(), railToc()]) {
      const links = within(nav).getAllByRole('link')

      expect(links).toHaveLength(3)
      for (const link of links) {
        const href = link.getAttribute('href') ?? ''
        expect(href, 'a toc entry must link to a fragment').toMatch(/^#.+/)
        // The fragment is percent-encoded and the id attribute is not; browsers decode
        // before matching. Decoding here is what makes this an assertion about the link
        // *resolving* rather than about two strings being spelled the same way.
        const id = decodeURIComponent(href.slice(1))
        const target = container.querySelector(`#${CSS.escape(id)}`)
        expect(target, `nothing on the page has id ${JSON.stringify(id)}`).not.toBeNull()
        expect(target?.tagName).toMatch(/^H[2-4]$/)
      }
    }
  })

  it('nests by heading level: an h3 in the sub-list of the h2 before it, the following h2 back to the top level', async () => {
    vi.mocked(getPost).mockResolvedValue(post)

    render(await renderPage(props('dat-van-de')))
    const item = (nav: HTMLElement, name: string) => within(nav).getByRole('link', { name }).closest('li')!

    // Pinned again on purpose: previously a flat list, indented by the style `(depth - 2) * 16` on
    // each <li>. Now it is a nested <ul>: screen readers announce the level ("list, 1 item" inside an item),
    // and the 16px indent per level is the `ps-4` of the sub-list (inline variant).
    const inline = inlineToc()
    const top = inline.querySelector('details > ul')!
    expect([...top.children]).toEqual([item(inline, 'Problem statement'), item(inline, 'Conclusion')])
    const nested = item(inline, 'Details').parentElement!
    expect(nested.tagName).toBe('UL')
    expect(nested.parentElement).toBe(item(inline, 'Problem statement'))
    expect(nested).toHaveClass('ps-4')
    // An entry with no children carries no empty list; no inline style remains.
    expect(item(inline, 'Conclusion').querySelector('ul')).toBeNull()
    expect(inline.querySelector('[style]')).toBeNull()

    // The rail variant nests the same way (its indent is on the links: TocNav.test.tsx pins the classes).
    const rail = railToc()
    const railTop = rail.querySelector('ul[data-toc-list]')!
    expect([...railTop.children]).toEqual([item(rail, 'Problem statement'), item(rail, 'Conclusion')])
    const railNested = item(rail, 'Details').parentElement!
    expect(railNested.tagName).toBe('UL')
    expect(railNested.parentElement).toBe(item(rail, 'Problem statement'))
    expect(item(rail, 'Conclusion').querySelector('ul')).toBeNull()
    expect(rail.querySelector('[style]')).toBeNull()
  })

  /*
   * The TOC class pinning (sticky, focus ring, the active entry changing colour only) lives in TocNav.test.tsx. What belongs
   * to the page is WHERE each variant is: the inline one inside the article before the body, the rail one in the reading
   * rail after the article, and the server HTML knowing nothing about the reader's position.
   */
  it('inline variant inside the article before the body, rail variant in the reading rail after it; no entry is active yet', async () => {
    vi.mocked(getPost).mockResolvedValue(post)

    const { container } = render(await renderPage(props('dat-van-de')))
    const article = container.querySelector('article')!
    const body = article.querySelector('div.prose')!
    const following = (a: Element, b: Element) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING

    expect(article.contains(inlineToc())).toBe(true)
    expect(following(inlineToc(), body)).toBeTruthy()
    // The reading rail is the last child of the article now (spec v2 2.5): the rail TOC is inside the article, after the body column.
    expect(article.contains(railToc())).toBe(true)
    expect(railAside().contains(railToc())).toBe(true)
    expect(following(body, railToc())).toBeTruthy()
    expect(container.querySelector('[data-reader-body]')!.contains(railToc())).toBe(false)
    // The server HTML does not know where the reader is: no link carries aria-current yet.
    for (const nav of [inlineToc(), railToc()]) expect(nav.querySelector('[aria-current]')).toBeNull()
  })

  it('omits the table of contents for a post with no headings', async () => {
    vi.mocked(getPost).mockResolvedValue({ ...post, content: 'Just one paragraph.' })

    const { container } = render(await renderPage(props('dat-van-de')))

    // Discriminating because the tests above prove the nav renders when there are
    // headings. Element and role, not text: `toc.length >= 0` renders an empty
    // bordered box, which no text assertion would see.
    //
    // Pinned again on purpose: previously it was "no nav at all", now the page always has
    // a "Breadcrumb" nav at the top of the post, so what needs saying is that there is no table of contents nav, by
    // name and by visible label alike, in either variant. Pair of the "yes" assertion: the path nav is still there, so the absence assertion is not green because
    // the page renders no nav at all.
    expect(screen.queryAllByRole('navigation', { name: TOC_NAME })).toHaveLength(0)
    expect(screen.queryByText(TOC_NAME)).not.toBeInTheDocument()
    expect(container.querySelector('nav[data-toc]')).toBeNull()
    expect(container.querySelector('[data-reader-body] nav ul li a[href^="#"]')).toBeNull()
    expect(railAside().querySelector('nav')).toBeNull()
    expect(screen.getByRole('navigation', { name: msg('Site.breadcrumb.label') })).toBeInTheDocument()
    // And the body still renders, so this is not passing because the page broke.
    expect(screen.getByText('Just one paragraph.')).toBeInTheDocument()
  })

  it('has an eyebrow [List] "Table of contents" naming each nav', async () => {
    vi.mocked(getPost).mockResolvedValue(post)

    render(await renderPage(props('dat-van-de')))

    // The landmark name is the visible text itself (aria-labelledby), not a parallel
    // aria-label that could drift from it. The two eyebrows have different ids so ids stay unique on the page.
    const ids = [inlineToc(), railToc()].map((nav) => {
      const label = within(nav).getByText(TOC_NAME)
      expect(nav).toHaveAttribute('aria-labelledby', label.id)
      expect(label.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
      return label.id
    })
    expect(ids).toEqual(['muc-luc', 'muc-luc-rail'])
  })

  /*
   * The table of contents only appears when the post is long enough to need it. Inline it is a <details> closed at every
   * width (below the rail breakpoint, a phone AND a tablet), from the rail breakpoint it is the list of the right rail.
   */
  it(`MIN_TOC_ENTRIES = 3: a post with two headings has no table of contents, a post with exactly three headings does`, async () => {
    expect(MIN_TOC_ENTRIES).toBe(3)

    vi.mocked(getPost).mockResolvedValue({ ...post, content: '## One\n\nA.\n\n### Two\n\nB.' })
    const two = render(await renderPage(props('dat-van-de')))
    // Two entries are readable within one screen: a "Table of contents" frame there would only take the room of the first paragraph.
    expect(screen.queryAllByRole('navigation', { name: TOC_NAME })).toHaveLength(0)
    expect(screen.queryByText(TOC_NAME)).not.toBeInTheDocument()
    // The post is still complete, and the headings still have ids for #section links: only the table of contents frame is absent.
    expect(two.container.querySelector('div.prose h2[id]')).not.toBeNull()
    two.unmount()

    vi.mocked(getPost).mockResolvedValue({ ...post, content: '## One\n\nA.\n\n### Two\n\nB.\n\n## Three\n\nC.' })
    render(await renderPage(props('dat-van-de')))
    // The 3-entry link count holds for each variant.
    expect(tocNavs()).toHaveLength(2)
    for (const nav of [inlineToc(), railToc()]) expect(linkTexts(nav)).toEqual(['One', 'Two', 'Three'])
  })

  it('inline: a <details> closed in the server HTML, the "Table of contents" label is a <summary> to click to open; rail: a plain list', async () => {
    vi.mocked(getPost).mockResolvedValue(post)

    const html = renderToString(<IntlWrapper>{await renderPage(props('dat-van-de'))}</IntlWrapper>)
    const host = document.createElement('div')
    host.innerHTML = html
    const nav = host.querySelector('nav[aria-labelledby="muc-luc"]')!
    const details = nav.querySelector(':scope > details')!

    expect(details).not.toBeNull()
    // Closed by default: on a phone the first paragraph of the post sits right below the cover image.
    expect(details.hasAttribute('open')).toBe(false)
    const summary = details.querySelector(':scope > summary')!
    expect(summary.querySelector('#muc-luc')?.textContent).toBe(TOC_NAME)
    // The list is the content part of <details>, after the <summary>, not inside it.
    const list = details.querySelector(':scope > ul')!
    expect(list.querySelectorAll('a[href^="#"]')).toHaveLength(3)
    expect(summary.contains(list)).toBe(false)

    // The rail variant is not a <details> at all: its list is always visible when the rail is.
    const rail = host.querySelector('aside nav[aria-labelledby="muc-luc-rail"]')!
    expect(rail).not.toBeNull()
    expect(rail.querySelector('details')).toBeNull()
    expect(rail.querySelectorAll('ul[data-toc-list] a[href^="#"]')).toHaveLength(3)
  })

  it('inline: closed at every width and the whole row is the click area; no always-open trick from md', async () => {
    vi.mocked(getPost).mockResolvedValue(post)

    render(await renderPage(props('dat-van-de')))
    const details = inlineToc().querySelector('details')!
    const summary = details.querySelector('summary')!
    const classes = (element: Element) => element.getAttribute('class')?.split(/\s+/) ?? []

    // The always-open `::details-content` trick of the old page is gone: at 768-1087 an 11-entry table of contents must not
    // push the first paragraph down (spec 5.2). The default triangle is not used (flex + list-none) and the site arrow shows at every width.
    expect(classes(details).some((name) => name.includes('details-content'))).toBe(false)
    expect(classes(summary)).toEqual(
      expect.arrayContaining(['flex', 'list-none', '[&::-webkit-details-marker]:hidden', 'p-4', 'focus-visible:outline-2']),
    )
    expect(classes(summary)).not.toContain('md:pointer-events-none')
    const icons = summary.querySelectorAll('svg')
    const chevron = icons[icons.length - 1]!
    expect(chevron).toHaveAttribute('aria-hidden', 'true')
    expect(classes(chevron)).not.toContain('md:hidden')
  })

  it('not printed: on paper the #section links lead nowhere, in either variant', async () => {
    vi.mocked(getPost).mockResolvedValue(post)

    render(await renderPage(props('dat-van-de')))

    expect(tocNavs()).toHaveLength(2)
    for (const nav of tocNavs()) expect(nav).toHaveClass('print:hidden')
  })

  it('the pieces of the table of contents are still server components, no hooks; the client-side JS is only the TocSpy island, with no props', () => {
    // ArticleView composes the header and body, TocNav draws both variants, ReadingRail places them: all three stay server code.
    const sources = ['ArticleView.tsx', 'TocNav.tsx', 'reader/ReadingRail.tsx'].map((file) =>
      readFileSync(join(process.cwd(), 'components/site', file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, ''),
    )

    for (const code of sources) {
      expect(code).not.toMatch(/['"]use client['"]/)
      expect(code).not.toMatch(/\bon[A-Z]\w*=\{/)
      // `useTranslations` is the one hook a sync server component may call (ReadingRail); no other hook appears.
      expect(code.replace(/\buseTranslations\b/g, '')).not.toMatch(/\buse[A-Z]\w*\s*\(/)
    }
    // The island reads links and headings from the DOM; a prop here would be table of contents data copied into the RSC payload.
    const spies = sources.flatMap((code) => code.match(/<TocSpy\b[^>]*>/g) ?? [])
    expect(spies.length).toBeGreaterThan(0)
    expect(spies.every((spy) => spy === '<TocSpy />')).toBe(true)
  })
})

/*
 * The print version of the post page: the post prints in full, the site frame does not. Every part that is not the post carries
 * `print:hidden` in its own component (header and footer: Header.test.tsx); here is the contract of the whole
 * page, so that a new block added at the end of the post without it turns red here.
 */
describe('PostPage print version', () => {
  /** The nearest element, including itself, that carries `print:hidden`; null if none. */
  const printHidden = (element: Element) => element.closest('.print\\:hidden')

  it('not printed: both tables of contents, left rail, reading rail, progress bar, like button, share row, comments, PostNav, related posts, "What to read next"', async () => {
    vi.mocked(getPost).mockResolvedValue(post)
    stubPublished([summary('moi-hon'), summary('dat-van-de'), summary('cu-hon'), summary('a', IN_CATEGORY)])
    vi.mocked(getDiscovery).mockResolvedValue({
      ...NO_DISCOVERY,
      recent: [summary('moi-viet', { title: 'Freshly written post' })],
    })

    const { container } = render(await renderPage(props('dat-van-de')))

    const chrome: [string, Element | null][] = [
      ['inline table of contents', inlineToc()],
      ['rail table of contents', railToc()],
      ['left rail', leftAside()],
      ['left rail, desktop copy', leftDesktop()],
      ['left rail, mobile copy', leftMobile()],
      ['reading rail', railAside()],
      // The thin fixed bar at the top of the viewport: the only element of the page that is `fixed` and full width.
      ['progress bar', container.querySelector('div.fixed.inset-x-0')],
      ['like button', container.querySelector('#luot-thich')],
      ['share row', screen.getByRole('list', { name: msg('Site.share.label') })],
      // Exactly one copy button, in the hero's action group (the group carries print:hidden, the button is not hidden by itself).
      ['copy link', screen.getByRole('button', { name: msg('Site.share.copyLink') })],
      ['hero action group', screen.getByRole('group', { name: msg('Site.reader.actionsLabel') })],
      [
        'hero Subscribe link',
        within(document.querySelector<HTMLElement>('[data-reader-hero]')!).getByRole('link', {
          name: msg('Site.reader.subscribe'),
        }),
      ],
      ['comments', screen.getByRole('region', { name: msg('Site.comments.heading') })],
      ['PostNav', screen.getByRole('navigation', { name: msg('Site.postNav.navLabel') })],
      ['related posts', screen.getByRole('region', { name: msg('Site.related.title') })],
      ['read next', screen.getByRole('region', { name: msg('Site.article.readNextTitle') })],
    ]
    for (const [name, element] of chrome) {
      expect(element, `${name} must be on the page`).not.toBeNull()
      expect(printHidden(element!), `${name} must be inside a print:hidden element`).not.toBeNull()
    }
    // The copy button sits inside the hero, which itself is NOT hidden: only its action group and Subscribe are.
    const copy = screen.getByRole('button', { name: msg('Site.share.copyLink') })
    expect(copy.closest('[data-reader-hero]')).not.toBeNull()
    expect(copy.closest('[role="group"]')).toBe(screen.getByRole('group', { name: msg('Site.reader.actionsLabel') }))
    expect(container.querySelector('[data-reader-hero]')!.className).not.toMatch(/\bprint:hidden\b/)
  })

  it('prints the full post: title, dek, publish date, "Updated", reading time, tags, cover image, body, author', async () => {
    vi.mocked(getPost).mockResolvedValue({ ...post, updatedAt: '2026-10-06T08:00:00Z' })

    const { container } = render(await renderPage(props('dat-van-de')))
    const article = container.querySelector('article')!

    const kept: [string, Element | null][] = [
      ['article', article],
      ['hero', article.querySelector('[data-reader-hero]')],
      ['h1', article.querySelector('h1')],
      ['dek', screen.getByText('A short write-up.')],
      ['hero author name', article.querySelector('[data-reader-hero] a[href="/about"]')],
      ['publish date', article.querySelector('time')],
      ['updated', screen.getByText(new RegExp(`^${UPDATED_PREFIX}`))],
      ['reading time', screen.getByText(msg('Site.article.readingTime', { minutes: '12' }))],
      ['tags', article.querySelector(`ul[aria-label="${msg('Site.article.tagsLabel')}"]`)],
      ['cover art', article.querySelector('svg.cover-art')],
      ['body', article.querySelector('div.prose')],
      ['author', screen.getByRole('complementary', { name: PROFILE_NAME })],
    ]
    for (const [name, element] of kept) {
      expect(element, `${name} must be on the page`).not.toBeNull()
      expect(printHidden(element!), `${name} must not be inside any print:hidden element`).toBeNull()
    }
    // The author box is no longer inside <article> (it moved to the end blocks), and still prints: the grid around it is a
    // plain block on paper (`print:block`) and the end slot carries no `print:hidden`.
    expect(article.contains(screen.getByRole('complementary', { name: PROFILE_NAME }))).toBe(false)
    expect(container.querySelector('.print\\:block')).not.toBeNull()
  })
})

describe('generateStaticParams', () => {
  it('returns one param per post and locale, spelled exactly as the API spells the slug', async () => {
    vi.mocked(getPosts).mockResolvedValue({
      items: [summary(NFC_SLUG), summary('xin-chao')],
      meta: { page: 0, size: 200, totalElements: 2, totalPages: 1 },
    })

    // Raw, not percent-encoded: Next encodes the segment when it builds the route,
    // so encoding here would publish the post at its double-encoded path.
    await expect(generateStaticParams()).resolves.toEqual(
      [NFC_SLUG, 'xin-chao'].flatMap((slug) => routing.locales.map((locale) => ({ locale, slug }))),
    )
    expect(getPosts).toHaveBeenCalledWith({ page: 0, size: 200 })
  })

  it('returns an empty list instead of failing the build when the API is unreachable', async () => {
    // `next build` exits 1 with no partial output if this throws — Review Focus #3,
    // and the case CI hits. It has to resolve, not reject.
    vi.mocked(getPosts).mockRejectedValue(new TypeError('fetch failed'))

    await expect(generateStaticParams()).resolves.toEqual([])
  })
})

describe('generateMetadata', () => {
  it('titles the document with the post and describes it with the excerpt', async () => {
    vi.mocked(getPost).mockResolvedValue(post)

    // STILL a whole-object deep equality, on purpose. This page now builds its metadata
    // through lib/metadata.ts, and `toEqual` is what pins the EXACT key set that helper
    // produces for an article: if a future edit drops `locale`, `siteName` or `images`
    // from the shared builder, six other routes lose them silently and this one assertion
    // is what says so. Downgrading it to `toMatchObject` would retire that guard.
    //
    // The keys worth naming:
    //  - `images` — a post without a cover image carries its OWN card (/api/og/posts/<slug>), not the site-wide
    //    one every other route restates; the `v` parameter is the update time, so an edit busts the unfurlers' caches.
    //  - `locale` and `siteName` — the same rule failing the other way round. This route
    //    and /about were the only two that wrote their own openGraph block, and they were
    //    the only two measured emitting no og:locale and no og:site_name at all.
    //  - `url` — equal to `alternates.canonical` by construction rather than by agreement
    //    between two expressions; lib/metadata.ts derives both from the one argument.
    await expect(generateMetadata(props('dat-van-de'))).resolves.toEqual({
      /**
       * `{ absolute }`, and that shape IS the assertion: it is what opts this route out of
       * `title.template` in app/layout.tsx, so the document title is the article's title
       * and carries no ` — the owner name`.
       *
       * Measured in the font Google renders desktop result titles in — Arial 20px,
       * against the ~600px the title column gives — over the twelve published articles:
       * with the suffix 9 of 12 exceed 600px (longest 975px), without it 2. The suffix
       * alone causes seven of the nine truncations.
       *
       * This is NOT a character-count rule; the note at the top of
       * test/article-metadata.test.ts refuses one, and rightly — a character count is a
       * proxy for a pixel width. Here the pixel width is the measurement, and the thing
       * being removed is a constant that carries no information this page has not already
       * given Google in `og:siteName` and the BlogPosting's `author.name`.
       *
       * A plain string here would silently put the suffix back on all twelve.
       */
      title: { absolute: 'Performance problem statement' },
      description: 'A short write-up.',
      alternates: {
        canonical: '/posts/dat-van-de',
        // The feed's discovery link. On the ROOT layout it would be dropped by every page
        // that states its own canonical — which is all of them — so lib/metadata.ts emits
        // it per page instead. Pinned here because that is the only way the deletion is
        // visible: a missing rel=alternate breaks nothing and shows nowhere.
        types: { 'application/rss+xml': '/feed.xml' },
      },
      openGraph: {
        // The post's own card with its title as alt (built by postCardOgImage); every other public route restates the site-wide
        // image, lib/metadata.test.ts asserts that half.
        images: [
          {
            url: `/api/og/posts/dat-van-de?v=${Date.parse(post.updatedAt)}`,
            width: 1200,
            height: 630,
            alt: 'Performance problem statement',
          },
        ],
        locale: 'vi_VN',
        siteName: site.name,
        type: 'article',
        title: 'Performance problem statement',
        description: 'A short write-up.',
        url: '/posts/dat-van-de',
        publishedTime: '2026-09-28T17:30:00Z',
        modifiedTime: '2026-09-02T00:00:00Z',
      },
      twitter: {
        card: 'summary_large_image',
        title: 'Performance problem statement',
        description: 'A short write-up.',
      },
    })
    expect(getPost).toHaveBeenCalledWith('dat-van-de')
  })

  it('overrides the root layout canonical instead of inheriting "/"', async () => {
    // Metadata is INHERITED by every route that does not override it, and app/layout.tsx
    // used to set `alternates: { canonical: '/' }`. Measured on the running dev server at
    // the time: /posts/sample-post-05 emitted
    // `<link rel="canonical" href="http://localhost:3000"/>` — every article declaring
    // itself a duplicate of the homepage, which is grounds for being dropped from the
    // index entirely. Nothing in the suite could see it, because the page's own metadata
    // object was simply missing the key.
    //
    // Fixed twice over since: the root canonical is gone (app/(site)/page.tsx now states
    // '/' for the homepage alone) AND this page states its own. Either fix alone would
    // work; both is deliberate, because a page that declares its own canonical cannot be
    // broken by a layout someone adds above it later. This test guards THAT property, so
    // it stays meaningful even though the inherited value it was written against is gone.
    vi.mocked(getPost).mockResolvedValue(post)

    const metadata = await generateMetadata(props('dat-van-de'))

    expect(metadata.alternates?.canonical).toBe('/posts/dat-van-de')
    expect(metadata.alternates?.canonical).not.toBe('/')
  })

  it('under /en the canonical is the original URL and there are no hreflang alternates', async () => {
    // A post has no language of its own yet: /en/posts/<slug> shows the same Vietnamese post.
    vi.mocked(getPost).mockResolvedValue(post)

    const metadata = await generateMetadata({
      ...props('dat-van-de'),
      params: Promise.resolve({ locale: 'en', slug: 'dat-van-de' }),
    })

    expect(metadata.alternates?.canonical).toBe('/posts/dat-van-de')
    expect(metadata.openGraph?.url).toBe('/posts/dat-van-de')
    expect(metadata.alternates).not.toHaveProperty('languages')
  })

  it('canonicalises to the slug the API stores, not the one in the URL', async () => {
    // The reader can arrive on a decomposed (NFD) spelling of a Vietnamese slug. Both
    // spellings render the same article, so exactly one of them may be canonical — and
    // it has to be the backend's, or the canonical tag points at a second URL for the
    // same post, which is the duplicate it exists to collapse.
    vi.mocked(getPost).mockResolvedValue({ ...post, slug: NFC_SLUG })

    const metadata = await generateMetadata(props(NFD_SLUG))

    expect(metadata.alternates?.canonical).toBe(`/posts/${encodeURIComponent(NFC_SLUG)}`)
    expect(metadata.alternates?.canonical).not.toContain(NFD_SLUG)
  })

  it('omits publishedTime rather than emitting it empty for an undated post', async () => {
    vi.mocked(getPost).mockResolvedValue({ ...post, publishedAt: null })

    const metadata = await generateMetadata(props('dat-van-de'))

    // `article:published_time` with an empty value is rejected by OG parsers, and
    // `publishedTime: null` does not typecheck as absent — spelling it out pins the
    // key set rather than the value.
    expect(Object.keys(metadata.openGraph ?? {})).not.toContain('publishedTime')
    expect(metadata.openGraph).toMatchObject({ type: 'article' })
  })

  it('normalizes the slug the same way the page does', async () => {
    vi.mocked(getPost).mockResolvedValue(post)

    await generateMetadata(props(NFD_SLUG))

    // generateMetadata runs as its own invocation, so it repeats the normalisation
    // rather than inheriting it. Losing it here gives a page that renders while its
    // <title> falls back to "not found".
    expect(getPost).toHaveBeenCalledWith(NFC_SLUG)
    expect(getPost).not.toHaveBeenCalledWith(NFD_SLUG)
  })

  it('leaves the description undefined rather than null when there is no excerpt', async () => {
    vi.mocked(getPost).mockResolvedValue({ ...post, excerpt: null })

    const metadata = await generateMetadata(props('dat-van-de'))

    // `Metadata['description']` is `string | null`, so `post.excerpt` on its own
    // typechecks and emits `<meta name="description" content="">`. toBeUndefined
    // fails on null, which is the point of using it here.
    expect(metadata.description).toBeUndefined()
    // And in both the places that repeat it — one `?? undefined` covers all three
    // only because `description` is computed once.
    expect(metadata.openGraph?.description).toBeUndefined()
    expect(metadata.twitter?.description).toBeUndefined()
    // The title is unaffected by a missing excerpt, and still opts out of the brand
    // suffix — see the note on the deep-equality assertion above for the measurement.
    expect(metadata.title).toEqual({ absolute: 'Performance problem statement' })
  })

  it('post with a cover image: og:image is the ~1200px version of the cover image through /_next/image, with dimensions and alt', async () => {
    vi.mocked(getPost).mockResolvedValue({ ...post, cover: COVER })

    const metadata = await generateMetadata(props('dat-van-de'))

    // Pair of the "yes" case of the "no images key" assertion in the deep-equality test above: a post with a cover
    // image declares the cover as its images, so the generated text card gives way to the image the author chose.
    // The 1200px version and not the original file (up to 2400px, 4 MiB): dimensions follow the resized version.
    expect(metadata.openGraph?.images).toEqual([
      {
        url: `/_next/image?url=%2Fmedia%2F${COVER.fileName}&w=1200&q=75`,
        width: 1200,
        height: Math.round((COVER.height * 1200) / COVER.width),
        alt: COVER.altText,
      },
    ])
  })

  it('cover image without a description: the alt of og:image is the post title', async () => {
    vi.mocked(getPost).mockResolvedValue({ ...post, cover: { ...COVER, altText: null } })

    const metadata = await generateMetadata(props('dat-van-de'))

    expect((metadata.openGraph?.images as { alt: string }[])[0].alt).toBe(post.title)
  })

  it('falls back to a not-found title instead of throwing when the post is missing', async () => {
    // A throw here is not a 404 — it is an unhandled error during metadata
    // generation, which takes the whole response with it before the page's own
    // notFound() gets a chance to run.
    //
    // So it is the *not throwing* that is load-bearing, not the string. Measured on the
    // served app: a missing slug's <head> carries `<title>Blog</title>`, the layout's
    // default — notFound() discards the page's metadata, and this title reaches only the
    // flight payload. Worth knowing before anyone "fixes" the wording expecting to see
    // it in a browser tab.
    vi.mocked(getPost).mockRejectedValue(new NotFoundError('POST_NOT_FOUND', 'no such post'))
    vi.mocked(getPostRedirect).mockResolvedValue(null)

    await expect(generateMetadata(props('khong-ton-tai'))).resolves.toEqual({
      title: msg('Site.article.notFoundTitle'),
    })
  })

  it('old path: redirects with 308 like the page itself, builds no metadata for a 404', async () => {
    // Metadata runs as a separate call, sometimes even before the page (crawlers receive head-blocking metadata):
    // it must give the same answer as the page, not a "not found" title for a
    // URL that is really a 308.
    vi.mocked(getPost).mockRejectedValue(new NotFoundError('POST_NOT_FOUND', 'no such post'))
    vi.mocked(getPostRedirect).mockResolvedValue('duong-dan-moi')

    await expect(generateMetadata(props('duong-dan-cu'))).rejects.toMatchObject({
      digest: 'NEXT_REDIRECT;replace;/posts/duong-dan-moi;308;',
    })
    expect(getPostRedirect).toHaveBeenCalledWith('duong-dan-cu')
  })

  it('failed old path lookup, or a post failing with something other than 404: still the fallback title, no throw', async () => {
    // The rule of this function stays: an error thrown from metadata that is not a 404 drags the whole response
    // down with it. The page throws its own real error (the PostPage 503 test).
    vi.mocked(getPost).mockRejectedValue(new NotFoundError('POST_NOT_FOUND', 'no such post'))
    vi.mocked(getPostRedirect).mockRejectedValue(new ApiError(503, 'UPSTREAM', 'database is down'))
    await expect(generateMetadata(props('duong-dan-cu'))).resolves.toEqual({ title: msg('Site.article.notFoundTitle') })

    vi.mocked(getPostRedirect).mockClear()
    vi.mocked(getPost).mockRejectedValue(new ApiError(503, 'UPSTREAM', 'database is down'))
    await expect(generateMetadata(props('dat-van-de'))).resolves.toEqual({ title: msg('Site.article.notFoundTitle') })
    // Only a real 404 is worth asking about the old path.
    expect(getPostRedirect).not.toHaveBeenCalled()
  })
})

describe('PostPage landmarks', () => {
  it('renders no <main> of its own', async () => {
    vi.mocked(getPost).mockResolvedValue(post)

    render(await renderPage(props('dat-van-de')))

    // THIS ASSERTION IS INVERTED FROM WHAT IT USED TO BE, and the comment it replaces
    // ("app/layout.tsx provides no <main>") is no longer true: the layout now owns
    // `<main id="main-content">`, which is also the skip link's target. Measured on
    // the running dev server while both existed: /posts/<slug> emitted TWO <main>
    // elements. Two main landmarks is invalid HTML and makes "skip to main content"
    // ambiguous, and no test in the suite could see it because every page test renders
    // the page without the layout.
    expect(screen.queryByRole('main')).not.toBeInTheDocument()
  })

  it('is the grid plus the discovery band, with no frame div of its own: the 1400px frame is <main> (SiteChrome)', async () => {
    vi.mocked(getPost).mockResolvedValue(post)
    vi.mocked(getDiscovery).mockResolvedValue({
      ...NO_DISCOVERY,
      recent: [summary('moi-viet', { title: 'Freshly written post' })],
    })

    const { container } = render(await renderPage(props('dat-van-de')))
    const article = container.querySelector('article')!
    const grid = article.parentElement!

    // The page root is the grid (a fragment, no wrapper): `data-reader-grid` is the hook of the layout tests and the e2e geometry
    // checks. Class names only: jsdom applies no Tailwind, so this catches the wrapper coming back and says nothing about how the page looks.
    expect(grid).toHaveAttribute('data-reader-grid')
    expect(container.querySelectorAll('[data-reader-grid]')).toHaveLength(1)
    expect(container.firstElementChild).toBe(grid)
    expect(grid.parentElement).toBe(container)
    expect(container.querySelector('[data-reader-frame]')).toBeNull()
    expect(container.innerHTML).not.toMatch(/data-reader-frame|data-site-frame|data-site-footer/)
    expect(grid.className).not.toMatch(/max-w-/)
    // The discovery band is the grid's next sibling, at the same level: it is not inside the grid.
    const band = screen.getByRole('region', { name: msg('Site.article.readNextTitle') })
    expect(grid.contains(band)).toBe(false)
    expect(container.contains(band)).toBe(true)
    expect(grid.className.split(/\s+/)).toEqual(expect.arrayContaining(READER_GRID.split(/\s+/)))
    expect(grid).toHaveClass('flex-1')
    // The article is a grid item, not a Container: it carries the slot and no gutter or frame width of its own.
    expect(article.className.split(/\s+/)).toEqual(expect.arrayContaining(ARTICLE_SLOT.split(/\s+/)))
    expect(article.className).not.toMatch(/\bpx-4\b|\bsm:px-6\b|\bmax-w-\[87\.5rem\]|\bmax-w-6xl\b|\bmax-w-3xl\b/)
    expect(article).toHaveAttribute('id', 'post-article')
    // The hero and the body column carry their slots.
    const hero = article.querySelector('[data-reader-hero]')!
    const column = article.querySelector('[data-reader-body]')!
    expect(hero.className.split(/\s+/)).toEqual(expect.arrayContaining(HERO_SLOT.split(/\s+/)))
    expect(column.className.split(/\s+/)).toEqual(expect.arrayContaining(BODY_SLOT.split(/\s+/)))
    // The grid holds exactly the slots of the layout, in DOM order: two skip links, left rail, article, end blocks. The reading
    // rail is not a grid child any more: it is the last child of the article.
    expect([...grid.children].map((child) => child.tagName)).toEqual(['A', 'A', 'ASIDE', 'ARTICLE', 'DIV'])
    expect(grid.children[3]).toBe(article)
    expect(grid.lastElementChild!.className.split(/\s+/)).toEqual(expect.arrayContaining(END_SLOT.split(/\s+/)))
  })

  it('has exactly one h1, and no heading in either rail', async () => {
    vi.mocked(getPost).mockResolvedValue(post)
    stubPublished([summary('a', IN_CATEGORY), summary('dat-van-de', IN_CATEGORY)])

    const { container } = render(await renderPage(props('dat-van-de')))

    // The rails precede or follow the article in the DOM: a heading there would be an "h2 before the h1" or a second outline.
    expect(container.querySelectorAll('h1')).toHaveLength(1)
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(within(leftAside()).queryAllByRole('heading')).toHaveLength(0)
    expect(within(railAside()).queryAllByRole('heading')).toHaveLength(0)
    expect(leftAside().querySelector('h1, h2, h3, h4, h5, h6')).toBeNull()
    expect(railAside().querySelector('h1, h2, h3, h4, h5, h6')).toBeNull()
  })

  it('two skip links come first (#post-article, then #post-body) and both precede the left rail and the article', async () => {
    vi.mocked(getPost).mockResolvedValue(post)

    const { container } = render(await renderPage(props('dat-van-de')))
    const skip = screen.getByRole('link', { name: msg('Site.reader.skipToArticle') })
    const skipBody = screen.getByRole('link', { name: msg('Site.reader.skipToBody') })
    const article = container.querySelector('article')!
    const column = container.querySelector('[data-reader-body]')!

    expect(skip).toHaveAttribute('href', '#post-article')
    expect(skipBody).toHaveAttribute('href', '#post-body')
    expect(article.id).toBe('post-article')
    // The second one lands on the body column, which can take programmatic focus.
    expect(column.id).toBe('post-body')
    expect(column).toHaveAttribute('tabindex', '-1')
    for (const link of [skip, skipBody]) {
      expect(leftAside().contains(link)).toBe(false)
      expect(railAside().contains(link)).toBe(false)
      expect(link.compareDocumentPosition(leftAside()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(link.compareDocumentPosition(article) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
    expect(skip.compareDocumentPosition(skipBody) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The first two focusable things of the page content, ahead of every rail link.
    expect([...container.querySelectorAll('a')].slice(0, 2)).toEqual([skip, skipBody])
  })
})

describe('PostPage reading metadata', () => {
  it('links the category to its own page and each tag by slug', async () => {
    vi.mocked(getPost).mockResolvedValue(post)

    render(await renderPage(props('dat-van-de')))

    expect(
      within(screen.getByRole('navigation', { name: msg('Site.breadcrumb.label') })).getByRole('link', { name: 'Technology' }),
    ).toHaveAttribute('href', '/categories/cong-nghe')
    // The fixture's tag is name 'Spring Boot', slug 'spring-boot' — deliberately
    // different, so a component linking by name is distinguishable from one linking
    // by slug. The route filters on the slug.
    const tag = screen.getByRole('link', { name: 'Spring Boot' })
    expect(tag).toHaveAttribute('href', '/tags/spring-boot')
    expect(tag.getAttribute('href')).not.toContain('Spring')
  })

  it('shows the reading estimate the API returned', async () => {
    vi.mocked(getPost).mockResolvedValue(post)

    render(await renderPage(props('dat-van-de')))

    // 12, from the fixture's readingMinutes — not computed here, and not a constant.
    expect(screen.getByText(msg('Site.article.readingTime', { minutes: '12' }))).toBeInTheDocument()
  })

  it('edit date earlier than the publish date (fixture: last saved 2/9, published 28/9): no "Updated" line', async () => {
    vi.mocked(getPost).mockResolvedValue(post)

    const { container } = render(await renderPage(props('dat-van-de')))

    // A post created as a draft and published after the last save: `updatedAt` is earlier than `publishedAt`, and
    // "Updated 2 September" under "28 September" is a meaningless sentence.
    expect(screen.queryByText(new RegExp(UPDATED_PREFIX))).not.toBeInTheDocument()
    expect(container.querySelectorAll('article time')).toHaveLength(1)
  })

  it('edited on a day after the publish day: "Updated <date>" in the meta row, right after the publish date', async () => {
    vi.mocked(getPost).mockResolvedValue({ ...post, updatedAt: '2026-10-06T08:00:00Z' })

    const { container } = render(await renderPage(props('dat-van-de')))

    // Meta row: the line right BEFORE the h1 in the hero (breadcrumb, meta row, h1, ...), like the views test.
    const row = container.querySelector('article h1')!.previousElementSibling!
    const times = row.querySelectorAll('time')
    expect(times).toHaveLength(2)
    expect(times[0]).toHaveAttribute('dateTime', '2026-09-28T17:30:00Z')
    expect(times[1]).toHaveAttribute('dateTime', '2026-10-06T08:00:00Z')
    expect(times[1]!.parentElement?.textContent).toBe(updatedText(UPDATED_DATE_TEXT))
    // The same edit date as the structured data (`dateModified`): two signals must not say two things.
    const blogPosting = JSON.parse(container.querySelector('script[type="application/ld+json"]')?.textContent ?? '')
    expect(blogPosting.dateModified).toBe('2026-10-06T08:00:00Z')
  })
})

describe('PostPage copy link', () => {
  it('offers exactly one named copy button, in the hero before the post body', async () => {
    vi.mocked(getPost).mockResolvedValue(post)

    const { container } = render(await renderPage(props('dat-van-de')))

    // Only that it is wired in and named. The clipboard behaviour — the missing API,
    // the rejected write, the URL coming from the slug rather than window.location —
    // is CopyLink.test.tsx's job, where it can be stubbed properly.
    //
    // Pinned again: CopyLink moved from the share row of the reading rail to the hero's action group, and there is still exactly
    // ONE button on the page. "Inside the hero, before the post body" is what tells the new position apart from the old one.
    const buttons = screen.getAllByRole('button', { name: msg('Site.share.copyLink') })
    expect(buttons).toHaveLength(1)
    expect(buttons[0]!.closest('[data-reader-hero]')).not.toBeNull()
    expect(railAside().contains(buttons[0]!)).toBe(false)
    const body = container.querySelector('article div.prose')!
    expect(body.compareDocumentPosition(buttons[0]!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
    expect(body.compareDocumentPosition(buttons[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeFalsy()
  })
})

describe('PostPage structured data', () => {
  const jsonLd = (container: HTMLElement) => container.querySelector('script[type="application/ld+json"]')

  it('emits a BlogPosting for a published post', async () => {
    vi.mocked(getPost).mockResolvedValue(post)

    const { container } = render(await renderPage(props('dat-van-de')))
    const script = jsonLd(container)

    expect(script).not.toBeNull()
    expect(JSON.parse(script?.textContent ?? '')).toMatchObject({
      '@type': 'BlogPosting',
      headline: 'Performance problem statement',
      datePublished: '2026-09-28T17:30:00Z',
      dateModified: '2026-09-02T00:00:00Z',
      description: 'A short write-up.',
    })
  })

  it('emits nothing for a post that is not published', async () => {
    // Advertising a BlogPosting for a draft hands an aggregator a URL that answers
    // 404 to the crawler that follows it.
    vi.mocked(getPost).mockResolvedValue({ ...post, status: 'DRAFT' })

    const { container } = render(await renderPage(props('dat-van-de')))

    expect(jsonLd(container)).toBeNull()
    // The article itself still renders, so this is not passing because the page died.
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument()
  })

  it('survives a title containing </script> all the way to the rendered page', async () => {
    // The escaping is pinned in ArticleJsonLd.test.tsx against the emitted HTML
    // string. This is the end-to-end half: the page really does route the title
    // through the escaper rather than building a script tag of its own.
    vi.mocked(getPost).mockResolvedValue({ ...post, title: 'Doc ky </script><img src=x>' })

    const { container } = render(await renderPage(props('dat-van-de')))

    expect(JSON.parse(jsonLd(container)?.textContent ?? '')).toMatchObject({
      headline: 'Doc ky </script><img src=x>',
    })
    // Nothing broke out of the element into the document.
    //
    // Pinned again in the new sense: the post page can now HAVE a valid <img> (cover image, author avatar).
    // This fixture has no cover image and profile.avatar is null (the top of the post is SVG cover art), so
    // an <img> here can only be a tag escaping from the JSON-LD. The "cover image means <img>" pair
    // lives in the describe "PostPage lead image".
    expect(container.querySelector('svg.cover-art')).not.toBeNull()
    expect(container.querySelector('img')).toBeNull()
  })
})

describe('PostPage related posts', () => {
  /**
   * Scoped to the section, not the document. The article body renders its own h3
   * ("Details", from the fixture's Markdown) through the real `renderMarkdown`
   * pipeline, so a document-wide `getAllByRole('heading', { level: 3 })` picks that up
   * too — which is how the first version of these assertions failed, with the body's
   * own heading leading the list.
   */
  const relatedSection = () => screen.getByRole('heading', { level: 2, name: msg('Site.related.title') }).closest('section')!

  it('shows up to three posts from the same category, never the current one', async () => {
    vi.mocked(getPost).mockResolvedValue(post)
    stubPublished([
      summary('dat-van-de', IN_CATEGORY),
      summary('a', { ...IN_CATEGORY, publishedAt: day(27) }),
      summary('b', { ...IN_CATEGORY, publishedAt: day(26) }),
      summary('c', { ...IN_CATEGORY, publishedAt: day(25) }),
      summary('d', { ...IN_CATEGORY, publishedAt: day(24) }),
    ])

    render(await renderPage(props('dat-van-de')))

    // No more per-category request: only the full cached list, paged 100 posts at a time
    // (fetchAllPublishedPosts), the same request that PostNav and "What to read next" use.
    expect(getPosts).toHaveBeenCalledWith({ page: 0, size: 100, language: 'vi' })
    expect(vi.mocked(getPosts).mock.calls.every(([params]) => !params.category)).toBe(true)
    expect(screen.getByRole('heading', { level: 2, name: msg('Site.related.title') })).toBeInTheDocument()
    const section = within(relatedSection())
    expect(section.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['a', 'b', 'c'])
    expect(section.queryByRole('heading', { level: 3, name: 'dat-van-de' })).not.toBeInTheDocument()
  })

  it('sorted by score: same category and shared tags first, then same category, then shared tags only', async () => {
    vi.mocked(getPost).mockResolvedValue(post)
    const other = { id: 'c2', name: 'Debugging', slug: 'go-loi', description: null }
    stubPublished([
      summary('chi-the', { category: other, tags: post.tags, publishedAt: day(27) }),
      summary('khong-chung-gi', { category: other, publishedAt: day(26) }),
      summary('chuyen-muc', { ...IN_CATEGORY, publishedAt: day(25) }),
      summary('chuyen-muc-va-the', { ...IN_CATEGORY, tags: post.tags, publishedAt: day(1) }),
    ])

    render(await renderPage(props('dat-van-de')))

    // A post in another category that shares a tag is now a related post: previously a post in a category with only
    // one post had no such block. A post sharing nothing does not enter, however new.
    expect(
      within(relatedSection())
        .getAllByRole('heading', { level: 3 })
        .map((h) => h.textContent),
    ).toEqual(['chuyen-muc-va-the', 'chuyen-muc', 'chi-the'])
  })

  it('shows nothing, not an empty heading, for a post with neither category nor tags', async () => {
    vi.mocked(getPost).mockResolvedValue({ ...post, category: null, tags: [] })
    stubPublished([
      summary('a', { category: { id: 'c2', name: 'Debugging', slug: 'go-loi', description: null } }),
      summary('b'),
      summary('c'),
    ])

    render(await renderPage(props('dat-van-de')))

    expect(screen.queryByRole('heading', { name: msg('Site.related.title') })).not.toBeInTheDocument()
    // And it did not fall back to "every post": with nothing to compare, a missing early return
    // would offer unrelated articles under a heading claiming they are related. The list above is
    // stocked precisely so that that version of the bug would be visible here — the titles are
    // 'a', 'b', 'c', none of which the article body contains. (PostNav still links its two
    // neighbours by date; that nav is not this section.)
    expect(screen.queryByRole('heading', { name: 'a' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: msg('Site.related.title') })).not.toBeInTheDocument()
  })

  it('shows nothing when no other post shares the category or a tag', async () => {
    vi.mocked(getPost).mockResolvedValue(post)
    stubPublished([summary('dat-van-de', IN_CATEGORY), summary('x'), summary('y')])

    render(await renderPage(props('dat-van-de')))

    expect(screen.queryByRole('heading', { name: msg('Site.related.title') })).not.toBeInTheDocument()
  })

  it('shows the one sibling there is rather than padding the row', async () => {
    vi.mocked(getPost).mockResolvedValue(post)
    stubPublished([summary('x'), summary('dat-van-de', IN_CATEGORY), summary('a', IN_CATEGORY), summary('y')])

    render(await renderPage(props('dat-van-de')))

    expect(screen.getByRole('heading', { level: 2, name: msg('Site.related.title') })).toBeInTheDocument()
    expect(
      within(relatedSection())
        .getAllByRole('heading', { level: 3 })
        .map((h) => h.textContent),
    ).toEqual(['a'])
  })
})

describe('PostPage previous and next', () => {
  it('links the older post as previous and the newer one as next', async () => {
    vi.mocked(getPost).mockResolvedValue(post)
    // Newest first, which is the order the API returns.
    stubPublished([summary('moi-hon'), summary('dat-van-de'), summary('cu-hon')])

    render(await renderPage(props('dat-van-de')))
    const nav = screen.getByRole('navigation', { name: msg('Site.postNav.navLabel') })

    expect(within(nav).getByRole('link', { name: `${msg('Site.postNav.previous')} cu-hon` })).toHaveAttribute(
      'href',
      '/posts/cu-hon',
    )
    expect(within(nav).getByRole('link', { name: `${msg('Site.postNav.next')} moi-hon` })).toHaveAttribute(
      'href',
      '/posts/moi-hon',
    )
  })

  it('renders only the next link for the oldest post', async () => {
    vi.mocked(getPost).mockResolvedValue(post)
    // 'dat-van-de' LAST in a newest-first list: the first post ever published.
    stubPublished([summary('moi-hon'), summary('dat-van-de')])

    render(await renderPage(props('dat-van-de')))
    const nav = screen.getByRole('navigation', { name: msg('Site.postNav.navLabel') })

    expect(within(nav).getAllByRole('link')).toHaveLength(1)
    expect(within(nav).getByRole('link', { name: `${msg('Site.postNav.next')} moi-hon` })).toBeInTheDocument()
    expect(within(nav).queryByText(msg('Site.postNav.previous'))).not.toBeInTheDocument()
  })

  it('renders only the previous link for the most recent post', async () => {
    vi.mocked(getPost).mockResolvedValue(post)
    // 'dat-van-de' FIRST: nothing newer exists, so `items[-1]` must be nothing rather
    // than wrapping around to the end of the array.
    stubPublished([summary('dat-van-de'), summary('cu-hon')])

    render(await renderPage(props('dat-van-de')))
    const nav = screen.getByRole('navigation', { name: msg('Site.postNav.navLabel') })

    expect(within(nav).getAllByRole('link')).toHaveLength(1)
    expect(within(nav).getByRole('link', { name: `${msg('Site.postNav.previous')} cu-hon` })).toBeInTheDocument()
    expect(within(nav).queryByText(msg('Site.postNav.next'))).not.toBeInTheDocument()
  })

  it('renders no navigation at all for the only post on the blog', async () => {
    vi.mocked(getPost).mockResolvedValue(post)
    stubPublished([summary('dat-van-de')])

    render(await renderPage(props('dat-van-de')))

    expect(screen.queryByRole('navigation', { name: msg('Site.postNav.navLabel') })).not.toBeInTheDocument()
  })

  it('still renders the article when the listing endpoint is down', async () => {
    vi.mocked(getPost).mockResolvedValue(post)
    vi.mocked(getPosts).mockRejectedValue(new ApiError(503, 'UPSTREAM', 'database is down'))

    // getPost has already succeeded: the reader has the article. A 503 from the
    // LISTING endpoint must not replace a page that rendered fine with an error page,
    // which is exactly what `Promise.all` would do if either helper let its rejection
    // escape.
    render(await renderPage(props('dat-van-de')))

    expect(screen.getByRole('heading', { level: 1, name: 'Performance problem statement' })).toBeInTheDocument()
    expect(screen.getByText('One paragraph.')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: msg('Site.related.title') })).not.toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: msg('Site.postNav.navLabel') })).not.toBeInTheDocument()
  })
})

/*
 * The post page after the mapping work: breadcrumb, dek, views, cover image or cover art,
 * series block, share row, author box, beacon, series-based PostNav, "What to read next".
 */

const SERIES_SLUG = 'series-b'
const SERIES_TITLE = 'Series B'

/** One part of a series; the title does not contain the word "Part" so that the label assertion is not green because of the title. */
const seriesPart = (n: number, count: number): PostSummary =>
  summary(`phan-${n}`, {
    title: `Part title ${n}`,
    series: { id: 's1', slug: SERIES_SLUG, title: SERIES_TITLE, position: n, partNumber: n, partCount: count },
  })

/** The post being read is part 2 of 3 of the series. */
const inSeries: ArticlePost = {
  ...post,
  slug: 'phan-2',
  series: { id: 's1', slug: SERIES_SLUG, title: SERIES_TITLE, position: 2, partNumber: 2, partCount: 3 },
}

const SERIES: SeriesDetail = {
  id: 's1',
  title: SERIES_TITLE,
  slug: SERIES_SLUG,
  description: null,
  posts: [seriesPart(1, 3), { ...seriesPart(2, 3), title: inSeries.title }, seriesPart(3, 3)],
}

describe('PostPage layout', () => {
  const following = (a: Element, b: Element) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING

  /** Every element must follow the one before it, and (when `scope` is given) sit inside `scope`. */
  function expectSequence(sequence: [string, Element | null][], scope?: Element, scopeName = 'its block') {
    for (const [name, element] of sequence) {
      expect(element, `${name} must be on the page`).not.toBeNull()
      if (scope) expect(scope.contains(element), `${name} must be inside ${scopeName}`).toBe(true)
    }
    for (let i = 1; i < sequence.length; i++) {
      const [prevName, prev] = sequence[i - 1]
      const [name, element] = sequence[i]
      expect(following(prev!, element!), `${name} must come after ${prevName}`).toBeTruthy()
    }
  }

  // Pinned again on purpose: the series list is in the left rail (outside the article), and the reading rail (TOC, like,
  // bookmark, share row) is now the LAST child of the article (spec v2 2.5): JSON-LD, hero, body column, reading rail.
  it('exact order inside <article>: JSON-LD, hero (breadcrumb, meta, h1, dek, tags, author row), cover, inline table of contents, body, reading rail', async () => {
    vi.mocked(getPost).mockResolvedValue(inSeries)
    vi.mocked(getSeries).mockResolvedValue(SERIES)

    const { container } = render(await renderPage(props('phan-2')))
    const article = container.querySelector('article')!
    const scripts = article.querySelectorAll('script[type="application/ld+json"]')

    const hero = article.querySelector<HTMLElement>('[data-reader-hero]')!
    const column = article.querySelector<HTMLElement>('[data-reader-body]')!
    const sequence: [string, Element | null][] = [
      ['BlogPosting', scripts[0] ?? null],
      ['BreadcrumbList', scripts[1] ?? null],
      ['hero', hero],
      ['breadcrumb', article.querySelector(`nav[aria-label="${msg('Site.breadcrumb.label')}"]`)],
      ['meta', article.querySelector('time')],
      ['h1', article.querySelector('h1')],
      ['dek', screen.getByText('A short write-up.')],
      ['tags', article.querySelector(`ul[aria-label="${msg('Site.article.tagsLabel')}"]`)],
      ['author row', hero.querySelector('a[href="/newsletter"]')],
      ['body column', column],
      ['cover art', article.querySelector('svg.cover-art')],
      ['inline table of contents', inlineToc()],
      ['body', article.querySelector('div.prose')],
      ['reading rail', railAside()],
    ]

    expectSequence(sequence, article, '<article>')
    expect(JSON.parse(scripts[0].textContent ?? '')).toMatchObject({ '@type': 'BlogPosting' })
    expect(JSON.parse(scripts[1].textContent ?? '')).toMatchObject({ '@type': 'BreadcrumbList' })
    // The article's children, in order: the structured data (script elements), the hero, the body column, the reading rail.
    expect([...article.children].map((child) => child.tagName)).toEqual(['SCRIPT', 'SCRIPT', 'HEADER', 'DIV', 'ASIDE'])
    expect(article.lastElementChild).toBe(railAside())
    // The cover is the first thing of the body column, not of the hero (the hero ends with the author row).
    expect(hero.contains(article.querySelector('svg.cover-art'))).toBe(false)
    expect(column.contains(article.querySelector('svg.cover-art'))).toBe(true)
    // Inverted from the old contract: like, bookmark, share and the rail table of contents ARE inside the article now.
    expect(article.contains(railToc())).toBe(true)
    for (const selector of ['#luot-thich', '#luu-bai']) {
      expect(article.querySelector(selector), `${selector} must be inside <article> (the reading rail)`).not.toBeNull()
      expect(column.querySelector(selector), `${selector} must not be inside the body column`).toBeNull()
    }
    expect(within(article).getByRole('list', { name: msg('Site.share.label') })).toBeInTheDocument()
    // What is still outside the article: the series list (left rail) and the author box (end blocks).
    expect(article.querySelector('nav[aria-labelledby^="series-cua-bai"]')).toBeNull()
    expect(screen.queryAllByRole('navigation', { name: SERIES_TITLE }).filter((nav) => article.contains(nav))).toHaveLength(0)
    expect(article.querySelector('#tac-gia'), '#tac-gia must not be inside <article>').toBeNull()
    expect(article.contains(screen.getByRole('complementary', { name: PROFILE_NAME }))).toBe(false)
  })

  it('exact page order: skip links, left rail, article (reading rail inside it, last), then the end blocks: PostNav, author, comments, related', async () => {
    vi.mocked(getPost).mockResolvedValue(inSeries)
    vi.mocked(getSeries).mockResolvedValue(SERIES)
    // A related post (same category) so that the related block exists; the others only feed the neighbours of PostNav.
    stubPublished([summary('moi-hon'), summary('phan-2'), summary('cu-hon'), summary('a', IN_CATEGORY)])

    const { container } = render(await renderPage(props('phan-2')))
    const article = container.querySelector('article')!
    const grid = article.parentElement!
    const postNav = screen.getByRole('navigation', { name: msg('Site.postNav.navLabel') })
    const endSlot = postNav.parentElement!

    const sequence: [string, Element | null][] = [
      ['skip link', screen.getByRole('link', { name: msg('Site.reader.skipToArticle') })],
      ['skip link to the text', screen.getByRole('link', { name: msg('Site.reader.skipToBody') })],
      ['left rail', leftAside()],
      ['article', article],
      ['reading rail', railAside()],
      ['PostNav', postNav],
      ['author box', screen.getByRole('complementary', { name: PROFILE_NAME })],
      ['comments', screen.getByRole('region', { name: msg('Site.comments.heading') })],
      ['related posts', screen.getByRole('region', { name: msg('Site.related.title') })],
    ]
    expectSequence(sequence)

    // Every block is a direct child of the grid, or of the one end slot that holds the four end blocks. The reading rail is
    // not a grid child: it is the last child of the article.
    expect([...grid.children].map((child) => child.tagName)).toEqual(['A', 'A', 'ASIDE', 'ARTICLE', 'DIV'])
    expect(grid.children[2]).toBe(leftAside())
    expect(grid.children[3]).toBe(article)
    expect(article.lastElementChild).toBe(railAside())
    expect(grid.children[4]).toBe(endSlot)
    expect(endSlot.className.split(/\s+/)).toEqual(expect.arrayContaining(END_SLOT.split(/\s+/)))
    for (const [name, element] of sequence.slice(5)) expect(endSlot.contains(element), `${name} is in the end slot`).toBe(true)
    // The author box prints with the post: the end slot is not hidden on paper (see the print contract above).
    expect(endSlot.className).not.toContain('print:hidden')

    // The reading rail: rail table of contents, then like, bookmark and share (in that order), all inside the article's last child.
    expectSequence(
      [
        ['rail table of contents', railToc()],
        ['like', railAside().querySelector('#luot-thich')],
        ['bookmark', railAside().querySelector('#luu-bai')],
        ['share', railShareLink('Facebook')],
      ],
      railAside(),
      'the reading rail',
    )
    // The left rail holds the series list.
    expect(within(leftDesktop()).getByRole('navigation', { name: SERIES_TITLE })).toBeInTheDocument()
  })

  it('no excerpt means no dek', async () => {
    vi.mocked(getPost).mockResolvedValue({ ...post, excerpt: null })

    const { container } = render(await renderPage(props('dat-van-de')))
    const h1 = container.querySelector('article h1')!

    // The element right after the h1 is the tag list (then the author row), not an empty <p> holding a margin; the meta row is
    // BEFORE the h1 now (the hero's order is breadcrumb, meta row, h1, dek, tags, author row).
    expect(h1.nextElementSibling?.tagName).not.toBe('P')
    expect(h1.nextElementSibling?.querySelector(`ul[aria-label="${msg('Site.article.tagsLabel')}"]`)).not.toBeNull()
    expect(h1.previousElementSibling?.querySelector('time')).not.toBeNull()
    // The hero has one child fewer (breadcrumb, meta row, h1, tags, author row) and none of them is a paragraph.
    const hero = container.querySelector('[data-reader-hero]')!
    expect(hero.children).toHaveLength(5)
    expect([...hero.children].some((child) => child.tagName === 'P')).toBe(false)
  })

  it('hero child order: breadcrumb, meta row, h1, dek, tags, author row (and the row has the actions after the author)', async () => {
    vi.mocked(getPost).mockResolvedValue(post)

    const { container } = render(await renderPage(props('dat-van-de')))
    const hero = container.querySelector<HTMLElement>('article > [data-reader-hero]')!

    expect(hero.tagName).toBe('HEADER')
    expect(hero.className.split(/\s+/)).toEqual(expect.arrayContaining(HERO_SLOT.split(/\s+/)))
    const children = [...hero.children]
    expect(children).toHaveLength(6)
    const [breadcrumb, meta, h1, dek, tags, authorRow] = children as HTMLElement[]
    expect(breadcrumb!.querySelector(`nav[aria-label="${msg('Site.breadcrumb.label')}"]`)).not.toBeNull()
    expect(meta!.querySelector('time')).not.toBeNull()
    expect(h1!.tagName).toBe('H1')
    expect(dek!.tagName).toBe('P')
    expect(dek).toHaveTextContent('A short write-up.')
    expect(tags!.querySelector(`ul[aria-label="${msg('Site.article.tagsLabel')}"]`)).not.toBeNull()
    // The author row: name, Subscribe, then the print-hidden action group (Copy link, Share, no Next here: no neighbours).
    const name = authorRow!.querySelector('a[href="/about"]')!
    const subscribe = authorRow!.querySelector('a[href="/newsletter"]')!
    const actions = within(authorRow!).getByRole('group', { name: msg('Site.reader.actionsLabel') })
    expect(name.compareDocumentPosition(subscribe) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(subscribe.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

/*
 * The hero block as the page assembles it (spec v2 3): who the author is, which series badge, where "Next" leads, what is
 * printed. The markup of each part is ArticleHero.test.tsx's job; here is what the PAGE feeds it.
 */
describe('PostPage hero', () => {
  const GITHUB_AVATAR = 'https://avatars.githubusercontent.com/u/12345?v=4'
  const heroOf = (container: HTMLElement) => container.querySelector<HTMLElement>('article > [data-reader-hero]')!
  const actionsOf = (container: HTMLElement) =>
    within(heroOf(container)).queryByRole('group', { name: msg('Site.reader.actionsLabel') })
  /** The links of the action group that lead to a post of this site (the share links of the menu are external). */
  const postLinksOf = (container: HTMLElement) =>
    [...(actionsOf(container)?.querySelectorAll('a[href^="/posts/"]') ?? [])].map((link) => link.getAttribute('href'))
  const lastPart: ArticlePost = {
    ...inSeries,
    slug: 'phan-3',
    series: { id: 's1', slug: SERIES_SLUG, title: SERIES_TITLE, position: 3, partNumber: 3, partCount: 3 },
  }

  it('the site owner with a profile picture: a 32px image, the profile name linking to /about', async () => {
    const content = defaultSiteContent(TEST_LOCALE)
    vi.mocked(getSiteContent).mockResolvedValue({ ...content, profile: { ...content.profile, avatar: '/media/owner.png' } })
    vi.mocked(getPost).mockResolvedValue(post)

    const { container } = render(await renderPage(props('dat-van-de')))
    const hero = heroOf(container)

    const image = hero.querySelector('img')!
    expect(image).toHaveAttribute('alt', '')
    expect(image.getAttribute('src')).toContain('owner.png')
    expect(image).toHaveAttribute('width', '32')
    const name = within(hero).getByRole('link', { name: PROFILE_NAME })
    expect(name).toHaveAttribute('href', '/about')
    // The picture comes first in the row, the name after it.
    expect(name.compareDocumentPosition(image) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
    // The author box at the end is still the one complementary of that name.
    expect(screen.getAllByRole('complementary', { name: PROFILE_NAME })).toHaveLength(1)
  })

  it('the site owner with no picture at all: the name alone, no image and no initial-letter circle', async () => {
    vi.mocked(getPost).mockResolvedValue(post)

    const { container } = render(await renderPage(props('dat-van-de')))
    const hero = heroOf(container)
    const name = within(hero).getByRole('link', { name: PROFILE_NAME })

    expect(hero.querySelector('img')).toBeNull()
    expect(name).toHaveAttribute('href', '/about')
    // Nothing in the row stands in for a face: the name is the first thing of the left cluster.
    const cluster = name.closest('div')!
    expect(cluster.firstElementChild!.contains(name)).toBe(true)
  })

  it('the site owner with only a GitHub picture on the author record: that picture, through Avatar', async () => {
    const author = {
      displayName: 'Whatever',
      githubLogin: 'owner',
      avatarUrl: GITHUB_AVATAR,
      siteOwner: true,
      profileSlug: 'owner',
    }
    vi.mocked(getPost).mockResolvedValue({ ...post, author })

    const { container } = render(await renderPage(props('dat-van-de')))
    const hero = heroOf(container)

    expect(hero.querySelector('img')!.getAttribute('src')).toContain('avatars.githubusercontent.com/u/12345')
    // The owner is shown by the site profile name, not by the display name of the account.
    expect(within(hero).getByRole('link', { name: PROFILE_NAME })).toHaveAttribute('href', '/about')
    expect(within(hero).queryByText('Whatever')).toBeNull()
  })

  it('another author: their name linking to /u/<slug>, their GitHub picture, and not the site owner', async () => {
    const author = {
      displayName: 'Alice Johnson',
      githubLogin: 'alicejohnson',
      avatarUrl: GITHUB_AVATAR,
      siteOwner: false,
      profileSlug: 'alice',
    }
    vi.mocked(getPost).mockResolvedValue({ ...post, author })

    const { container } = render(await renderPage(props('dat-van-de')))
    const hero = heroOf(container)

    expect(within(hero).getByRole('link', { name: 'Alice Johnson' })).toHaveAttribute('href', '/u/alice')
    expect(hero.querySelector('img')!.getAttribute('src')).toContain('avatars.githubusercontent.com/u/12345')
    expect(within(hero).queryByText(PROFILE_NAME)).toBeNull()
    expect(hero.querySelector('a[href="/about"]')).toBeNull()
  })

  it('another author with no profile slug and no picture: a plain-text name and an initial-letter circle, no link', async () => {
    const author = { displayName: 'Bob Stone', githubLogin: null, avatarUrl: null, siteOwner: false, profileSlug: null }
    vi.mocked(getPost).mockResolvedValue({ ...post, author })

    const { container } = render(await renderPage(props('dat-van-de')))
    const hero = heroOf(container)

    expect(within(hero).getByText('Bob Stone')).toBeInTheDocument()
    expect(within(hero).queryByRole('link', { name: 'Bob Stone' })).toBeNull()
    expect(hero.querySelector('img')).toBeNull()
    expect(within(hero).getByText('B')).toHaveAttribute('aria-hidden', 'true')
  })

  it('Subscribe is a link to /newsletter in the author row, print:hidden, and stays for a draft preview', async () => {
    vi.mocked(getPost).mockResolvedValue(post)

    const { container, unmount } = render(await renderPage(props('dat-van-de')))
    const subscribe = within(heroOf(container)).getByRole('link', { name: msg('Site.reader.subscribe') })
    expect(subscribe).toHaveAttribute('href', '/newsletter')
    expect(subscribe.className).toContain('print:hidden')
    unmount()

    vi.mocked(getPost).mockResolvedValue({ ...post, status: 'DRAFT' })
    const draft = render(await renderPage(props('dat-van-de')))
    expect(within(heroOf(draft.container)).getByRole('link', { name: msg('Site.reader.subscribe') })).toHaveAttribute(
      'href',
      '/newsletter',
    )
    // A draft has nothing public to copy, share or go to: no action group at all.
    expect(actionsOf(draft.container)).toBeNull()
    expect(within(heroOf(draft.container)).queryByRole('button', { name: msg('Site.share.copyLink') })).toBeNull()
  })

  it('Copy link: exactly one on the page, in the hero, before the post body', async () => {
    vi.mocked(getPost).mockResolvedValue(post)

    const { container } = render(await renderPage(props('dat-van-de')))
    const buttons = screen.getAllByRole('button', { name: msg('Site.share.copyLink') })

    expect(buttons).toHaveLength(1)
    expect(heroOf(container).contains(buttons[0]!)).toBe(true)
    expect(actionsOf(container)!.contains(buttons[0]!)).toBe(true)
    const body = container.querySelector('article div.prose')!
    expect(body.compareDocumentPosition(buttons[0]!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
  })

  it('a post in a series: the badge "02 / 03" with its text twin, and the series title linking to the series', async () => {
    vi.mocked(getPost).mockResolvedValue(inSeries)
    vi.mocked(getSeries).mockResolvedValue(SERIES)

    const { container } = render(await renderPage(props('phan-2')))
    const hero = heroOf(container)

    const badge = within(hero).getByText('02 / 03')
    expect(badge).toHaveAttribute('aria-hidden', 'true')
    expect(badge.parentElement).toHaveTextContent(msg('Site.reader.partBadge', { current: 2, total: 3 }))
    const title = within(hero).getByRole('link', { name: SERIES_TITLE })
    expect(title).toHaveAttribute('href', `/series/${SERIES_SLUG}`)
    // The badge and the series are in the meta line, before the h1.
    const meta = hero.querySelector('h1')!.previousElementSibling!
    expect(meta.contains(badge)).toBe(true)
    expect(meta.contains(title)).toBe(true)
  })

  it('a series that could not be loaded: the series title from the post itself, and no badge', async () => {
    vi.mocked(getPost).mockResolvedValue(inSeries)
    vi.mocked(getSeries).mockRejectedValue(new ApiError(503, 'UPSTREAM', 'database is down'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    let hero: HTMLElement
    try {
      hero = heroOf(render(await renderPage(props('phan-2'))).container)
    } finally {
      warn.mockRestore()
    }

    expect(within(hero).getByRole('link', { name: SERIES_TITLE })).toHaveAttribute('href', `/series/${SERIES_SLUG}`)
    expect(hero.textContent).not.toMatch(/\d\d \/ \d\d/)
    expect(within(hero).queryByText(msg('Site.reader.partBadge', { current: 2, total: 3 }))).toBeNull()
  })

  it('a post in no series: no badge, no series title, no series link in the hero', async () => {
    vi.mocked(getPost).mockResolvedValue(post)

    const { container } = render(await renderPage(props('dat-van-de')))
    const hero = heroOf(container)

    expect(hero.textContent).not.toMatch(/\d\d \/ \d\d/)
    expect(hero.querySelector('a[href^="/series/"]')).toBeNull()
  })

  it('Next in a series leads to the next PART (not the newer post), labelled "Next part", with the title for a screen reader', async () => {
    vi.mocked(getPost).mockResolvedValue(inSeries)
    vi.mocked(getSeries).mockResolvedValue(SERIES)
    stubPublished([summary('moi-hon'), summary('phan-2'), summary('cu-hon')])

    const { container } = render(await renderPage(props('phan-2')))

    expect(postLinksOf(container)).toEqual(['/posts/phan-3'])
    const next = actionsOf(container)!.querySelector('a[href="/posts/phan-3"]')!
    expect(next.textContent).toContain(msg('Site.reader.nextPart'))
    expect(next.querySelector('.sr-only')!.textContent).toContain('Part title 3')
    // Last of the three controls: Copy link, Share, Next.
    expect(actionsOf(container)!.lastElementChild).toBe(next)
  })

  it('Next at the LAST part of a series is hidden: it does not fall back to a newer post', async () => {
    vi.mocked(getPost).mockResolvedValue(lastPart)
    vi.mocked(getSeries).mockResolvedValue(SERIES)
    // A newer post exists: a fallback by time would show it.
    stubPublished([summary('moi-hon'), summary('phan-3'), summary('cu-hon')])

    const { container } = render(await renderPage(props('phan-3')))

    expect(actionsOf(container)).not.toBeNull()
    expect(postLinksOf(container)).toEqual([])
    // Copy link and Share are still there.
    expect(within(actionsOf(container)!).getByRole('button', { name: msg('Site.share.copyLink') })).toBeInTheDocument()
  })

  it('Next for a post outside a series leads to the next (newer) post, labelled "Next post"', async () => {
    vi.mocked(getPost).mockResolvedValue(post)
    stubPublished([summary('moi-hon'), summary('dat-van-de'), summary('cu-hon')])

    const { container } = render(await renderPage(props('dat-van-de')))

    expect(postLinksOf(container)).toEqual(['/posts/moi-hon'])
    expect(actionsOf(container)!.querySelector('a[href="/posts/moi-hon"]')!.textContent).toContain(msg('Site.postNav.next'))
  })

  it('Next is hidden at the newest post of the blog', async () => {
    vi.mocked(getPost).mockResolvedValue(post)
    stubPublished([summary('dat-van-de'), summary('cu-hon')])

    const { container } = render(await renderPage(props('dat-van-de')))

    expect(postLinksOf(container)).toEqual([])
    expect(within(actionsOf(container)!).getByRole('button', { name: msg('Site.share.copyLink') })).toBeInTheDocument()
  })

  it('the body column takes programmatic focus for the second skip link: id post-body, tabindex -1', async () => {
    vi.mocked(getPost).mockResolvedValue(post)

    const { container } = render(await renderPage(props('dat-van-de')))
    const column = container.querySelector('#post-body')!

    expect(container.querySelectorAll('#post-body')).toHaveLength(1)
    expect(column).toHaveAttribute('tabindex', '-1')
    expect(column).toHaveAttribute('data-reader-body')
    expect(column.querySelector('[data-post-body]')).not.toBeNull()
    expect(heroOf(container).contains(column)).toBe(false)
  })
})

describe('PostPage breadcrumb', () => {
  it('the category has only one link on the page, and it is inside the breadcrumb', async () => {
    vi.mocked(getPost).mockResolvedValue(post)
    // Posts of the same category, so that the left rail has a category group: its title names the category as plain text.
    stubPublished([summary('a', { ...IN_CATEGORY, publishedAt: day(20) }), summary('dat-van-de', IN_CATEGORY)])

    const { container } = render(await renderPage(props('dat-van-de')))
    const nav = screen.getByRole('navigation', { name: msg('Site.breadcrumb.label') })

    // The category left the meta row for the breadcrumb: two links to the same category on one
    // page are two keyboard stops for one destination.
    expect(container.querySelectorAll('a[href="/categories/cong-nghe"]')).toHaveLength(1)
    // Positive control: the rail does show the category (in both copies), as a title and not as a link.
    const title = msg('Site.reader.categoryTitle', { category: 'Technology' })
    expect(within(leftDesktop()).getByText(title)).toBeInTheDocument()
    // (twice in the mobile copy: the summary row says it too)
    expect(within(leftMobile()).getAllByText(title)).toHaveLength(2)
    expect(within(leftAside()).queryAllByRole('link', { name: 'Technology' })).toHaveLength(0)
    expect(nav.contains(container.querySelector('a[href="/categories/cong-nghe"]'))).toBe(true)
    expect(within(nav).getByRole('link', { name: 'Technology' })).toHaveAttribute('href', '/categories/cong-nghe')
    expect(within(nav).getByRole('link', { name: msg('Site.footer.links.writing') })).toHaveAttribute('href', '/writing')
  })

  it('BreadcrumbList matches the visible breadcrumb, then adds the post itself at the end', async () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://example.com')
    vi.mocked(getPost).mockResolvedValue(post)

    try {
      const { container } = render(await renderPage(props('dat-van-de')))
      const script = [...container.querySelectorAll('script[type="application/ld+json"]')]
        .map((s) => JSON.parse(s.textContent ?? ''))
        .find((data) => data['@type'] === 'BreadcrumbList')

      expect(script?.itemListElement).toEqual([
        { '@type': 'ListItem', position: 1, name: msg('Site.footer.links.writing'), item: 'https://example.com/writing' },
        { '@type': 'ListItem', position: 2, name: 'Technology', item: 'https://example.com/categories/cong-nghe' },
        { '@type': 'ListItem', position: 3, name: post.title, item: 'https://example.com/posts/dat-van-de' },
      ])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('under /en the trail is at /en URLs and the post itself stays at its original URL, like its canonical', async () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://example.com')
    vi.mocked(getPost).mockResolvedValue(post)

    try {
      const { container } = render(
        await renderPage({ ...props('dat-van-de'), params: Promise.resolve({ locale: 'en', slug: 'dat-van-de' }) }),
      )
      const script = [...container.querySelectorAll('script[type="application/ld+json"]')]
        .map((s) => JSON.parse(s.textContent ?? ''))
        .find((data) => data['@type'] === 'BreadcrumbList')

      expect(script?.itemListElement.map((entry: { item: string }) => entry.item)).toEqual([
        'https://example.com/en/writing',
        'https://example.com/en/categories/cong-nghe',
        'https://example.com/posts/dat-van-de',
      ])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('an unpublished post has no structured data at all, not even BreadcrumbList', async () => {
    vi.mocked(getPost).mockResolvedValue({ ...post, status: 'DRAFT' })

    const { container } = render(await renderPage(props('dat-van-de')))

    expect(container.querySelectorAll('script[type="application/ld+json"]')).toHaveLength(0)
    // The visible breadcrumb is still there: it is navigation, not a claim made to crawlers.
    expect(screen.getByRole('navigation', { name: msg('Site.breadcrumb.label') })).toBeInTheDocument()
  })
})

describe('PostPage views', () => {
  it('from 10 views: "[Eye] N views" in vi-VN format, in the same row as the date', async () => {
    vi.mocked(getPost).mockResolvedValue({ ...post, viewCount: 2517 })

    const { container } = render(await renderPage(props('dat-van-de')))

    const views = screen.getByText(msg('Site.article.views', { count: '2.517', n: 2517 }))
    expect(views.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    // The same meta row as the date: the row right BEFORE the h1 in the hero.
    const row = container.querySelector('article h1')!.previousElementSibling!
    expect(row.contains(views)).toBe(true)
    expect(row.querySelector('time')).not.toBeNull()
  })

  it('threshold is 10: 10 shows, 9 does not, a missing field does not', async () => {
    vi.mocked(getPost).mockResolvedValue({ ...post, viewCount: 10 })
    const first = render(await renderPage(props('dat-van-de')))
    expect(screen.getByText(msg('Site.article.views', { count: '10', n: 10 }))).toBeInTheDocument()
    first.unmount()

    vi.mocked(getPost).mockResolvedValue({ ...post, viewCount: 9 })
    const second = render(await renderPage(props('dat-van-de')))
    expect(screen.queryByText(VIEWS_UNIT)).not.toBeInTheDocument()
    // The meta row still has the date: the views are absent not because the meta row vanished.
    expect(second.container.querySelector('article time')).not.toBeNull()
    second.unmount()

    vi.mocked(getPost).mockResolvedValue({ ...post, viewCount: undefined })
    render(await renderPage(props('dat-van-de')))
    expect(screen.queryByText(VIEWS_UNIT)).not.toBeInTheDocument()
  })
})

describe('PostPage lead image', () => {
  it('with a cover image: <img> through /media/ with fetchpriority="high", no cover art', async () => {
    vi.mocked(getPost).mockResolvedValue({ ...post, cover: COVER })

    const { container } = render(await renderPage(props('dat-van-de')))
    const img = container.querySelector('article img')

    expect(img).not.toBeNull()
    expect(img).toHaveAttribute('fetchpriority', 'high')
    expect(img).toHaveAttribute('alt', COVER.altText)
    expect(new URL(img!.getAttribute('src') ?? '', 'http://localhost').searchParams.get('url')).toBe(`/media/${COVER.fileName}`)
    expect(container.querySelector('article svg.cover-art')).toBeNull()
  })

  it('without a cover image: the post cover art in the hero frame, and no <img> at all', async () => {
    vi.mocked(getPost).mockResolvedValue(post)

    const { container } = render(await renderPage(props('dat-van-de')))
    const art = container.querySelector('article svg.cover-art')

    expect(art).not.toBeNull()
    expect(art?.parentElement?.className).toContain('aspect-[2/1]')
    expect(container.querySelector('img')).toBeNull()
  })
})

describe('PostPage series', () => {
  it('post in a series: series list in the left rail with the part being read, series-based PostNav', async () => {
    vi.mocked(getPost).mockResolvedValue(inSeries)
    vi.mocked(getSeries).mockResolvedValue(SERIES)
    // The chronological neighbors are entirely different from the series neighbors, so we can see which side PostNav picks.
    stubPublished([summary('moi-hon'), summary('phan-2'), summary('cu-hon')])

    const { container } = render(await renderPage(props('phan-2')))

    expect(getSeries).toHaveBeenCalledWith(SERIES_SLUG, 'vi')
    // The series list is no longer inside the article: it is in the left rail, which has two copies in jsdom (the closed
    // <details> below lg and the sticky block from lg), each queried in its own scope.
    expect(screen.getAllByRole('navigation', { name: SERIES_TITLE })).toHaveLength(2)
    const block = within(leftDesktop()).getByRole('navigation', { name: SERIES_TITLE })
    expect(container.querySelector('article')!.contains(block)).toBe(false)
    // The eyebrow "Series · Part 2/3" is the group's label, right above the nav (outside it); the nav is named by the series title.
    expect(within(leftDesktop()).getByText(msg('Site.seriesBlock.partOf', { current: 2, total: 3 }))).toBeInTheDocument()
    // The group is a collapsible <details open> INSIDE the nav (the landmark survives collapsing), with a numbered list.
    const details = block.querySelector('details')!
    expect(details).toHaveAttribute('open')
    expect(details.querySelector('summary')!.id).toBe('series-cua-bai')
    expect([...block.querySelectorAll('ol > li [data-part-number]')].map((number) => number.textContent)).toEqual(['1', '2', '3'])
    const current = block.querySelector('li[aria-current="true"]')!
    expect(current.textContent).toContain(msg('Site.seriesBlock.currentPart'))
    // The part being read is plain text, not a link; the other two parts link to their posts (by position in the series).
    expect(within(current as HTMLElement).queryByRole('link')).toBeNull()
    expect(
      within(block)
        .getAllByRole('link')
        .map((link) => link.getAttribute('href')),
    ).toEqual([`/series/${SERIES_SLUG}`, '/posts/phan-1', '/posts/phan-3'])
    // The same list, folded, in the mobile copy: a closed <details>, ids kept unique by the `-m` suffix.
    expect(leftMobile().hasAttribute('open')).toBe(false)
    expect(within(leftMobile()).getByRole('navigation', { name: SERIES_TITLE })).toHaveAttribute(
      'aria-labelledby',
      'series-cua-bai-m',
    )
    expect(block).toHaveAttribute('aria-labelledby', 'series-cua-bai')
    expect(container.querySelectorAll('[id="series-cua-bai"]')).toHaveLength(1)
    expect(container.querySelectorAll('[id="series-cua-bai-m"]')).toHaveLength(1)

    const postNav = screen.getByRole('navigation', { name: msg('Site.postNav.navLabel') })
    expect(
      within(postNav).getByRole('link', { name: msg('Site.postNav.previousPart', { title: `${SERIES_TITLE} Part title 1` }) }),
    ).toHaveAttribute('href', '/posts/phan-1')
    expect(
      within(postNav).getByRole('link', { name: msg('Site.postNav.nextPart', { title: `${SERIES_TITLE} Part title 3` }) }),
    ).toHaveAttribute('href', '/posts/phan-3')
    expect(within(postNav).queryByRole('link', { name: /moi-hon|cu-hon/ })).not.toBeInTheDocument()
  })

  it('post not in a series: no series API call, no series block', async () => {
    vi.mocked(getPost).mockResolvedValue(post)

    const { container } = render(await renderPage(props('dat-van-de')))

    expect(getSeries).not.toHaveBeenCalled()
    expect(container.querySelector('[aria-current="true"]')).toBeNull()
    expect(container.querySelector('[id^="series-cua-bai"]')).toBeNull()
    expect(within(leftAside()).queryAllByRole('navigation')).toHaveLength(0)
    // Pair of the "yes" case: the table of contents is still there, in both variants; only the series block is absent.
    expect(tocNavs()).toHaveLength(2)
  })

  it('series API failure: the page still renders, no series block, PostNav falls back to chronological order', async () => {
    vi.mocked(getPost).mockResolvedValue(inSeries)
    vi.mocked(getSeries).mockRejectedValue(new ApiError(503, 'UPSTREAM', 'database is down'))
    stubPublished([summary('moi-hon'), summary('phan-2'), summary('cu-hon')])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    let warnings: unknown[][]
    try {
      render(await renderPage(props('phan-2')))
      warnings = [...warn.mock.calls]
    } finally {
      warn.mockRestore()
    }

    expect(screen.getByRole('heading', { level: 1, name: post.title })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: SERIES_TITLE })).not.toBeInTheDocument()
    const postNav = screen.getByRole('navigation', { name: msg('Site.postNav.navLabel') })
    expect(within(postNav).getByRole('link', { name: `${msg('Site.postNav.previous')} cu-hon` })).toBeInTheDocument()
    // The error is not swallowed silently: one log line says which block was hidden.
    expect(warnings.flat().join(' ')).toContain(SERIES_SLUG)
  })

  it('related posts skip the parts of the same series', async () => {
    vi.mocked(getPost).mockResolvedValue(inSeries)
    vi.mocked(getSeries).mockResolvedValue(SERIES)
    // The parts of the same series share the category AND tags with the post being read (highest score) and are newest:
    // they still do not enter, because the series block and PostNav right above already lead to them.
    stubPublished([
      { ...seriesPart(1, 3), ...IN_CATEGORY, tags: post.tags, publishedAt: day(28) },
      summary('a', { ...IN_CATEGORY, publishedAt: day(20) }),
      { ...seriesPart(3, 3), ...IN_CATEGORY, tags: post.tags, publishedAt: day(27) },
      summary('b', { ...IN_CATEGORY, publishedAt: day(10) }),
    ])

    render(await renderPage(props('phan-2')))

    const section = screen.getByRole('heading', { level: 2, name: msg('Site.related.title') }).closest('section')!
    expect(
      within(section)
        .getAllByRole('heading', { level: 3 })
        .map((h) => h.textContent),
    ).toEqual(['a', 'b'])
  })
})

/*
 * The left rail as the page assembles it: the model comes from `buildLeftRail` (lib/reader-rail.test.ts) and the markup from
 * LeftRail (reader/LeftRail.test.tsx); here only what the PAGE decides: which data the rail gets, that the failure of its
 * source costs only its contextual groups, and that the groups are scoped to the rail (a title can be a link 3-4 times).
 */
describe('PostPage left rail', () => {
  /** The five Explore links, in order: the four sections of /writing, then the best posts. */
  const EXPLORE_HREFS = ['/writing', '/series', '/topics', '/archive', '/start-here']
  const hrefsOf = (root: HTMLElement) =>
    within(root)
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'))

  /** Eight more posts of the category of `post`, dated 10-17 September (the number in the slug is the day). */
  const categoryPosts = () =>
    [10, 11, 12, 13, 14, 15, 16, 17].map((n) => summary(`c${n}`, { ...IN_CATEGORY, publishedAt: day(n) }))

  it('a categorised post: the newest posts of its category (current excluded, at most 6) and the archive month, after Explore', async () => {
    vi.mocked(getPost).mockResolvedValue(post)
    // Oldest first on purpose: the rail sorts by date, it does not trust the order of the API.
    stubPublished([...categoryPosts(), summary('dat-van-de', { ...IN_CATEGORY, publishedAt: post.publishedAt })])

    render(await renderPage(props('dat-van-de')))

    const title = msg('Site.reader.categoryTitle', { category: 'Technology' })
    const desktop = within(leftDesktop())
    const list = desktop.getByRole('list', { name: title })
    expect(
      within(list)
        .getAllByRole('link')
        .map((link) => link.getAttribute('href')),
    ).toEqual(['c17', 'c16', 'c15', 'c14', 'c13', 'c12'].map((slug) => `/posts/${slug}`))
    // No series, so no series nav; the category and Explore groups are lists, not landmarks: the rail adds no navigation.
    expect(desktop.queryAllByRole('navigation')).toHaveLength(0)
    expect(leftDesktop().querySelector('[id^="series-cua-bai"]')).toBeNull()
    // Explore first (spec v2 4.1), the contextual groups after it, and the month of the post (28 September 2026, UTC) last.
    expect(leftDesktop().querySelector('a[href="/archive#thang-2026-09"]')).not.toBeNull()
    expect(hrefsOf(leftDesktop()).slice(0, 5)).toEqual(EXPLORE_HREFS)
    expect(hrefsOf(leftDesktop()).at(-1)).toBe('/archive#thang-2026-09')
    // The mobile copy carries the same groups, folded: a closed <details> whose summary names the category.
    expect(leftMobile().hasAttribute('open')).toBe(false)
    expect(within(leftMobile()).getByRole('list', { name: title })).toBeInTheDocument()
    expect(leftMobile().querySelector('summary')?.textContent).toContain(title)
  })

  it('an uncategorised post with other posts on the blog: the latest posts, never the post being read', async () => {
    vi.mocked(getPost).mockResolvedValue({ ...post, category: null })
    stubPublished([
      summary('dat-van-de', { publishedAt: day(20) }),
      summary('x', { publishedAt: day(19) }),
      summary('y', { publishedAt: day(18) }),
    ])

    render(await renderPage(props('dat-van-de')))

    const list = within(leftDesktop()).getByRole('list', { name: msg('Site.reader.latestTitle') })
    expect(
      within(list)
        .getAllByRole('link')
        .map((link) => link.getAttribute('href')),
    ).toEqual(['/posts/x', '/posts/y'])
    expect(hrefsOf(leftDesktop()).slice(0, 5)).toEqual(EXPLORE_HREFS)
  })

  it('a post in a series with other posts of its category: the series list first, then the category group without the parts', async () => {
    vi.mocked(getPost).mockResolvedValue(inSeries)
    vi.mocked(getSeries).mockResolvedValue(SERIES)
    stubPublished([
      { ...seriesPart(1, 3), ...IN_CATEGORY, publishedAt: day(1) },
      { ...seriesPart(3, 3), ...IN_CATEGORY, publishedAt: day(3) },
      summary('c1', { ...IN_CATEGORY, publishedAt: day(5) }),
    ])

    render(await renderPage(props('phan-2')))

    const desktop = within(leftDesktop())
    const series = desktop.getByRole('navigation', { name: SERIES_TITLE })
    const category = desktop.getByRole('list', { name: msg('Site.reader.categoryTitle', { category: 'Technology' }) })
    expect(series.compareDocumentPosition(category) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The other parts are in the series list above: the category group lists only the post that is not a part.
    expect(
      within(category)
        .getAllByRole('link')
        .map((link) => link.getAttribute('href')),
    ).toEqual(['/posts/c1'])
  })

  it('the listing endpoint is down: the page still renders, the rail shows the Explore group alone and says why once', async () => {
    vi.mocked(getPost).mockResolvedValue(post)
    vi.mocked(getPosts).mockRejectedValue(new ApiError(503, 'UPSTREAM', 'database is down'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    let warnings: string
    try {
      render(await renderPage(props('dat-van-de')))
      warnings = warn.mock.calls.flat().join(' ')
    } finally {
      warn.mockRestore()
    }

    expect(screen.getByRole('heading', { level: 1, name: post.title })).toBeInTheDocument()
    // The rail is never an empty box: the five Explore links, no category or latest group, no month, no navigation.
    expect(hrefsOf(leftDesktop())).toEqual(EXPLORE_HREFS)
    expect(within(leftDesktop()).getByText(msg('Site.reader.exploreTitle'))).toBeInTheDocument()
    expect(within(leftDesktop()).queryByText(msg('Site.reader.latestTitle'))).not.toBeInTheDocument()
    expect(
      within(leftDesktop()).queryByText(msg('Site.reader.categoryTitle', { category: 'Technology' })),
    ).not.toBeInTheDocument()
    expect(within(leftDesktop()).queryAllByRole('navigation')).toHaveLength(0)
    expect(leftDesktop().querySelector('a[href^="/archive#"], a[href^="/archive?"]')).toBeNull()
    // The summary row of the mobile copy says "Explore" too.
    expect(leftMobile().querySelector('summary')?.textContent).toContain(msg('Site.reader.exploreTitle'))
    // One log line names the block that was hidden, so an API incident is not swallowed silently.
    expect(warnings).toContain('left rail')
  })

  it('the listing endpoint is down but the series loaded: the series group stays, the month link and the other groups go', async () => {
    vi.mocked(getPost).mockResolvedValue(inSeries)
    vi.mocked(getSeries).mockResolvedValue(SERIES)
    vi.mocked(getPosts).mockRejectedValue(new ApiError(503, 'UPSTREAM', 'database is down'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      render(await renderPage(props('phan-2')))
    } finally {
      warn.mockRestore()
    }

    expect(within(leftDesktop()).getByRole('navigation', { name: SERIES_TITLE })).toBeInTheDocument()
    expect(leftDesktop().querySelector('a[href^="/archive#"], a[href^="/archive?"]')).toBeNull()
    expect(hrefsOf(leftDesktop()).slice(0, 5)).toEqual(EXPLORE_HREFS)
  })

  it('the only post of the blog: the rail is the Explore group alone, with no empty list', async () => {
    vi.mocked(getPost).mockResolvedValue({ ...post, category: null })
    stubPublished([summary('dat-van-de', { publishedAt: post.publishedAt })])

    render(await renderPage(props('dat-van-de')))

    expect(hrefsOf(leftDesktop())).toEqual(
      // The post is its own month: the archive month link is the one extra link, after Explore.
      [...EXPLORE_HREFS, '/archive#thang-2026-09'],
    )
    expect(within(leftDesktop()).queryByRole('list', { name: msg('Site.reader.latestTitle') })).not.toBeInTheDocument()
  })

  it('asks for the posts of the language of the post, like the other blocks, through the shared listing', async () => {
    vi.mocked(getPost).mockResolvedValue(post)

    render(await renderPage(props('dat-van-de')))

    // The same request as PostNav, RelatedPosts and "What to read next": the rail adds no new endpoint.
    expect(getPosts).toHaveBeenCalledWith({ page: 0, size: 100, language: 'vi' })
    expect(vi.mocked(getPosts).mock.calls.every(([params]) => !params.category)).toBe(true)
  })

  it('an unpublished post still has the rail (it is not a claim to crawlers), but no reading actions', async () => {
    vi.mocked(getPost).mockResolvedValue({ ...post, status: 'DRAFT' })

    render(await renderPage(props('dat-van-de')))

    expect(hrefsOf(leftDesktop()).slice(0, 5)).toEqual(EXPLORE_HREFS)
    // The reading rail keeps the table of contents; like, bookmark and share are for published posts only.
    expect(railToc()).toBeInTheDocument()
    expect(railAside().querySelector('#luot-thich')).toBeNull()
    expect(within(railAside()).queryByRole('list', { name: msg('Site.share.label') })).toBeNull()
  })
})

describe('PostPage share, author, beacon', () => {
  it('share row builds the URL from the slug the backend stores', async () => {
    vi.mocked(getPost).mockResolvedValue({ ...post, slug: NFC_SLUG })

    render(await renderPage(props(NFD_SLUG)))

    // The hero's Share menu has the same three links (the same URLs), so the rail's one is asked for within the rail.
    const href = railShareLink('Facebook').getAttribute('href') ?? ''
    expect(new URL(href).searchParams.get('u')).toBe(`http://localhost:3000/posts/${encodeURIComponent(NFC_SLUG)}`)
    // The hero menu builds the identical URL.
    const heroHref =
      within(document.querySelector<HTMLElement>('[data-reader-hero]')!)
        .getByRole('link', { name: msg('Site.share.shareOn', { target: 'Facebook' }) })
        .getAttribute('href') ?? ''
    expect(heroHref).toBe(href)
  })

  it('author box at the end of the post (outside <article>, after the reading rail and PostNav), no avatar when there is no real photo', async () => {
    vi.mocked(getPost).mockResolvedValue(post)
    stubPublished([summary('moi-hon'), summary('dat-van-de'), summary('cu-hon')])

    const { container } = render(await renderPage(props('dat-van-de')))

    const aside = screen.getByRole('complementary', { name: PROFILE_NAME })
    const article = container.querySelector('article')!
    expect(article.contains(aside)).toBe(false)
    expect(aside).toHaveAttribute('aria-labelledby', 'tac-gia')
    expect(article.compareDocumentPosition(aside) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(railAside().compareDocumentPosition(aside) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const postNav = screen.getByRole('navigation', { name: msg('Site.postNav.navLabel') })
    expect(postNav.compareDocumentPosition(aside) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(aside.querySelector('img')).toBeNull()
  })

  it('the author box is that of the real author of the post, not the site owner', async () => {
    const author = { displayName: 'Alice Johnson', githubLogin: 'alicejohnson', avatarUrl: null, siteOwner: false }
    vi.mocked(getPost).mockResolvedValue({ ...post, author })

    render(await renderPage(props('dat-van-de')))

    expect(screen.getByRole('complementary', { name: author.displayName })).toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: PROFILE_NAME })).not.toBeInTheDocument()
  })

  it('published post: the beacon sends the exact slug once (jsdom has no referrer so there is no host line)', async () => {
    vi.mocked(getPost).mockResolvedValue(post)

    render(await renderPage(props('dat-van-de')))

    expect(sendBeacon).toHaveBeenCalledTimes(1)
    expect(sendBeacon).toHaveBeenCalledWith('/api/views', 'dat-van-de')
  })

  it('unpublished post: no beacon, the backend only counts published posts', async () => {
    vi.mocked(getPost).mockResolvedValue({ ...post, status: 'DRAFT' })

    render(await renderPage(props('dat-van-de')))

    expect(sendBeacon).not.toHaveBeenCalled()
  })
})

describe('PostPage "What to read next"', () => {
  it('asks for the post page block, except the post being read, and renders it after the related posts', async () => {
    vi.mocked(getPost).mockResolvedValue(post)
    stubPublished([summary('a', IN_CATEGORY)])
    vi.mocked(getDiscovery).mockResolvedValue({
      ...NO_DISCOVERY,
      recent: [summary('moi-viet', { title: 'Freshly written post' })],
    })

    render(await renderPage(props('dat-van-de')))

    expect(getDiscovery).toHaveBeenCalledWith({ context: 'article', excludeSlug: 'dat-van-de', language: 'vi' })
    const heading = screen.getByRole('heading', { level: 2, name: msg('Site.article.readNextTitle') })
    // Scoped to its own block: a title can be a link in the left rail, in PostNav, in the related block and here.
    const readNext = within(screen.getByRole('region', { name: msg('Site.article.readNextTitle') }))
    expect(readNext.getByRole('link', { name: 'Freshly written post' })).toHaveAttribute('href', '/posts/moi-viet')
    const related = screen.getByRole('heading', { level: 2, name: msg('Site.related.title') })
    expect(related.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('getDiscovery rejects: the page still renders, no block', async () => {
    vi.mocked(getPost).mockResolvedValue(post)
    vi.mocked(getDiscovery).mockRejectedValue(new Error('discovery exploded'))

    render(await renderPage(props('dat-van-de')))

    expect(screen.getByRole('heading', { level: 1, name: post.title })).toBeInTheDocument()
    expect(screen.getByText('One paragraph.')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: msg('Site.article.readNextTitle') })).not.toBeInTheDocument()
  })

  it('each tag link still appears only once on the page', async () => {
    vi.mocked(getPost).mockResolvedValue(post)
    vi.mocked(getDiscovery).mockResolvedValue({
      ...NO_DISCOVERY,
      // The tag data is in Discovery, but the post page variant does not draw the Tags block.
      tags: [{ tag: post.tags[0], count: 3 }],
      tagTotal: 1,
      recent: [summary('moi-viet')],
    })

    const { container } = render(await renderPage(props('dat-van-de')))

    expect(screen.getByRole('heading', { level: 2, name: msg('Site.article.readNextTitle') })).toBeInTheDocument()
    expect(container.querySelectorAll('a[href="/tags/spring-boot"]')).toHaveLength(1)
  })
})

/*
 * Likes and comments: two client-side islands, placed in the right spot,
 * only for published posts, and the page stays static: the prerendered HTML is identical for everyone.
 */
describe('PostPage likes and comments', () => {
  it('on a phone the like, the save and the Share menu share one row, and the four share icons are hidden below sm', async () => {
    vi.mocked(getPost).mockResolvedValue(post)

    const { container } = render(await renderPage(props('dat-van-de')))
    const row = container.querySelector('#luot-thich')!.parentElement!

    expect(row).toHaveClass('max-sm:flex-nowrap')
    // The phone's Share menu is the last item of that row and only shows below sm.
    const menu = row.querySelector('details')!
    expect(menu.parentElement).toHaveClass('sm:hidden')
    // The icon row of the toolbar is the one that is hidden below sm.
    expect(railShareLink('Facebook').closest('div.' + CSS.escape('max-sm:hidden'))).not.toBeNull()
  })

  it('like button then bookmark button, in the same row inside the reading rail (the last child of <article>), right before the share row', async () => {
    vi.mocked(getPost).mockResolvedValue(post)

    const { container } = render(await renderPage(props('dat-van-de')))
    const like = container.querySelector('#luot-thich')
    const article = container.querySelector('article')!

    expect(like).not.toBeNull()
    expect(railAside().contains(like)).toBe(true)
    // The reading rail is inside the article now (spec v2 2.5), so the like button is too, and it is not in the body column.
    expect(article.contains(like)).toBe(true)
    expect(container.querySelector('[data-reader-body]')!.contains(like)).toBe(false)
    // One like button and one bookmark button on the page: the actions toolbar is not drawn twice.
    expect(container.querySelectorAll('#luot-thich')).toHaveLength(1)
    expect(container.querySelectorAll('#luu-bai')).toHaveLength(1)
    // The bookmark button comes right after the like button, in the same row; right after the row is the share row, nothing in between.
    expect(like!.nextElementSibling).toBe(container.querySelector('#luu-bai'))
    expect(like!.parentElement!.nextElementSibling).toContainElement(railShareLink('Facebook'))
    // Session not known yet: an inert placeholder, no button or link to click.
    expect(like!.querySelector('[data-like-placeholder]')).toHaveAttribute('aria-hidden', 'true')
    expect(within(like as HTMLElement).queryByRole('button')).toBeNull()
  })

  it('comment area: section#binh-luan named "Comments", after <article> and after PostNav, before related posts', async () => {
    vi.mocked(getPost).mockResolvedValue(post)
    // 'a' is in the same category so there is a related block; the other three posts share nothing, they only feed PostNav neighbors.
    stubPublished([summary('moi-hon'), summary('dat-van-de'), summary('cu-hon'), summary('a', IN_CATEGORY)])

    const { container } = render(await renderPage(props('dat-van-de')))
    const comments = screen.getByRole('region', { name: msg('Site.comments.heading') })
    const article = container.querySelector('article')!

    expect(comments.tagName).toBe('SECTION')
    expect(comments.id).toBe('binh-luan')
    expect(comments).toHaveAttribute('aria-labelledby', 'binh-luan-heading')
    expect(within(comments).getByRole('heading', { level: 2, name: msg('Site.comments.heading') })).toHaveAttribute(
      'id',
      'binh-luan-heading',
    )
    expect(article.contains(comments)).toBe(false)

    const following = (a: Element, b: Element) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING
    const postNav = screen.getByRole('navigation', { name: msg('Site.postNav.navLabel') })
    expect(following(article, comments)).toBeTruthy()
    expect(following(postNav, comments)).toBeTruthy()
    expect(following(comments, screen.getByRole('heading', { level: 2, name: msg('Site.related.title') }))).toBeTruthy()
    // The same text column as the post: the end slot of the grid (bare, no Container of its own, so no second gutter or
    // width) holds PostNav and the comments, and it is not hidden on paper as a whole.
    const endSlot = postNav.parentElement!
    expect(endSlot.contains(comments)).toBe(true)
    expect(endSlot.className.split(/\s+/)).toEqual(expect.arrayContaining(END_SLOT.split(/\s+/)))
    expect(comments.closest('.max-w-3xl')).toBeNull()
    // Session not known yet: a loading frame, no form, no sign-in invitation.
    expect(comments.querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(within(comments).queryByRole('textbox')).toBeNull()
    expect(within(comments).queryByRole('link')).toBeNull()
  })

  it('unpublished post: no like button, no comment area, since the backend only accepts both for published posts', async () => {
    vi.mocked(getPost).mockResolvedValue({ ...post, status: 'DRAFT' })

    const { container } = render(await renderPage(props('dat-van-de')))

    expect(container.querySelector('#luot-thich')).toBeNull()
    expect(container.querySelector('#luu-bai')).toBeNull()
    expect(container.querySelector('#binh-luan')).toBeNull()
    expect(screen.queryByRole('region', { name: msg('Site.comments.heading') })).toBeNull()
    // The post still renders: the absence is not because the page is broken.
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument()
  })

  it('both islands use the slug the backend stores, not the slug in the URL: BFF routes and the return target after sign-in', async () => {
    vi.mocked(getPost).mockResolvedValue({ ...post, slug: NFC_SLUG })
    // The session answered "guest": the two islands ask their BFF routes right away (jsdom has no
    // IntersectionObserver). The request hangs forever: what matters is the URL, not the answer.
    session.value = { status: 'anonymous', loggedOut: false }
    const fetchSpy = vi.fn(() => new Promise<Response>(() => {}))
    vi.stubGlobal('fetch', fetchSpy)

    render(await renderPage(props(NFD_SLUG)))

    const urls = fetchSpy.mock.calls.map((call: unknown[]) => String(call[0]))
    const encoded = encodeURIComponent(NFC_SLUG)
    expect(urls).toEqual(expect.arrayContaining([`/api/posts/${encoded}/like`, `/api/posts/${encoded}/comments`]))
    expect(urls.every((url) => !url.includes(encodeURIComponent(NFD_SLUG)))).toBe(true)
    expect(screen.getByRole('link', { name: msg('Site.comments.loginPrompt') })).toHaveAttribute(
      'href',
      githubStartHref(`${postPath(NFC_SLUG)}#binh-luan`),
    )
  })

  it('prerendered HTML carries nothing of the reader: no form, no invitation, no name, no number', async () => {
    vi.mocked(getPost).mockResolvedValue(post)
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    let html: string
    try {
      html = renderToString(<IntlWrapper>{await renderPage(props('dat-van-de'))}</IntlWrapper>)
    } finally {
      vi.unstubAllGlobals()
    }

    expect(html).toContain('id="binh-luan"')
    expect(html).toContain('id="luot-thich"')
    expect(html).not.toMatch(
      new RegExp(
        [
          '<textarea',
          msg('Site.account.signInWithGithub'),
          msg('Site.comments.rootForm.submit'),
          msg('Site.comments.like.countLabel', { n: 2 }),
          msg('Site.comments.empty').split('.')[0],
        ].join('|'),
      ),
    )
    // The bookmark button: only an inert placeholder, no saved state, no sign-in invitation link, no button.
    const parsed = document.createElement('div')
    parsed.innerHTML = html
    const bookmark = parsed.querySelector('#luu-bai')
    expect(bookmark?.querySelector('[data-bookmark-placeholder]')).toHaveAttribute('aria-hidden', 'true')
    expect(bookmark?.querySelector('a, button, [aria-pressed]')).toBeNull()
    expect(html).not.toMatch(
      new RegExp(
        [
          'aria-pressed',
          msg('Site.bookmarkButton.guestName').split(' — ')[1],
          msg('Admin.editor.state.saved'),
          msg('Site.bookmarks.unsave'),
        ].join('|'),
      ),
    )
    // The server render calls no BFF route: the session and the data both arrive after hydration.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('the page is still static/ISR: the source reads no cookie, header or request', () => {
    // `cookies()`/`headers()` (or `connection()`, `draftMode()`) here turn the page dynamic: prerendering is lost,
    // and a "while I am here" fix that reads the session on the server would put one person's data into the HTML
    // cached for everyone. The session may only be read in the client island, through the no-store BFF route.
    const source = readFileSync(join(process.cwd(), 'app/[locale]/(site)/posts/[slug]/page.tsx'), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

    expect(code).not.toMatch(/\bcookies\s*\(|\bheaders\s*\(|\bconnection\s*\(|\bdraftMode\s*\(|next\/headers|next\/server/)
    expect(code).not.toMatch(/searchParams/)
    expect(code).not.toMatch(/export\s+const\s+dynamic\b/)
    expect(revalidate).toBe(300)
  })
})

describe('PostPage language and translations', () => {
  const enPost: ArticlePost = { ...post, slug: 'performance-problem', title: 'Performance problem', language: 'en' }
  const viWithEn: ArticlePost = {
    ...post,
    language: 'vi',
    translations: [{ language: 'en', slug: 'performance-problem', title: 'Performance problem', status: 'PUBLISHED' }],
  }
  const enWithVi: ArticlePost = {
    ...enPost,
    translations: [{ language: 'vi', slug: 'dat-van-de', title: post.title, status: 'PUBLISHED' }],
  }
  const metadataOf = (slug: string, locale: 'vi' | 'en' = 'vi') =>
    generateMetadata({ ...props(slug), params: Promise.resolve({ locale, slug }) })

  it('an English post is canonical at its /en URL, whichever locale the URL was opened under, with the English og:locale', async () => {
    vi.mocked(getPost).mockResolvedValue(enPost)

    for (const locale of ['en', 'vi'] as const) {
      const metadata = await metadataOf('performance-problem', locale)
      expect(metadata.alternates?.canonical).toBe('/en/posts/performance-problem')
      expect(metadata.openGraph?.url).toBe('/en/posts/performance-problem')
      expect(metadata.openGraph).toMatchObject({ locale: 'en_US' })
      expect(metadata.alternates).not.toHaveProperty('languages')
    }
  })

  it('a Vietnamese post keeps /posts/<slug> as its canonical, also under /en', async () => {
    vi.mocked(getPost).mockResolvedValue(post)

    expect((await metadataOf('dat-van-de', 'en')).alternates?.canonical).toBe('/posts/dat-van-de')
  })

  it('hreflang links only the post and its published translations, the same map from both sides, with x-default = the Vietnamese one', async () => {
    const expected = { vi: '/posts/dat-van-de', en: '/en/posts/performance-problem', 'x-default': '/posts/dat-van-de' }

    vi.mocked(getPost).mockResolvedValue(viWithEn)
    expect((await metadataOf('dat-van-de')).alternates?.languages).toEqual(expected)
    vi.mocked(getPost).mockResolvedValue(enWithVi)
    expect((await metadataOf('performance-problem', 'en')).alternates?.languages).toEqual(expected)
  })

  it('JSON-LD states the language and the language URL of the post', async () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://example.com')
    vi.mocked(getPost).mockResolvedValue(enPost)

    try {
      const { container } = render(
        await renderPage({
          ...props('performance-problem'),
          params: Promise.resolve({ locale: 'en', slug: 'performance-problem' }),
        }),
      )
      const scripts = [...container.querySelectorAll('script[type="application/ld+json"]')].map((s) =>
        JSON.parse(s.textContent ?? ''),
      )
      const article = scripts.find((data) => data['@type'] === 'BlogPosting')
      const trail = scripts.find((data) => data['@type'] === 'BreadcrumbList')

      expect(article).toMatchObject({ inLanguage: 'en', url: 'https://example.com/en/posts/performance-problem' })
      expect(trail?.itemListElement.at(-1).item).toBe('https://example.com/en/posts/performance-problem')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('neighbours, related posts, series and suggestions are asked for the language of the post', async () => {
    vi.mocked(getPost).mockResolvedValue({
      ...enPost,
      series: { id: 's', title: 'S', slug: 'chuoi', position: 1, totalParts: 2 } as never,
    })
    vi.mocked(getSeries).mockResolvedValue({ id: 's', title: 'S', slug: 'chuoi', description: null, posts: [] } as never)

    render(
      await renderPage({
        ...props('performance-problem'),
        params: Promise.resolve({ locale: 'en', slug: 'performance-problem' }),
      }),
    )

    expect(getPosts).toHaveBeenCalledWith({ page: 0, size: 100, language: 'en' })
    expect(getSeries).toHaveBeenCalledWith('chuoi', 'en')
    expect(getDiscovery).toHaveBeenCalledWith({ context: 'article', excludeSlug: 'performance-problem', language: 'en' })
  })

  it('"read in another language": one link per published translation to its own URL, with lang and hreflang; none without translations', async () => {
    vi.mocked(getPost).mockResolvedValue(viWithEn)
    const { unmount } = render(await renderPage(props('dat-van-de')))

    const nav = screen.getByRole('navigation', { name: msg('Site.article.translations.label') })
    const link = within(nav).getByRole('link', { name: 'Performance problem' })
    expect(link).toHaveAttribute('href', '/en/posts/performance-problem')
    expect(link).toHaveAttribute('hreflang', 'en')
    expect(link).toHaveAttribute('lang', 'en')
    unmount()

    vi.mocked(getPost).mockResolvedValue(post)
    render(await renderPage(props('dat-van-de')))
    expect(screen.queryByRole('navigation', { name: msg('Site.article.translations.label') })).toBeNull()
  })
})
