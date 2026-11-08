import { render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, searchContent } from '@/lib/api'
import { getDiscovery, type Discovery } from '@/lib/discovery'
import { rateLimit } from '@/lib/rate-limit'
import type { Segment } from '@/lib/search-contract'
import { SEARCH_RATE } from '@/lib/search-suggest'
import { getSeriesList } from '@/lib/series'
import { getCategories, getTags } from '@/lib/taxonomy'
import type { PostSummary, SeriesSummary } from '@/lib/types'
import SearchPage, { generateMetadata, revalidate } from './page'
import {
  BODY_END_PATTERN,
  DIACRITICS_ADVICE_WORD,
  FIRST_RESULT,
  HIGHLIGHTED_TEXTS,
  SECOND_RESULT,
} from '@/test/fixtures/vi/search-highlight'
import { msg } from '@/test/render-intl'
import { lastBrowseFrameCall, resetBrowseFrameCalls } from '@/test/browse-frame-mock'

/** Helpers over catalog messages that carry one rich tag: the text before it, inside it, and after it. */
const MARK = '\u0000'
const beforeTag = (key: string, tag: string): string => msg(key, { [tag]: () => MARK } as never).split(MARK)[0]!
const afterTag = (key: string, tag: string): string => msg(key, { [tag]: () => MARK } as never).split(MARK)[1]!
const tagContent = (key: string, tag: string): string =>
  new RegExp(`<${tag}>(.*)</${tag}>`).exec(msg(key, { [tag]: (c: string) => `<${tag}>${c}</${tag}>` } as never))![1]!

/** A pattern for a message with a number and a query in it: any number, any query. */
const esc = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const NUMBER = 987654
const QUERY = 'QQQ'
const wildcard = (text: string): string => esc(text).replaceAll(QUERY, '.*').replaceAll(String(NUMBER), '\\d+')
const COUNT_ANY = new RegExp(wildcard(msg('Site.search.count.withQuery', { count: NUMBER, query: QUERY })))
const NO_MATCH_ANY = new RegExp(
  [
    msg('Site.search.noMatch.withQuery', { query: QUERY }),
    msg('Site.search.noMatch.withQueryAndFilters', { query: QUERY }),
    msg('Site.search.noMatch.filtersOnly'),
  ]
    .map(wildcard)
    .join('|'),
)
const PROMPT = new RegExp(esc(beforeTag('Site.search.prompt', 'link').trim()))
const ALL_POSTS_LINK = tagContent('Site.search.prompt', 'link')
const RETRY_KEYWORD = new RegExp(esc(beforeTag('Site.search.noMatch.retryKeyword', 'link').trim()))

/**
 * `SearchPage` is an async Server Component, so RTL cannot render it directly —
 * `render(<SearchPage />)` would hand RTL a promise. It is an ordinary exported async
 * function, so these tests call it and render the tree it returns.
 *
 * Extracting the `?q`/`?page` parsing into a pure helper and unit-testing that instead
 * was rejected for the same reason /writing rejected it: the helper would be tested and
 * the page would not, so nothing would catch the page passing the wrong value to it,
 * ignoring its answer, or losing the `notFound()`.
 *
 * `notFound()` is the real one from next/navigation, not a mock — outside a request
 * context it throws an Error whose `digest` is 'NEXT_HTTP_ERROR_FALLBACK;404'.
 * Asserting a stub was called cannot tell a real 404 from a page that carried on
 * rendering.
 */
// The frame (sidebar + main column) is tested once in BrowseFrame.test.tsx; here it records what the page asked for.
vi.mock('@/components/site/BrowseFrame', () => import('@/test/browse-frame-mock'))
vi.mock('@/lib/api', async (importOriginal) => ({
  // Real ApiError: the page tells 400 apart with `instanceof`. The rest is real, so `fetch` is blocked
  // in beforeEach: no network call escapes the mock.
  ...(await importOriginal<typeof import('@/lib/api')>()),
  searchContent: vi.fn(),
}))

/**
 * The reader IP for the per-IP rate limit (`SEARCH_RATE`): one IP per test, so that the searches of this test
 * do not use up the allowance of another test. The counter is the real one (lib/rate-limit.ts).
 */
const reader = vi.hoisted(() => {
  const state = { n: 0, unknown: false, ip: (): string => (state.unknown ? 'unknown' : `203.0.113.${state.n}`) }
  return state
})
vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(new Headers({ 'x-forwarded-for': reader.ip() })),
}))

/** The lists for the filter field and the chip names; the real one hits the network. */
vi.mock('@/lib/taxonomy', () => ({ getCategories: vi.fn(), getTags: vi.fn() }))
vi.mock('@/lib/series', () => ({ getSeriesList: vi.fn() }))

const CATEGORY = { id: 'c1', name: 'Architecture', slug: 'kien-truc', description: null }
const TAGS = [
  { id: 't1', name: 'AWS', slug: 'aws' },
  { id: 't2', name: 'Java', slug: 'java' },
]
const SERIES: SeriesSummary = {
  id: 's1',
  title: 'Series A',
  slug: 'series-a',
  description: null,
  postCount: 2,
  readingMinutes: 10,
  latestPublishedAt: '2026-10-01T00:00:00Z',
  parts: [],
}

/**
 * The reading suggestions in the "no results" state come from getDiscovery, the real one hits the network
 * (fetchAllPublishedPosts, /posts?sort=popular). `importOriginal` keeps the real constants and `shouldShowViews`
 * for DiscoveryGrid, like the post page test.
 */
vi.mock('@/lib/discovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/discovery')>()),
  getDiscovery: vi.fn(),
}))

/** No block has anything: DiscoveryGrid returns null. */
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

/** One post in the answer, with the match spot chosen by the engine (without one it is plain text, no segment matches). */
type Row = PostSummary & { titleSegments?: Segment[]; descriptionSegments?: Segment[] }

/**
 * The real shape of `GET /api/v1/search?type=post`: the `post` group with `total`, `page`, `totalPages`, each
 * row carrying `Segment[]` and the `post` summary.
 *
 * Echoes the requested page back in `page`, because that is exactly what the backend
 * does: past the last page the group keeps its total and `totalPages` with no items, and
 * with no match at all there is no group. A mock that clamped the page itself would hide
 * the out-of-range rule this page has to apply.
 *
 * `totalElements` is deliberately NOT `items.length`: the live endpoint answers 6
 * matches across 3 pages of 2, and a page that printed `items.length` would read
 * "2 results" on a six-match search. See the count test.
 */
