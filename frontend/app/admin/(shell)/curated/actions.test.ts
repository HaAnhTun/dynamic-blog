// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

// Same mould as posts/actions.test.ts: spies via vi.hoisted, SessionExpiredError is a subclass
// of the real ApiError, the real runAdminAction.
const { setFeaturedOrder, featurePost, unfeaturePost, redirect } = vi.hoisted(() => ({
  setFeaturedOrder: vi.fn(),
  featurePost: vi.fn(),
  unfeaturePost: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;push;${url};307;` })
  }),
}))
vi.mock('@/lib/admin-api', async () => {
  const actual = await import('@/lib/api')
  return {
    setFeaturedOrder,
    featurePost,
    unfeaturePost,
    SessionExpiredError: class SessionExpiredError extends actual.ApiError {
      constructor() {
        super(401, 'UNAUTHENTICATED', 'expired')
      }
    },
  }
})
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  redirect,
}))
vi.mock('next/cache', () => ({ updateTag: vi.fn(), revalidateTag: vi.fn(), revalidatePath: vi.fn() }))

import { updateTag } from 'next/cache'
import { ApiError } from '@/lib/api'
import { SessionExpiredError } from '@/lib/admin-api'
import type { PostSummary } from '@/lib/types'
import { feature, saveCuratedOrder, unfeature } from './actions'
import { msg } from '@/test/render-intl'

const summary = (id: string, over: Partial<PostSummary> = {}): PostSummary => ({
  id,
  title: `Post ${id}`,
  slug: `post-${id}`,
  excerpt: 'A short description that is not sent to the browser.',
  status: 'PUBLISHED',
  category: null,
  tags: [{ id: 't1', name: msg('Site.article.tagsLabel'), slug: 'the' }],
  featured: true,
  readingMinutes: 3,
  publishedAt: '2026-10-03T02:00:00Z',
  featuredRank: null,
  ...over,
})

/** Exactly the part the screen needs, no more: the action result travels to the browser. */
const slim = (p: PostSummary) => ({
  id: p.id,
  title: p.title,
  slug: p.slug,
  status: p.status,
  publishedAt: p.publishedAt,
  featuredRank: p.featuredRank ?? null,
})

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('saveCuratedOrder', () => {
  it('sends the exact id array in order, clears the "posts" cache, returns the list the backend stored', async () => {
    const saved = [summary('b', { featuredRank: 1 }), summary('a', { featuredRank: 2 }), summary('c', { featuredRank: 3 })]
    setFeaturedOrder.mockResolvedValue(saved)

    const result = await saveCuratedOrder(['b', 'a', 'c'])

    expect(setFeaturedOrder).toHaveBeenCalledWith(['b', 'a', 'c'])
    // The "Featured posts" order is read through getPosts({featured}) under the 'posts' tag (home page, /start-here,
    // the Explore block). No per-post tag needed: the post page shows no rank.
    expect(updateTag).toHaveBeenCalledWith('posts')
    expect(updateTag).toHaveBeenCalledTimes(1)
    expect(result).toEqual(saved.map(slim))
  })

  it('400 POST_NOT_FOUND (a post just deleted in another tab) → tells to reload the page, giving the exact reason', async () => {
    // Backend contract (PostService.setFeaturedOrder): any list of posts that still exist is
    // accepted, even one missing posts; 400 POST_NOT_FOUND ONLY when an id is no longer any post.
    // The gallery's "list changed elsewhere" message (a full permutation must be sent) is wrong here.
    setFeaturedOrder.mockRejectedValue(new ApiError(400, 'POST_NOT_FOUND', 'Post not found: 6f1c…'))

    const result = await saveCuratedOrder(['a', 'xoa-roi'])

    expect(result).toEqual({ error: msg('Admin.curated.missingPost') })
    expect(updateTag).not.toHaveBeenCalled()
  })

  it('other errors follow the common table: 403 (AUTHOR) is a permission matter, not a stale list', async () => {
    setFeaturedOrder.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'Access denied'))

    const result = await saveCuratedOrder(['a'])

    expect(result).toEqual({ error: msg('Errors.admin.codes.FORBIDDEN') })
    expect(result).not.toEqual({ error: msg('Admin.curated.missingPost') })
    expect(result).not.toEqual({ error: msg('Errors.admin.staleList') })
  })

  it('400 VALIDATION_ERROR keeps the backend reason (e.g. over 50 posts), not turned into "post no longer exists"', async () => {
    setFeaturedOrder.mockRejectedValue(new ApiError(400, 'VALIDATION_ERROR', 'postIds: size must be between 0 and 50'))

    await expect(saveCuratedOrder(['a'])).resolves.toEqual({
      error: msg('Errors.admin.invalidDetail', { detail: 'postIds: size must be between 0 and 50' }),
    })
  })

  it('session expired → redirects to the login page, no cache clearing', async () => {
    setFeaturedOrder.mockRejectedValue(new SessionExpiredError())

    await expect(saveCuratedOrder(['a'])).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/admin/login')
    expect(updateTag).not.toHaveBeenCalled()
  })
})

describe('feature / unfeature', () => {
  it('feature: picks the post, clears the "posts" cache, returns the post in slim form', async () => {
    const chosen = summary('d', { featuredRank: null })
    featurePost.mockResolvedValue({
      ...chosen,
      content: 'Post body',
      createdAt: 'x',
      updatedAt: 'y',
    })

    const result = await feature('d')

    expect(featurePost).toHaveBeenCalledWith('d')
    expect(updateTag).toHaveBeenCalledWith('posts')
    expect(result).toEqual(slim(chosen))
  })

  it('unfeature: unpicks, clears the "posts" cache, returns the post in slim form', async () => {
    const dropped = summary('a', { featured: false, featuredRank: null })
    unfeaturePost.mockResolvedValue({
      ...dropped,
      content: 'Post body',
      createdAt: 'x',
      updatedAt: 'y',
    })

    const result = await unfeature('a')

    expect(unfeaturePost).toHaveBeenCalledWith('a')
    expect(updateTag).toHaveBeenCalledWith('posts')
    expect(result).toEqual(slim(dropped))
  })

  it('a deleted post (404) → Vietnamese {error}, no cache clearing', async () => {
    unfeaturePost.mockRejectedValue(new ApiError(404, 'POST_NOT_FOUND', 'Post not found'))
    featurePost.mockRejectedValue(new ApiError(404, 'POST_NOT_FOUND', 'Post not found'))

    await expect(unfeature('a')).resolves.toEqual({ error: msg('Errors.admin.codes.POST_NOT_FOUND') })
    await expect(feature('a')).resolves.toEqual({ error: msg('Errors.admin.codes.POST_NOT_FOUND') })
    expect(updateTag).not.toHaveBeenCalled()
  })

  it('session expired → redirects to the login page', async () => {
    featurePost.mockRejectedValue(new SessionExpiredError())
    unfeaturePost.mockRejectedValue(new SessionExpiredError())

    await expect(feature('a')).rejects.toThrow('NEXT_REDIRECT')
    await expect(unfeature('a')).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledTimes(2)
    expect(redirect).toHaveBeenCalledWith('/admin/login')
  })
})
