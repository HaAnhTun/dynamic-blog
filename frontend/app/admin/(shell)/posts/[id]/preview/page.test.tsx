import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaRef, Post, SeriesAdmin } from '@/lib/types'

/**
 * The full-page preview of a post, drafts included. Only admin-api is faked: the post body goes
 * through the real `renderMarkdown`, so the table of contents and the heading ids come out of one pipeline like the public page.
 * The fake `notFound`/`redirect` throw an error carrying the target, like the post edit page (edit/page.test.tsx).
 */
const { getAdminPost, getAdminSeries, redirect, notFound, adminRole } = vi.hoisted(() => ({
  getAdminPost: vi.fn(),
  getAdminSeries: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`)
  }),
  notFound: vi.fn(() => {
    throw new Error('NEXT_HTTP_ERROR_FALLBACK;404')
  }),
  adminRole: vi.fn(async (): Promise<string | null> => 'ADMIN'),
}))
vi.mock('@/lib/admin-api', () => ({
  getAdminPost,
  getAdminSeries,
  SessionExpiredError: class SessionExpiredError extends Error {},
}))
vi.mock('@/lib/admin-role', () => ({ adminRole }))
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  redirect,
  notFound,
}))

import { ApiError } from '@/lib/api'
import PostPreviewPage from './page'
import { msg } from '@/test/render-intl'

const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const previewBarName = `${msg('Admin.posts.preview.heading')} ${msg('Admin.posts.preview.savedVersion')}`

const COVER: MediaRef = {
  id: '6f1c2a7e-3b4d-4c5e-8f90-1a2b3c4d5e6f',
  fileName: '6f1c2a7e-3b4d-4c5e-8f90-1a2b3c4d5e6f.jpg',
  width: 1600,
  height: 1067,
  altText: 'White cover with a three queue diagram',
  dominantColor: '#5a6b7c',
}

const post = (over: Partial<Post> = {}): Post => ({
  id: '11111111-1111-1111-1111-111111111111',
  title: 'Draft about queues',
  slug: 'draft-about-queues',
  excerpt: 'A short lead.',
  status: 'DRAFT',
  category: { id: 'c1', name: 'Architecture', slug: 'architecture', description: null },
  tags: [{ id: 't1', name: 'AWS', slug: 'aws' }],
  featured: false,
  readingMinutes: 4,
  publishedAt: null,
  // Three headings: ArticleView only builds the table of contents from MIN_TOC_ENTRIES (3) entries, like the public page.
  content: '## The problem\n\nFirst paragraph.\n\n### Details\n\nSecond paragraph.\n\n## Conclusion\n\nThird paragraph.',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-02T00:00:00Z',
  cover: COVER,
  series: null,
  ...over,
})

async function renderPreview(p: Post) {
  getAdminPost.mockResolvedValue(p)
  return render(await PostPreviewPage({ params: Promise.resolve({ id: p.id }) }))
}

const sendBeacon = vi.fn(() => true)

beforeEach(() => {
  Object.defineProperty(navigator, 'sendBeacon', { value: sendBeacon, configurable: true, writable: true })
})

afterEach(() => {
  vi.clearAllMocks()
  delete (navigator as { sendBeacon?: unknown }).sendBeacon
})

describe('Post preview (admin)', () => {
  it('reads the post through the admin API by the id in the URL, drafts included', async () => {
    await renderPreview(post())

    expect(getAdminPost).toHaveBeenCalledExactlyOnceWith('11111111-1111-1111-1111-111111111111')
    expect(screen.getByRole('heading', { level: 1, name: 'Draft about queues' })).toBeInTheDocument()
  })

  it('as a reader sees it: breadcrumb, lead, cover image, a table of contents pointing at the right ids in the body, the body through prose', async () => {
    const { container } = await renderPreview(post())

    const article = container.querySelector('article')!
    expect(within(article).getByRole('navigation', { name: msg('Site.breadcrumb.label') })).toHaveTextContent('Architecture')
    expect(within(article).getByText('A short lead.')).toBeInTheDocument()
    expect(within(article).getByRole('img', { name: COVER.altText! })).toBeInTheDocument()
    // Exactly one table of contents: the inline, closed <details> (the preview has no reading rail).
    expect(article.querySelectorAll('nav[data-toc]')).toHaveLength(1)
    expect(article.querySelectorAll('ul[data-toc-list]')).toHaveLength(0)
    const toc = within(article).getByRole('navigation', { name: msg('Site.article.toc') })
    expect(toc.querySelector('details')).not.toHaveAttribute('open')
    // The preview has no rail to take the list over, so the inline nav must never be hidden at the rail breakpoint.
    expect(toc).not.toHaveClass('rail:hidden')
    expect(toc.querySelector('#muc-luc')).not.toBeNull()
    const links = within(toc).getAllByRole('link')
    expect(links.map((link) => link.textContent)).toEqual(['The problem', 'Details', 'Conclusion'])
    for (const link of links) {
      const id = decodeURIComponent(link.getAttribute('href')!.slice(1))
      expect(article.querySelector(`[id="${id}"]`), `target of ${id}`).not.toBeNull()
    }
    expect(article.querySelector('div.prose')).toHaveTextContent('Second paragraph.')
    expect(article.querySelector('div.prose')).toHaveAttribute('data-post-body')
    expect(article.querySelector('div.prose')).not.toHaveAttribute('id')
  })

  it('top bar: "Preview (saved version)", status, post edit link; a draft has no public link', async () => {
    await renderPreview(post())

    const bar = screen.getByRole('region', { name: previewBarName })
    expect(within(bar).getByText(msg('Admin.statuses.post.DRAFT'))).toBeInTheDocument()
    expect(within(bar).getByRole('link', { name: msg('Admin.posts.preview.edit') })).toHaveAttribute(
      'href',
      '/admin/posts/11111111-1111-1111-1111-111111111111/edit',
    )
    expect(within(bar).getByRole('link', { name: msg('Site.about.readNextLinks.writing') })).toHaveAttribute('href', '/admin')
    // /posts/<draft> is a 404 for readers: there is never a link to it.
    expect(screen.queryByRole('link', { name: new RegExp(esc(msg('Admin.posts.preview.viewOnBlog'))) })).toBeNull()
    expect(document.querySelector('a[href^="/posts/"]')).toBeNull()
    // The bar comes before the post: that is what a screen reader meets before the title.
    expect(bar.compareDocumentPosition(screen.getByRole('heading', { level: 1 })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('a published post: adds "View on blog" in a new tab', async () => {
    await renderPreview(post({ status: 'PUBLISHED', publishedAt: '2026-10-03T02:00:00Z' }))

    const bar = screen.getByRole('region', { name: previewBarName })
    expect(within(bar).getByText(msg('Admin.statuses.post.PUBLISHED'))).toBeInTheDocument()
    const live = within(bar).getByRole('link', {
      name: `${msg('Admin.posts.preview.viewOnBlog')} ${msg('Admin.posts.preview.newTab')}`,
    })
    expect(live).toHaveAttribute('href', '/posts/draft-about-queues')
    expect(live).toHaveAttribute('target', '_blank')
    expect(live).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('nothing meant only for real readers: no JSON-LD, like button, share, author box, beacon, comments', async () => {
    const { container } = await renderPreview(post({ status: 'PUBLISHED', publishedAt: '2026-10-03T02:00:00Z' }))

    expect(container.querySelector('script[type="application/ld+json"]')).toBeNull()
    expect(screen.queryByRole('button', { name: new RegExp(esc(msg('Site.comments.like.countLabel', { n: 2 }))) })).toBeNull()
    // The author box is an <aside> named by the author; "Author" is only an eyebrow, not a heading.
    expect(screen.queryByRole('complementary')).toBeNull()
    expect(container.querySelector('#binh-luan')).toBeNull()
    expect(sendBeacon).not.toHaveBeenCalled()

    // And in the source: a convenient moment of adding a public island to this page fails right here,
    // not waiting until it counts a fake view or sends the JSON-LD of a draft.
    const source = readFileSync(join(process.cwd(), 'app/admin/(shell)/posts/[id]/preview/page.tsx'), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/LikeButton|ViewBeacon|ShareBar|CommentSection|ArticleJsonLd|BreadcrumbJsonLd|AuthorBox/)
    // No robots metadata of its own: the noindex of the whole admin branch is in app/admin/layout.tsx.
    expect(code).not.toMatch(/\brobots\b/)
  })

  it('a post in a series: the series block as after publishing, with the published parts and this very draft', async () => {
    const series: SeriesAdmin = {
      id: 's1',
      title: 'Queues from scratch',
      slug: 'queues-from-scratch',
      description: null,
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
      posts: [
        { id: 'a', title: msg('Site.series.part', { number: 'intro' }), slug: 'part-intro', status: 'PUBLISHED', position: 1 },
        { id: 'b', title: 'Another draft', slug: 'another-draft', status: 'DRAFT', position: 2 },
        {
          id: '11111111-1111-1111-1111-111111111111',
          title: 'Draft about queues',
          slug: 'draft-about-queues',
          status: 'DRAFT',
          position: 3,
        },
      ],
    }
    getAdminSeries.mockResolvedValue(series)

    await renderPreview(
      post({
        series: {
          id: 's1',
          slug: 'queues-from-scratch',
          title: 'Queues from scratch',
          position: 3,
          partNumber: null,
          partCount: null,
        },
      }),
    )

    expect(getAdminSeries).toHaveBeenCalledWith('s1')
    const block = screen.getByRole('navigation', { name: 'Queues from scratch' })
    // Another draft is not shown to readers, so it is not counted: this post is part 2/2.
    expect(block).toHaveTextContent(msg('Site.seriesBlock.partOf', { current: '2', total: '2' }))
    expect(
      within(block).getByRole('link', { name: new RegExp(esc(msg('Site.series.part', { number: 'intro' }))) }),
    ).toHaveAttribute('href', '/posts/part-intro')
    expect(within(block).queryByText('Another draft')).toBeNull()
    expect(within(block).getByText(msg('Site.seriesBlock.currentPart'))).toBeInTheDocument()
  })

  it('series cannot be read: hides the series block, the page still shows', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    getAdminSeries.mockRejectedValue(new ApiError(500, 'INTERNAL_ERROR', 'boom'))

    await renderPreview(
      post({
        series: {
          id: 's1',
          slug: 'queues-from-scratch',
          title: 'Queues from scratch',
          position: 1,
          partNumber: null,
          partCount: null,
        },
      }),
    )

    expect(screen.getByRole('heading', { level: 1, name: 'Draft about queues' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Queues from scratch' })).toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('post does not exist (404) → the 404 page, not an error page', async () => {
    getAdminPost.mockRejectedValue(new ApiError(404, 'POST_NOT_FOUND', 'Post not found'))

    await expect(PostPreviewPage({ params: Promise.resolve({ id: 'p404' }) })).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404')
    expect(notFound).toHaveBeenCalledTimes(1)
  })

  it('session expired while loading → to the login page', async () => {
    const { SessionExpiredError } = await import('@/lib/admin-api')
    getAdminPost.mockRejectedValue(new SessionExpiredError())

    await expect(PostPreviewPage({ params: Promise.resolve({ id: 'p1' }) })).rejects.toThrow('NEXT_REDIRECT /admin/login')
    expect(redirect).toHaveBeenCalledWith('/admin/login')
  })

  // Pinned on purpose: a 403 no longer reaches error.tsx; for AUTHOR, neither does a 404.
  it('403, or an AUTHOR 404: "Cannot open this post" with a way back to the list, no public 404, no login', async () => {
    getAdminPost.mockRejectedValueOnce(new ApiError(403, 'FORBIDDEN', 'Access denied'))
    const forbidden = render(await PostPreviewPage({ params: Promise.resolve({ id: 'p1' }) }))
    expect(screen.getByText(msg('Admin.common.noAccess.post.title'))).toBeInTheDocument()
    expect(screen.getByRole('link', { name: msg('Site.about.readNextLinks.writing') })).toHaveAttribute('href', '/admin')
    forbidden.unmount()

    adminRole.mockResolvedValueOnce('AUTHOR')
    getAdminPost.mockRejectedValueOnce(new ApiError(404, 'POST_NOT_FOUND', 'Post not found'))
    render(await PostPreviewPage({ params: Promise.resolve({ id: 'p1' }) }))
    expect(screen.getByText(msg('Admin.common.noAccess.post.title'))).toBeInTheDocument()

    expect(notFound).not.toHaveBeenCalled()
    expect(redirect).not.toHaveBeenCalled()
  })

  it('server down: continues to error.tsx, where "Retry" makes sense', async () => {
    getAdminPost.mockRejectedValue(new ApiError(503, undefined, 'down'))

    await expect(PostPreviewPage({ params: Promise.resolve({ id: 'p1' }) })).rejects.toThrow('down')
    expect(notFound).not.toHaveBeenCalled()
  })
})