function respond({
  items,
  totalElements,
  totalPages,
  degraded = false,
}: {
  items: Row[]
  totalElements: number
  totalPages: number
  degraded?: boolean
}) {
  vi.mocked(searchContent).mockImplementation(async ({ q, page = 0 }) => ({
    query: q.trim(),
    engine: 'postgres',
    degraded,
    groups:
      totalElements === 0
        ? []
        : [
            {
              type: 'post',
              total: totalElements,
              page,
              totalPages,
              items: items.map(({ titleSegments, descriptionSegments, ...post }) => {
                const description = descriptionSegments ?? (post.excerpt ? [{ text: post.excerpt, match: false }] : undefined)
                return {
                  id: `post:${post.slug}`,
                  title: titleSegments ?? [{ text: post.title, match: false }],
                  ...(description ? { description } : {}),
                  href: `/posts/${post.slug}`,
                  post,
                }
              }),
            },
          ],
  }))
}

function props(searchParams: Record<string, string | string[] | undefined> = {}): PageProps<'/[locale]/search'> {
  return { params: Promise.resolve({ locale: 'vi' }), searchParams: Promise.resolve(searchParams) }
}

async function expectNotFound(pageProps: PageProps<'/[locale]/search'>, label: string) {
  const thrown = await SearchPage(pageProps).then(
    () => null,
    (error: unknown) => error,
  )
  expect(thrown, `${label}: SearchPage returned a page instead of calling notFound()`).not.toBeNull()
  expect((thrown as { digest?: string }).digest, label).toBe('NEXT_HTTP_ERROR_FALLBACK;404')
}

beforeEach(() => {
  reader.n += 1
  reader.unknown = false
  // Empty means "nothing to suggest", not "the page swallowed an error": a test that needs the suggestion block sets it itself.
  vi.mocked(getDiscovery).mockResolvedValue(NO_DISCOVERY)
  vi.mocked(getCategories).mockResolvedValue([CATEGORY])
  vi.mocked(getTags).mockResolvedValue(TAGS)
  vi.mocked(getSeriesList).mockResolvedValue([SERIES])
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Promise.reject(new Error('unexpected network call'))),
  )
})

afterEach(() => {
  resetBrowseFrameCalls()
  expect(fetch, 'a real network call escaped the mocks').not.toHaveBeenCalled()
  vi.unstubAllGlobals()
  vi.mocked(searchContent).mockReset()
  vi.mocked(getDiscovery).mockReset()
  vi.mocked(getCategories).mockReset()
  vi.mocked(getTags).mockReset()
  vi.mocked(getSeriesList).mockReset()
})

describe('/search — frame', () => {
  it('renders inside the frame with no current Explore row, and the form and filters in a max-w-3xl block', async () => {
    respond({ items: [summary(1)], totalElements: 1, totalPages: 1 })

    render(await SearchPage(props({ q: 'queue' })))

    const frame = screen.getByTestId('browse-frame')
    expect(lastBrowseFrameCall()?.current).toBeUndefined()
    expect(frame).not.toHaveAttribute('data-current')
    const form = screen.getByRole('search')
    expect(frame).toContainElement(form)
    // The form block is capped at a form's width; the results below use the whole column (no cap on the section).
    const block = form.closest('.max-w-3xl') as HTMLElement
    expect(block).not.toBeNull()
    expect(frame).toContainElement(block)
    const results = screen.getByRole('link', { name: 'Post 1' }).closest('section')!
    expect(results.closest('.max-w-3xl')).toBeNull()
    expect(results).not.toHaveClass('max-w-3xl')
  })
})

describe('/search — no query yet', () => {
  it('shows the form and a prompt, not an empty result list and not "0 results"', async () => {
    respond({ items: [summary(1)], totalElements: 1, totalPages: 1 })

    const { container } = render(await SearchPage(props()))

    // The form is there to be used.
    expect(screen.getByRole('search')).toBeInTheDocument()
    expect(screen.getByLabelText(msg('Site.search.form.keywordLabel'))).toHaveValue('')

    // A count of zero would be a false statement about a search that never happened.
    // This is the state a reader lands on from the header's search icon, so it is the
    // most-rendered of the four.
    expect(screen.queryByText(COUNT_ANY)).not.toBeInTheDocument()
    expect(screen.queryByText(NO_MATCH_ANY)).not.toBeInTheDocument()
    // PostList's rows, and PostList's own empty message. Neither belongs here: there is
    // no result set to be empty.
    expect(container.querySelectorAll('li > article')).toHaveLength(0)
    expect(screen.queryByText(msg('Site.home.empty'))).not.toBeInTheDocument()
    // No pager over nothing.
    expect(screen.queryByRole('navigation', { name: msg('Site.pagination.label') })).not.toBeInTheDocument()

    // The prompt, with a way out of the dead end.
    expect(screen.getByText(PROMPT)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: ALL_POSTS_LINK })).toHaveAttribute('href', '/writing')

    // The reading suggestions only belong to the "no results" state: when nobody has searched anything, it is not asked.
    expect(getDiscovery).not.toHaveBeenCalled()
    // Empty field: the reader came to type (SearchForm focuses itself when there is no query).
    expect(screen.getByLabelText(msg('Site.search.form.keywordLabel'))).toHaveFocus()
  })

  it('does not ask the API at all when nothing has been searched', async () => {
    respond({ items: [], totalElements: 0, totalPages: 0 })

    // The answer is already known (the backend answers a blank q with no filter with no
    // groups), and this is the most-rendered state of the page: no round trip for it,
    // whether q is missing, empty or whitespace only.
    await SearchPage(props())
    await SearchPage(props({ q: '' }))
    await SearchPage(props({ q: '   ' }))
    expect(searchContent).not.toHaveBeenCalled()
  })

  it('does not 404 a stray ?page when nothing has been searched', async () => {
    respond({ items: [], totalElements: 0, totalPages: 0 })

    // totalPages is 0 here, so /writing's rule (`current > 0 && current >= totalPages`)
    // would make this a not-found — for a page that plainly exists and is this route's
    // primary content. The canonical '/search' is what stops it being an indexable
    // duplicate; a 404 is not needed and would be wrong.
    render(await SearchPage(props({ page: '2' })))

    expect(screen.getByText(PROMPT)).toBeInTheDocument()
  })

  it('treats a whitespace-only query as no query at all', async () => {
    respond({ items: [summary(1)], totalElements: 1, totalPages: 1 })

    render(await SearchPage(props({ q: '   ' })))

    // Not the no-match state: echoing «   » back at the reader inside quotes is a
    // nonsense message about a search nobody made.
    expect(screen.getByText(PROMPT)).toBeInTheDocument()
    expect(screen.queryByText(NO_MATCH_ANY)).not.toBeInTheDocument()
  })
})

