import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Post } from '@/lib/types'
import { getPost, getPosts } from '@/lib/api'
import { getDiscovery } from '@/lib/discovery'
import { renderMarkdown } from '@/lib/markdown'
import { getSeries } from '@/lib/series'
import PostPage from './page'

/**
 * A separate file because it needs `@/lib/markdown` mocked, and every other test of this
 * page deliberately runs the real pipeline so that the table of contents and the rendered
 * body are the genuine article.
 *
 * What it pins: a failure inside the Markdown pipeline must reach the error boundary
 * rather than be turned into a page. Adding `.catch(() => ({ content: null, toc: [] }))`
 * to the `renderMarkdown` call — the obvious way to "make the page resilient" — leaves
 * every other test in the suite green and ships HTTP 200 with an empty article body,
 * which is the worst of both: the reader sees a post that appears to have no content, and
 * nothing anywhere reports a problem.
 */
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  getPost: vi.fn(),
  getPosts: vi.fn(),
}))

/**
 * `getPosts` is left with no implementation ON PURPOSE here, unlike in page.test.tsx.
 *
 * The page now awaits several things at once — `renderMarkdown`, the related posts and
 * the prev/next links (both read `fetchAllPublishedPosts()`, which pages through
 * `getPosts`, the full-list loader) — and the two listing helpers swallow their own failures by
 * design. The question this file asks is whether that swallowing can reach the
 * Markdown error, and the sharpest way to ask it is to let both listings fail too: an
 * un-stubbed mock resolves `undefined`, which fetchAllPublishedPosts destructures and
 * throws on, and each helper catches. The fixture carries a tag so that the related-posts
 * helper really reads the list (with nothing to compare it returns early). If
 * `Promise.all` were ever replaced by something that reported the wrong rejection, or if
 * the page grew a `.catch` of its own, the first test below would stop seeing `failure`
 * identically.
 */

vi.mock('@/lib/markdown', () => ({ renderMarkdown: vi.fn() }))

/** LeftRail is an async Server Component that Testing Library cannot render; this file is about the Markdown pipeline only. */
vi.mock('@/components/site/reader/LeftRail', () => ({ LeftRail: () => null }))

/**
 * The two new secondary sources of the page (the post series, the "What to read next" block) are also made to FAIL here,
 * for the same reason as `getPosts` above: the question of this file is whether a Markdown error is still an error that reaches
 * the error boundary when every secondary source also fails at the same time. The post in the fixture belongs to
 * a series, so that the getSeries call really happens. The real versions of both hit the network, so mocking
 * is mandatory; `importOriginal` keeps `shouldShowViews` and the constants of lib/discovery.
 */
vi.mock('@/lib/series', () => ({ getSeries: vi.fn(), getSeriesList: vi.fn() }))
vi.mock('@/lib/discovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/discovery')>()),
  getDiscovery: vi.fn(),
}))

beforeEach(() => {
  vi.mocked(getSeries).mockRejectedValue(new Error('series API down'))
  vi.mocked(getDiscovery).mockRejectedValue(new Error('discovery down'))
  // The page logs a warning line when it hides the series block; here that is intended, not noise.
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  return () => warn.mockRestore()
})

const post: Post = {
  id: 'p1',
  title: 'Problem statement',
  slug: 'dat-van-de',
  excerpt: null,
  content: '## Problem statement\n\nOne paragraph.',
  status: 'PUBLISHED',
  category: null,
  // One tag: enough for the real getRelatedPosts to actually read the list (and fail with it), see the note above.
  tags: [{ id: 't1', name: 'AWS', slug: 'aws' }],
  publishedAt: '2026-09-28T17:30:00Z',
  featured: false,
  readingMinutes: 1,
  createdAt: '2026-09-28T17:30:00Z',
  updatedAt: '2026-09-28T17:30:00Z',
  series: { id: 's1', slug: 'series-a', title: 'Series A', position: 1, partNumber: 1, partCount: 2 },
}

/**
 * Built as the generated `PageProps` rather than a bare `{ params }`, which is what the
 * guard in page.tsx is for: my first version of this file passed only `params` and tsc
 * rejected it, while vitest ran the tests green.
 */
function props(slug: string): PageProps<'/[locale]/posts/[slug]'> {
  return { params: Promise.resolve({ locale: 'vi', slug }), searchParams: Promise.resolve({}) }
}

describe('PostPage when the Markdown pipeline fails', () => {
  it('lets the failure propagate instead of serving an empty article', async () => {
    vi.mocked(getPost).mockResolvedValue(post)
    const failure = new Error('shiki grammar failed to load')
    vi.mocked(renderMarkdown).mockRejectedValue(failure)

    await expect(PostPage(props('dat-van-de'))).rejects.toBe(failure)
    // The secondary sources were really asked and really failed: the Markdown error wins not because they
    // had not run yet. Three list reads: related posts, previous/next posts and the left rail.
    expect(getSeries).toHaveBeenCalledWith('series-a', 'vi')
    expect(getDiscovery).toHaveBeenCalled()
    expect(getPosts).toHaveBeenCalledTimes(3)
  })

  it('renders the article when the pipeline succeeds, so the above is discriminating', async () => {
    vi.mocked(getPost).mockResolvedValue(post)
    vi.mocked(renderMarkdown).mockResolvedValue({
      content: <p>One paragraph.</p>,
      toc: [{ depth: 2, id: 'dat-van-de', text: 'Problem statement' }],
      problems: [],
    })

    const { container } = render(await PostPage(props('dat-van-de')))

    expect(container.querySelector('.prose')).not.toBeNull()
    expect(screen.getByText('One paragraph.')).toBeInTheDocument()
  })
})