describe('/search — a query with no matches', () => {
  it('says so, echoes the query back, and offers somewhere to go', async () => {
    respond({ items: [], totalElements: 0, totalPages: 0 })

    const { container } = render(await SearchPage(props({ q: 'zzzznomatch' })))

    // Echoed back, because "no results" alone leaves the reader unsure the box
    // even received what they typed.
    expect(screen.getByText(msg('Site.search.noMatch.withQuery', { query: 'zzzznomatch' }))).toBeInTheDocument()
    expect(screen.getByRole('link', { name: ALL_POSTS_LINK })).toHaveAttribute('href', '/writing')
    // PINNED AGAIN: the "check the diacritics again" advice is gone. Search now strips diacritics, so typing missing
    // or wrong diacritics is no longer a reason for a query to return empty; advising to fix diacritics sends the reader
    // off to fix something that is not broken.
    expect(screen.queryByText(DIACRITICS_ADVICE_WORD)).not.toBeInTheDocument()
    expect(screen.getByText(RETRY_KEYWORD)).toBeInTheDocument()
    // And it is NOT the prompt state, nor an empty list, nor a pager.
    expect(screen.queryByText(PROMPT)).not.toBeInTheDocument()
    expect(container.querySelectorAll('li > article')).toHaveLength(0)
    expect(screen.queryByRole('navigation', { name: msg('Site.pagination.label') })).not.toBeInTheDocument()

    // The box keeps the query, so the reader can edit rather than retype.
    expect(screen.getByLabelText(msg('Site.search.form.keywordLabel'))).toHaveValue('zzzznomatch')
  })

  it('is also the state for a query the search engine cannot use', async () => {
    respond({ items: [], totalElements: 0, totalPages: 0 })

    // The brief's fourth state collapses into this one, and that was VERIFIED against
    // the running backend rather than assumed:
    //
    //   curl -s -w '%{http_code}' ".../api/v1/posts/search?q=%21%40%23%24%25%5E%26*%28%29"
    //     -> 200  {"data":[],"pagination":{"page":0,"size":20,"totalElements":0,...}}
    //
    // Punctuation-only input is a normal empty page, not an error envelope and not a
    // 500, so there is no fourth branch in the page. This test pins that the page does
    // not grow one, and that the echo survives characters that need escaping.
    render(await SearchPage(props({ q: '!@#$%^&*()' })))

    expect(screen.getByText(msg('Site.search.noMatch.withQuery', { query: '!@#$%^&*()' }))).toBeInTheDocument()
  })

  it('suggests posts to read next: a "Suggested reading" block after the message, with the same /writing link', async () => {
    respond({ items: [], totalElements: 0, totalPages: 0 })
    vi.mocked(getDiscovery).mockResolvedValue({
      ...NO_DISCOVERY,
      popular: { kind: 'recommended', posts: [{ ...summary(7), title: 'Must-read post' }] },
      recent: [{ ...summary(8), title: 'Freshly written post', publishedAt: '2026-10-03T18:23:29Z' }],
    })

    const { container } = render(await SearchPage(props({ q: 'zzzznomatch' })))

    // The post page block ("Read these first" / "Most read", "Recently written"), excluding no post: here there is no
    // "the post being read".
    expect(getDiscovery).toHaveBeenCalledTimes(1)
    expect(getDiscovery).toHaveBeenCalledWith({ context: 'article', language: 'vi' })

    const suggestions = screen.getByRole('region', { name: msg('Site.search.suggestionsTitle') })
    expect(within(suggestions).getByRole('heading', { level: 2, name: msg('Site.search.suggestionsTitle') })).toBeInTheDocument()
    expect(within(suggestions).getByRole('link', { name: 'Must-read post' })).toHaveAttribute('href', '/posts/bai-viet-7')
    expect(within(suggestions).getByRole('link', { name: 'Freshly written post' })).toHaveAttribute('href', '/posts/bai-viet-8')

    // After the "no results" message, not replacing it: the /writing link is still there.
    const message = screen.getByText(msg('Site.search.noMatch.withQuery', { query: 'zzzznomatch' }))
    expect(message.compareDocumentPosition(suggestions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The suggestion band is a sibling of the frame, after the grid: not inside the results section, not inside the main column.
    // It sits under a hairline (border-t), at frame width, and is hidden in print.
    const section = message.closest('section')!
    const frame = screen.getByTestId('browse-frame')
    expect(section.contains(suggestions)).toBe(false)
    expect(frame.contains(suggestions)).toBe(false)
    const band = suggestions.parentElement!
    expect(band).toHaveClass('border-t', 'print:hidden')
    expect(band.previousElementSibling).toBe(frame)
    expect(suggestions.className).toContain('max-w-[87.5rem]')
    // No bottom padding logic on the results section any more: the frame's main column supplies the space.
    expect(section).not.toHaveClass('pb-6')
    expect(section).not.toHaveClass('pb-16')
    expect(screen.getByRole('link', { name: ALL_POSTS_LINK })).toHaveAttribute('href', '/writing')
    // One h1, then the h2 of the suggestion block: no skipped heading level.
    expect(container.querySelectorAll('h1')).toHaveLength(1)
    // Still no result rows, no pager: this is a suggestion, not a result.
    expect(container.querySelectorAll('li > article')).toHaveLength(0)
    expect(screen.queryByRole('navigation', { name: msg('Site.pagination.label') })).not.toBeInTheDocument()
  })

  it('nothing to suggest, or getDiscovery failing: only the message and the /writing link, no empty block', async () => {
    respond({ items: [], totalElements: 0, totalPages: 0 })

    // Every block empty: DiscoveryGrid does not render, no heading standing over empty space.
    const empty = render(await SearchPage(props({ q: 'zzzznomatch' })))
    expect(screen.queryByRole('heading', { name: msg('Site.search.suggestionsTitle') })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: ALL_POSTS_LINK })).toBeInTheDocument()
    // No band at all after the frame: no lone rule above the footer.
    expect(screen.getByTestId('browse-frame').nextElementSibling).toBeNull()
    empty.unmount()

    // getDiscovery never throws (each source catches its own errors), but the page does not rely on that:
    // a failing secondary block must not turn the "no results" page into a 500 page.
    vi.mocked(getDiscovery).mockRejectedValue(new Error('discovery exploded'))
    render(await SearchPage(props({ q: 'zzzznomatch' })))
    expect(screen.getByText(msg('Site.search.noMatch.withQuery', { query: 'zzzznomatch' }))).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: msg('Site.search.suggestionsTitle') })).not.toBeInTheDocument()
  })

  it('passes the page language to the search and to the filter options', async () => {
    respond({ items: [], totalElements: 0, totalPages: 0 })

    render(await SearchPage({ ...props({ q: 'queue' }), params: Promise.resolve({ locale: 'en' }) }))

    expect(searchContent).toHaveBeenCalledWith(expect.objectContaining({ q: 'queue', language: 'en' }), { clientIp: reader.ip() })
    expect(getCategories).toHaveBeenCalledWith('en')
    expect(getTags).toHaveBeenCalledWith('en')
    expect(getSeriesList).toHaveBeenCalledWith('en')
  })

  it('searches and echoes the trimmed query, not the raw one', async () => {
    respond({ items: [], totalElements: 0, totalPages: 0 })

    render(await SearchPage(props({ q: '  queue  ' })))

    expect(searchContent).toHaveBeenCalledWith(
      { q: 'queue', type: 'post', page: 0, size: 10, language: 'vi' },
      { clientIp: reader.ip() },
    )
    // Echoing the untrimmed original would show quotes with phantom whitespace inside.
    expect(screen.getByText(msg('Site.search.noMatch.withQuery', { query: 'queue' }))).toBeInTheDocument()
  })
})

describe('/search — matches', () => {
  it('lists the matches and reports the total number of matches, not the page size', async () => {
    // The real shape of a multi-page search, measured: q=queue over size 2 answers
    // totalElements 6 across totalPages 3.
    respond({ items: [summary(1), summary(2)], totalElements: 6, totalPages: 3 })

    const { container } = render(await SearchPage(props({ q: 'queue' })))

    expect(searchContent).toHaveBeenCalledWith(
      { q: 'queue', type: 'post', page: 0, size: 10, language: 'vi' },
      { clientIp: reader.ip() },
    )
    expect(container.querySelectorAll('li > article')).toHaveLength(2)
    expect(screen.getByRole('link', { name: 'Post 1' })).toHaveAttribute('href', '/posts/bai-viet-1')

    // `meta.totalElements`, not `items.length`. The two differ on every page but the
    // last, and "2 results" on a six-match search is a lie that only surfaces once the
    // reader reaches the end.
    expect(screen.getByText(msg('Site.search.count.withQuery', { count: 6, query: 'queue' }))).toBeInTheDocument()

    // With results there is no suggestion block, and it is not asked.
    expect(getDiscovery).not.toHaveBeenCalled()
    // With a query: the reader is reading results, the search field does not take focus.
    expect(screen.getByLabelText(msg('Site.search.form.keywordLabel'))).not.toHaveFocus()
  })

  it('highlights exactly the match spots the server returns (Segment[]): the title, and a body excerpt in place of the excerpt', async () => {
    const seg = (text: string, match = false) => ({ text, match })
    respond({
      items: [
        {
          ...summary(1),
          title: FIRST_RESULT.title,
          excerpt: FIRST_RESULT.excerpt,
          titleSegments: [seg(FIRST_RESULT.titleParts[0], true), seg(FIRST_RESULT.titleParts[1])],
          // Meilisearch: a match only in the body makes the description a piece of the body, not the excerpt.
          descriptionSegments: [
            seg(FIRST_RESULT.bodyParts[0]),
            seg(FIRST_RESULT.bodyParts[1], true),
            seg(FIRST_RESULT.bodyParts[2]),
          ],
        },
        {
          ...summary(2),
          title: SECOND_RESULT.title,
          titleSegments: [
            seg(SECOND_RESULT.titleParts[0]),
            seg(SECOND_RESULT.titleParts[1], true),
            seg(SECOND_RESULT.titleParts[2]),
          ],
        },
      ],
      totalElements: 2,
      totalPages: 1,
    })

    const { container } = render(await SearchPage(props({ q: 'hoc duong' })))

    // The highlighted spots belong to the engine (without diacritics still matches with diacritics), not recomputed in the browser.
    expect(Array.from(container.querySelectorAll('mark')).map((m) => m.textContent)).toEqual(HIGHLIGHTED_TEXTS)
    expect(screen.getByText(BODY_END_PATTERN).tagName).toBe('P')
    expect(screen.queryByText(FIRST_RESULT.excerpt)).not.toBeInTheDocument()
    // The name of the title link is still the post title.
    expect(screen.getByRole('link', { name: FIRST_RESULT.title })).toHaveAttribute('href', '/posts/bai-viet-1')
    // The count line and the search field are not highlighted: only the result row.
    expect(
      screen.getByText(msg('Site.search.count.withQuery', { count: 2, query: 'hoc duong' })).querySelector('mark'),
    ).toBeNull()
  })

  /**
   * THE classic bug on this page, and the reason this test exists in this shape.
   *
   * A pager built with basePath="/search" looks perfect on page one — the links read
   * /search?page=1, nothing is visibly wrong — and every one of them lands on an
   * unsearched /search showing the prompt. Asserting "a pager rendered" cannot see it;
   * only the hrefs can.
   */
  it('keeps the query in every pager link', async () => {
    respond({ items: [summary(1)], totalElements: 30, totalPages: 3 })

    render(await SearchPage(props({ q: 'queue', page: '1' })))

    expect(searchContent).toHaveBeenCalledWith(
      { q: 'queue', type: 'post', page: 1, size: 10, language: 'vi' },
      { clientIp: reader.ip() },
    )
    expect(screen.getByText('Trang 2 / 3')).toBeInTheDocument()

    expect(screen.getByRole('link', { name: msg('Site.pagination.previous') })).toHaveAttribute('href', '/search?q=queue&page=0')
    expect(screen.getByRole('link', { name: /sau/i })).toHaveAttribute('href', '/search?q=queue&page=2')
  })

  it('encodes a query that would otherwise break the pager links', async () => {
    respond({ items: [summary(1)], totalElements: 30, totalPages: 3 })

    // '&' and '=' inside the value are what separate "built with URLSearchParams" from
    // "built with a template string": `/search?q=a & b=c&page=1` parses as q="a ", an
    // empty " b" parameter and c="", so the pager would search for something else
    // entirely. The '%' is there because a hand-rolled encoder that forgets it produces
    // an invalid escape sequence, and Pagination's own `basePath.split('?')` is only
    // safe because nothing unencoded reaches it.
    render(await SearchPage(props({ q: 'a & b=c 100%', page: '1' })))

    expect(screen.getByRole('link', { name: /sau/i })).toHaveAttribute('href', '/search?q=a+%26+b%3Dc+100%25&page=2')
    // And the round trip is real: decoding that href gives back exactly what was
    // searched. A pager whose links do not decode to the current query is the same bug
    // wearing an encoding costume.
    const next = screen.getByRole('link', { name: /sau/i }).getAttribute('href') ?? ''
    expect(new URLSearchParams(next.split('?')[1]).get('q')).toBe('a & b=c 100%')
  })

  it('404s a page past the end of the results', async () => {
    respond({ items: [], totalElements: 6, totalPages: 3 })

    // The backend echoes the requested page back, so without this the reader gets a
    // blank list under a pager reading "Trang 3 / 3" — a URL that does not exist,
    // answered 200 with a lie on it.
    await expectNotFound(props({ q: 'queue', page: '3' }), '?q=queue&page=3')

    // The rule reads the group's own `totalPages`, not a count recomputed here: 6 matches
    // over 3 pages means page index 2 exists, although 6 / PAGE_SIZE would say one page.
    respond({ items: [summary(1)], totalElements: 6, totalPages: 3 })
    render(await SearchPage(props({ q: 'queue', page: '2' })))
    expect(screen.getByText('Trang 3 / 3')).toBeInTheDocument()

    // No match at all: the backend sends no post group, so any page past the first is a 404.
    respond({ items: [], totalElements: 0, totalPages: 0 })
    await expectNotFound(props({ q: 'zzzznomatch', page: '1' }), '?q=zzzznomatch&page=1')
  })
})

describe('/search — searchParams guards', () => {
  it('is a run of digits or page 0 — never NaN, never 1e+22 on the wire', async () => {
    // Each of these is a URL a reader can type, and each broke something before the
    // shape check: Number.parseInt reads '1.5' as 1, '0x2' as 2, '2abc' as 2, and on a
    // 22-digit string returns a float, so String() shipped the API `page=1e+22` as an
    // integer parameter and the API answered 500.
    for (const page of ['abc', '1.5', '0x2', '2abc', '-1', '', ' 2']) {
      respond({ items: [summary(1)], totalElements: 1, totalPages: 1 })
      vi.mocked(searchContent).mockClear()

      render(await SearchPage(props({ q: 'queue', page })))

      expect(searchContent, `?page=${JSON.stringify(page)}`).toHaveBeenCalledWith(
        {
          q: 'queue',
          type: 'post',
          page: 0,
          size: 10,
          language: 'vi',
        },
        { clientIp: reader.ip() },
      )
    }
  })

  it('404s a page index too large to be a real request, without asking the API', async () => {
    for (const page of ['10001', '2147483647', '2147483648', '9999999999999999999999']) {
      respond({ items: [summary(1)], totalElements: 1, totalPages: 1 })
      vi.mocked(searchContent).mockClear()

      await expectNotFound(props({ q: 'queue', page }), `?page=${page}`)

      // The whole point of MAX_PAGE is that the absurd values never reach the API: the
      // backend binds page to a 32-bit int, so 2147483647 is a 500 and 2147483648 a
      // 400. A 404 that still made the call would have already logged the error.
      expect(searchContent, `?page=${page} must not reach the API`).not.toHaveBeenCalled()
    }
  })

  it('takes the first value when a parameter is repeated', async () => {
    respond({ items: [summary(1)], totalElements: 30, totalPages: 3 })

    // `?q=a&q=b&page=1&page=5` is a legal URL and arrives as arrays. `q.trim()` on an
    // array is a runtime TypeError — not a type error, because searchParams is typed
    // Record<string, string | string[] | undefined>.
    render(await SearchPage(props({ q: ['queue', 'kafka'], page: ['1', '5'] })))

    expect(searchContent).toHaveBeenCalledWith(
      { q: 'queue', type: 'post', page: 1, size: 10, language: 'vi' },
      { clientIp: reader.ip() },
    )
    // And the pager carries the single resolved query, not the array stringified into
    // "queue,kafka".
    expect(screen.getByRole('link', { name: /sau/i })).toHaveAttribute('href', '/search?q=queue&page=2')
  })
})

describe('/search — filters', () => {
  const FULL = { q: 'queue', category: 'kien-truc', tag: ['aws', 'java'], series: 'series-a' }
  const FULL_PATH = '/search?q=queue&category=kien-truc&tag=aws&tag=java&series=series-a'

  it('sends the URL filters to searchContent; the filter fields sit inside the GET form and reflect the URL exactly', async () => {
    respond({ items: [summary(1)], totalElements: 1, totalPages: 1 })

    render(await SearchPage(props(FULL)))

    expect(searchContent).toHaveBeenCalledWith(
      {
        q: 'queue',
        type: 'post',
        page: 0,
        size: 10,
        category: 'kien-truc',
        tags: ['aws', 'java'],
        series: 'series-a',
        language: 'vi',
      },
      { clientIp: reader.ip() },
    )
    // Inside the search field form: the "Search" button submits them too, and `name` is what the browser writes into the URL.
    const form = screen.getByRole('search')
    expect(within(form).getByLabelText(msg('Site.writing.categories'))).toHaveValue('kien-truc')
    expect(within(form).getByLabelText(msg('Site.writing.categories'))).toHaveAttribute('name', 'category')
    expect(within(form).getByLabelText('Series')).toHaveValue('series-a')
    expect(within(form).getByLabelText('Series')).toHaveAttribute('name', 'series')
    const tags = within(form).getByRole('group', { name: msg('Site.article.tagsLabel') })
    expect(within(tags).getByRole('checkbox', { name: 'AWS' })).toBeChecked()
    expect(within(tags).getByRole('checkbox', { name: 'Java' })).toHaveAttribute('name', 'tag')
    expect(within(form).getByText(tagContent('Site.search.filters.combineHelp', 'b')).parentElement).toHaveTextContent(
      afterTag('Site.search.filters.combineHelp', 'b').trim(),
    )
    // Viewing results: the filter panel is folded (the chips show the filters), the keyword field does not take focus.
    expect(form.querySelector('details')).not.toHaveAttribute('open')
    expect(screen.getByLabelText(msg('Site.search.form.keywordLabel'))).not.toHaveFocus()
  })

  it('each filter is a chip that removes exactly itself and the page; "Clear filters" keeps q; the pager keeps every filter', async () => {
    respond({ items: [summary(1)], totalElements: 30, totalPages: 3 })

    render(await SearchPage(props({ ...FULL, page: '1' })))

    const chips = within(screen.getByRole('list', { name: msg('Site.search.active.label') })).getAllByRole('link')
    expect(chips.map((chip) => [chip.getAttribute('aria-label'), chip.getAttribute('href')])).toEqual([
      [msg('Site.search.active.remove.category', { name: 'Architecture' }), '/search?q=queue&tag=aws&tag=java&series=series-a'],
      [msg('Site.search.active.remove.tag', { name: 'AWS' }), '/search?q=queue&category=kien-truc&tag=java&series=series-a'],
      [msg('Site.search.active.remove.tag', { name: 'Java' }), '/search?q=queue&category=kien-truc&tag=aws&series=series-a'],
      [msg('Site.search.active.remove.series', { name: 'Series A' }), '/search?q=queue&category=kien-truc&tag=aws&tag=java'],
    ])
    // The accessible name contains the visible text, and that is the real name, not the slug.
    expect(screen.getByRole('link', { name: msg('Site.search.active.remove.tag', { name: 'AWS' }) })).toHaveTextContent(
      msg('Site.taxonomy.tagTitle', { name: 'AWS' }),
    )
    expect(screen.getByRole('link', { name: msg('Site.search.active.clear') })).toHaveAttribute('href', '/search?q=queue')

    expect(screen.getByRole('link', { name: msg('Site.pagination.previous') })).toHaveAttribute('href', `${FULL_PATH}&page=0`)
    expect(screen.getByRole('link', { name: /sau/i })).toHaveAttribute('href', `${FULL_PATH}&page=2`)
  })

  it('filters only: lists matching posts, highlights nothing, the keyword field does not take focus; past the last page is 404', async () => {
    respond({ items: [{ ...summary(1), title: 'A post about AWS' }], totalElements: 1, totalPages: 1 })

    const { container } = render(await SearchPage(props({ tag: 'aws' })))

    expect(searchContent).toHaveBeenCalledWith(
      { q: '', type: 'post', page: 0, size: 10, tags: ['aws'], language: 'vi' },
      { clientIp: reader.ip() },
    )
    expect(screen.getByText(msg('Site.search.count.filtersOnly', { count: 1 }))).toBeInTheDocument()
    expect(container.querySelectorAll('li > article')).toHaveLength(1)
    expect(container.querySelector('mark')).toBeNull()
    expect(screen.queryByText(PROMPT)).not.toBeInTheDocument()
    expect(screen.getByLabelText(msg('Site.search.form.keywordLabel'))).not.toHaveFocus()
    expect(screen.getByRole('link', { name: msg('Site.search.active.remove.tag', { name: 'AWS' }) })).toHaveAttribute(
      'href',
      '/search',
    )
    expect(screen.getByRole('link', { name: msg('Site.search.active.clear') })).toHaveAttribute('href', '/search')

    await expectNotFound(props({ tag: 'aws', page: '1' }), '?tag=aws&page=1')
  })

  it('reads a strange URL without throwing: repeats take the first value, empty means no filter, tags are trimmed, deduplicated, at most 5', async () => {
    respond({ items: [summary(1)], totalElements: 1, totalPages: 1 })

    const odd = render(
      await SearchPage(
        props({
          category: ['kien-truc', 'khac'],
          series: ['  series-a ', 'khac'],
          tag: [' aws ', 'aws', '', '   ', 'java', 'a', 'b', 'c', 'd'],
          foo: 'bar',
        }),
      ),
    )
    expect(searchContent).toHaveBeenCalledWith(
      {
        q: '',
        type: 'post',
        page: 0,
        size: 10,
        category: 'kien-truc',
        tags: ['aws', 'java', 'a', 'b', 'c'],
        series: 'series-a',
        language: 'vi',
      },
      { clientIp: reader.ip() },
    )
    odd.unmount()

    // All values empty: not a filter (no `tags: []` sent, nothing asked), it is an empty /search with the filter panel open.
    vi.mocked(searchContent).mockClear()
    const { container } = render(await SearchPage(props({ category: '', tag: ['', ' '], series: '  ' })))
    expect(searchContent).not.toHaveBeenCalled()
    expect(screen.getByText(PROMPT)).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: msg('Site.search.active.label') })).not.toBeInTheDocument()
    expect(container.querySelector('form details')).toHaveAttribute('open')

    // With q but all tags empty: still no `tags: []` sent.
    await SearchPage(props({ q: 'queue', tag: ['', ' '] }))
    expect(vi.mocked(searchContent).mock.calls[0]![0].tags).toBeUndefined()
  })

  it('truncates q to 200 characters before calling the API (beyond 200 the backend returns 400), never leaving half an emoji at the cut edge', async () => {
    respond({ items: [], totalElements: 0, totalPages: 0 })

    await SearchPage(props({ q: `  ${'a'.repeat(250)}  ` }))
    expect(vi.mocked(searchContent).mock.calls[0][0].q).toBe('a'.repeat(200))

    // 199 + emoji (2 UTF-16 units) = 201: the edge at 200 falls in the middle of a surrogate pair.
    vi.mocked(searchContent).mockClear()
    await SearchPage(props({ q: `${'a'.repeat(199)}😀b` }))
    expect(vi.mocked(searchContent).mock.calls[0][0].q).toBe('a'.repeat(199))
  })

  it('400 becomes an in-place sentence, not a 500 page; the form and chips stay for editing; other errors still throw', async () => {
    vi.mocked(searchContent).mockRejectedValue(new ApiError(400, 'VALIDATION_ERROR', 'Invalid search'))

    const { container } = render(await SearchPage(props({ q: 'queue', tag: 'aws' })))

    expect(screen.getByRole('alert')).toHaveTextContent(msg('Site.search.badRequest'))
    expect(screen.getByLabelText(msg('Site.search.form.keywordLabel'))).toHaveValue('queue')
    expect(screen.getByRole('link', { name: msg('Site.search.active.remove.tag', { name: 'AWS' }) })).toBeInTheDocument()
    expect(container.querySelectorAll('li > article')).toHaveLength(0)
    expect(screen.queryByText(new RegExp(`${COUNT_ANY.source}|${NO_MATCH_ANY.source}`))).not.toBeInTheDocument()
    expect(getDiscovery).not.toHaveBeenCalled()

    vi.mocked(searchContent).mockRejectedValue(new ApiError(500, 'INTERNAL_ERROR', 'boom'))
    await expect(SearchPage(props({ q: 'queue' }))).rejects.toMatchObject({ name: 'ApiError', status: 500 })
  })

  it('429 (the shared backend ceiling) is an in-place "busy" sentence, not a 500 page; the form stays', async () => {
    vi.mocked(searchContent).mockRejectedValue(new ApiError(429, 'RATE_LIMITED', 'Too many requests'))

    render(await SearchPage(props({ q: 'queue' })))

    expect(screen.getByRole('alert')).toHaveTextContent(msg('Site.search.busy'))
    expect(screen.getByLabelText(msg('Site.search.form.keywordLabel'))).toHaveValue('queue')
  })

  it('an IP that has used up the search allowance (shared with the quick search panel) sees the "busy" sentence, the page does not call the backend', async () => {
    respond({ items: [summary(1)], totalElements: 1, totalPages: 1 })
    for (let i = 0; i < SEARCH_RATE.limit; i += 1) {
      rateLimit(SEARCH_RATE.bucket, reader.ip(), SEARCH_RATE.limit, SEARCH_RATE.windowMs)
    }

    render(await SearchPage(props({ q: 'queue' })))

    expect(screen.getByRole('alert')).toHaveTextContent(msg('Site.search.busy'))
    expect(screen.getByLabelText(msg('Site.search.form.keywordLabel'))).toHaveValue('queue')
    expect(searchContent).not.toHaveBeenCalled()
  })

  it('an unknown IP (misconfigured proxy, a junk X-Forwarded-For) is not exempt: it counts in the shared "unknown" bucket and sees "busy" once that is used up', async () => {
    respond({ items: [summary(1)], totalElements: 1, totalPages: 1 })
    reader.unknown = true // X-Forwarded-For: unknown is not an IP, clientIp returns null

    // Under the shared allowance it is served, and the backend is told the address is unknown (null: only the token travels).
    const { container } = render(await SearchPage(props({ q: 'queue' })))
    expect(searchContent).toHaveBeenCalledTimes(1)
    expect(searchContent).toHaveBeenCalledWith(expect.objectContaining({ q: 'queue' }), { clientIp: null })
    expect(container.querySelectorAll('li > article')).toHaveLength(1)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    // Past it, an unknown IP gets the same "busy" sentence as a known one, without a backend call: no unlimited path for
    // requests that hide their address.
    for (let i = 0; i < 200; i += 1) {
      rateLimit(SEARCH_RATE.bucket, null, SEARCH_RATE.limit, SEARCH_RATE.windowMs)
    }
    render(await SearchPage(props({ q: 'queue' })))
    expect(searchContent).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('alert')).toHaveTextContent(msg('Site.search.busy'))
  })

  it('a page with no search yet does not use up the allowance; each search uses exactly one unit', async () => {
    respond({ items: [summary(1)], totalElements: 1, totalPages: 1 })
    for (let i = 0; i < SEARCH_RATE.limit - 1; i += 1) {
      rateLimit(SEARCH_RATE.bucket, reader.ip(), SEARCH_RATE.limit, SEARCH_RATE.windowMs)
    }

    render(await SearchPage(props()))
    render(await SearchPage(props({ q: 'queue' })))
    expect(searchContent).toHaveBeenCalledTimes(1)

    render(await SearchPage(props({ q: 'queue' })))
    expect(searchContent).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('alert')).toHaveTextContent(msg('Site.search.busy'))
  })

  it('filter lists failing to load: results still show; the filters in use still show by slug and stay selected', async () => {
    respond({ items: [summary(1)], totalElements: 1, totalPages: 1 })
    vi.mocked(getCategories).mockRejectedValue(new Error('categories down'))
    vi.mocked(getTags).mockRejectedValue(new Error('tags down'))
    vi.mocked(getSeriesList).mockRejectedValue(new Error('series down'))

    const { container } = render(await SearchPage(props({ q: 'queue', category: 'kien-truc', tag: 'aws' })))

    expect(container.querySelectorAll('li > article')).toHaveLength(1)
    expect(screen.getByText(msg('Site.search.count.withQuery', { count: 1, query: 'queue' }))).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: msg('Site.search.active.remove.category', { name: 'kien-truc' }) }),
    ).toBeInTheDocument()
    // Without an option for it, the next click on "Search" would silently drop the filter in use.
    expect(screen.getByLabelText(msg('Site.writing.categories'))).toHaveValue('kien-truc')
    expect(screen.getByRole('checkbox', { name: 'aws' })).toBeChecked()
    expect(screen.queryByLabelText('Series')).not.toBeInTheDocument()
  })

  it('filter matching no post: says so clearly, suggests dropping some filters, still has the "Suggested reading" block', async () => {
    respond({ items: [], totalElements: 0, totalPages: 0 })
    vi.mocked(getDiscovery).mockResolvedValue({
      ...NO_DISCOVERY,
      recent: [{ ...summary(8), title: 'Freshly written post', publishedAt: '2026-10-03T18:23:29Z' }],
    })

    const filtersOnly = render(await SearchPage(props({ category: 'kien-truc', tag: 'aws' })))
    expect(screen.getByText(msg('Site.search.noMatch.filtersOnly'))).toBeInTheDocument()
    expect(
      screen.getByText(new RegExp(`^${esc(beforeTag('Site.search.noMatch.retryFilters', 'link').trim())}`)),
    ).toBeInTheDocument()
    expect(getDiscovery).toHaveBeenCalledWith({ context: 'article', language: 'vi' })
    expect(screen.getByRole('region', { name: msg('Site.search.suggestionsTitle') })).toBeInTheDocument()
    filtersOnly.unmount()

    render(await SearchPage(props({ q: 'queue', tag: 'aws' })))
    expect(screen.getByText(msg('Site.search.noMatch.withQueryAndFilters', { query: 'queue' }))).toBeInTheDocument()
    expect(
      screen.getByText(new RegExp(`^${esc(beforeTag('Site.search.noMatch.retryKeywordOrFilters', 'link').trim())}`)),
    ).toBeInTheDocument()
  })
})

describe('/search — primary engine failing, basic search results (degraded)', () => {
  const NOTICE = msg('Site.search.degraded')

  it('one neutral line right below the count sentence, before the list: no alert, no heading, the count sentence unchanged', async () => {
    respond({ items: [summary(1), summary(2)], totalElements: 2, totalPages: 1, degraded: true })

    const { container } = render(await SearchPage(props({ q: 'queue' })))

    const notice = screen.getByText(NOTICE)
    expect(notice.tagName).toBe('P')
    expect(screen.getByText(msg('Site.search.count.withQuery', { count: 2, query: 'queue' })).nextElementSibling).toBe(notice)
    expect(notice.nextElementSibling?.tagName).toBe('UL')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect([...container.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => h.tagName)).toEqual(['H1', 'H2', 'H2'])
    expect(container.querySelectorAll('li > article')).toHaveLength(2)
  })

  it('also present in the no-match state (no match with basic search); the normal engine has none', async () => {
    respond({ items: [], totalElements: 0, totalPages: 0, degraded: true })
    const degraded = render(await SearchPage(props({ q: 'zzzznomatch' })))
    expect(screen.getByText(msg('Site.search.noMatch.withQuery', { query: 'zzzznomatch' })).nextElementSibling).toHaveTextContent(
      NOTICE,
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    degraded.unmount()

    respond({ items: [summary(1)], totalElements: 1, totalPages: 1 })
    render(await SearchPage(props({ q: 'queue' })))
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument()
  })
})

describe('/search — document shape and metadata', () => {
  it('has exactly one h1 and does not render its own <main>', async () => {
    respond({ items: [summary(1)], totalElements: 1, totalPages: 1 })

    const { container } = render(await SearchPage(props({ q: 'queue' })))

    expect(container.querySelectorAll('h1')).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(msg('Site.search.heading'))
    // app/layout.tsx owns the document's single `<main id="main-content">`. Two main
    // landmarks is invalid HTML and makes "skip to main content" ambiguous — the
    // Foundations agent measured exactly that on `/` and /posts/[slug].
    expect(container.querySelector('main')).toBeNull()
  })

  it('does not put a heading above the result rows', async () => {
    respond({ items: [summary(1), summary(2)], totalElements: 2, totalPages: 1 })

    const { container } = render(await SearchPage(props({ q: 'queue' })))

    // PostList's rows are <h2>. A "Results" label here would be their SIBLING, not
    // their parent, so a screen-reader user navigating by heading would hear a heading
    // that owns nothing — and demoting the rows to h3 would break PostList everywhere
    // else. The count lives in a paragraph instead; the h1 names the page.
    const levels = [...container.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => h.tagName)
    expect(levels).toEqual(['H1', 'H2', 'H2'])
  })

  it('declares /search as its canonical and leaves the bare page indexable', async () => {
    const bare = await generateMetadata(props())

    // app/layout.tsx sets `alternates: { canonical: '/' }` and Next INHERITS it into
    // every page that does not override it — verified live on /posts/[slug], which
    // emits <link rel="canonical" href="http://localhost:3000"/>. Without this block
    // /search declares itself a duplicate of the homepage.
    expect(bare.alternates?.canonical).toBe('/search')
    expect(bare.title).toBe(msg('Site.search.heading'))
    // No robots key at all, so the site default applies. An explicit `index: true`
    // would be one more directive to contradict a future site-wide one.
    expect(bare.robots).toBeUndefined()
  })

  /**
   * The route where og:url and the title deliberately disagree, which is why
   * lib/metadata.ts takes a decided canonical rather than deriving one from the request.
   *
   * Before the helper, both branches emitted the homepage's `og:title` and `og:url` —
   * measured — because this page declared no `openGraph` of its own and Next inherits
   * that object whole.
   */
  it('describes ITSELF in the share card, with og:url staying /search for every query', async () => {
    const bare = await generateMetadata(props())
    expect(bare.openGraph?.url).toBe(bare.alternates?.canonical)
    expect(bare.openGraph?.url).toBe('/search')
    expect(bare.openGraph?.title).toBe(msg('Site.search.heading'))
    expect(bare.openGraph?.locale).toBe('vi_VN')

    const searched = await generateMetadata(props({ q: 'queue' }))
    // The title carries the query; the URL does not. A card advertising
    // /search?q=<whatever a stranger submitted> is the thing the noindex exists to stop.
    expect(searched.openGraph?.title).toBe(msg('Site.search.meta.titleWithQuery', { query: 'queue' }))
    expect(searched.openGraph?.url).toBe('/search')
    expect(searched.openGraph?.url).toBe(searched.alternates?.canonical)
    // The robots key survives being spread in alongside the helper's result.
    expect(searched.robots).toEqual({ index: false, follow: true })
  })

  it('refuses to be indexed for a query, while still letting crawlers follow the links', async () => {
    const searched = await generateMetadata(props({ q: 'queue' }))

    expect(searched.title).toBe(msg('Site.search.meta.titleWithQuery', { query: 'queue' }))
    // An indexable search endpoint is how a site fills the index with thin
    // near-duplicates — and, because the query is echoed onto the page, how a site ends
    // up hosting result pages for whatever strangers submit.
    expect(searched.robots).toEqual({ index: false, follow: true })
    // Still canonical to /search, and still NOT to '/': a noindex page with an
    // inherited canonical pointing at the homepage would be telling a crawler both
    // "ignore me" and "credit the homepage for me".
    expect(searched.alternates?.canonical).toBe('/search')
  })

  it('filters only is also noindex (still follow, canonical /search); empty filters are not', async () => {
    for (const searchParams of [{ category: 'kien-truc' }, { tag: ['aws', 'java'] }, { series: 'khong-co' }]) {
      const filtered = await generateMetadata(props(searchParams))
      const label = JSON.stringify(searchParams)
      // A filter page is a thin results page like a page with `q`, and with an unknown slug every URL is an empty page.
      expect(filtered.robots, label).toEqual({ index: false, follow: true })
      expect(filtered.alternates?.canonical, label).toBe('/search')
      expect(filtered.openGraph?.url, label).toBe('/search')
      expect(filtered.title, label).toBe(msg('Site.search.heading'))
    }

    // An empty value is not a filter: still an empty /search, indexable as before.
    const empty = await generateMetadata(props({ category: '', tag: ['', '  '], series: ' ' }))
    expect(empty.robots).toBeUndefined()
  })

  it('does not leak a whitespace query into a noindex', async () => {
    const blank = await generateMetadata(props({ q: '  ' }))

    // '  ' is the no-query state everywhere else on this page; the metadata must agree,
    // or a reader who presses Enter on an empty box lands on a page that quietly
    // de-indexes the only indexable version of /search.
    expect(blank.robots).toBeUndefined()
    expect(blank.title).toBe(msg('Site.search.heading'))
  })

  it('declares the search revalidate window, not the listings one', async () => {
    // 60, not 300: a result set keyed by a reader's query is unbounded in cardinality
    // and lower value to hold. Pinned so the number cannot be copy-pasted back to 300
    // from /writing.
    expect(revalidate).toBe(60)
  })
})
