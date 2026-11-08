import { render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PostSummary } from '@/lib/types'

const { listAdminPosts, redirect, adminRole } = vi.hoisted(() => ({
  listAdminPosts: vi.fn(),
  redirect: vi.fn(() => {
    throw new Error('NEXT_REDIRECT')
  }),
  adminRole: vi.fn(async (): Promise<string | null> => 'ADMIN'),
}))
vi.mock('@/lib/admin-api', () => ({
  listAdminPosts,
  SessionExpiredError: class SessionExpiredError extends Error {},
}))
vi.mock('@/lib/admin-role', () => ({ adminRole }))
vi.mock('next/navigation', () => ({ redirect }))
// The action file is 'use server' and pulls in next/cache; the page only passes them down to the client.
vi.mock('./actions', () => ({ saveCuratedOrder: vi.fn(), feature: vi.fn(), unfeature: vi.fn() }))

import { ApiError } from '@/lib/api'
import CuratedPage from './page'
import { msg } from '@/test/render-intl'

const post = (id: string, over: Partial<PostSummary> = {}): PostSummary => ({
  id,
  title: `Post ${id}`,
  slug: `bai-${id}`,
  excerpt: null,
  status: 'PUBLISHED',
  category: null,
  tags: [],
  featured: false,
  readingMinutes: 3,
  publishedAt: '2026-10-03T02:00:00Z',
  featuredRank: null,
  ...over,
})

const page = (items: PostSummary[], index: number, totalPages: number) => ({
  items,
  meta: { page: index, size: 100, totalElements: items.length, totalPages },
})

const listedTitles = () =>
  within(screen.getByRole('list', { name: msg('Admin.curated.orderLabel') }))
    .getAllByRole('listitem')
    .map((li) => li.querySelector('[data-title]')?.textContent)

const candidateTitles = () =>
  within(screen.getByLabelText(msg('Admin.series.parts.addLabel')))
    .getAllByRole('option')
    .filter((o) => (o as HTMLOptionElement).value !== '')
    .map((o) => o.textContent)

afterEach(() => vi.clearAllMocks())

describe('/admin/curated', () => {
  it('picked posts by rank; unranked after, newest published first, drafts last (as the backend)', async () => {
    // The order arriving from the admin API is createdAt descending, not rank.
    listAdminPosts.mockResolvedValue(
      page(
        [
          post('nhap', { featured: true, status: 'DRAFT', publishedAt: null }),
          post('cu', { featured: true, publishedAt: '2026-09-01T00:00:00Z' }),
          post('hai', { featured: true, featuredRank: 2 }),
          post('moi', { featured: true, publishedAt: '2026-10-05T00:00:00Z' }),
          post('mot', { featured: true, featuredRank: 1 }),
        ],
        0,
        1,
      ),
    )

    render(await CuratedPage())

    expect(screen.getByRole('heading', { level: 1, name: msg('Site.footer.links.startHere') })).toBeInTheDocument()
    // Exactly PostRepository.findAllFeaturedByRank: rank ASC NULLS LAST, published_at DESC NULLS LAST.
    expect(listedTitles()).toEqual(['Post mot', 'Post hai', 'Post moi', 'Post cu', 'Post nhap'])
  })

  it('"Add post" lists only published posts not yet picked, newest first', async () => {
    listAdminPosts.mockResolvedValue(
      page(
        [
          post('chon', { featured: true, featuredRank: 1 }),
          post('nhap', { status: 'DRAFT', publishedAt: null }),
          post('luu-tru', { status: 'ARCHIVED' }),
          post('cu', { publishedAt: '2026-09-01T00:00:00Z' }),
          post('moi', { publishedAt: '2026-10-05T00:00:00Z' }),
        ],
        0,
        1,
      ),
    )

    render(await CuratedPage())

    // Drafts, archived posts and picked posts are all absent: adding a draft to "Featured posts" is
    // a rank nobody sees, and a picked post is already in the list above.
    expect(candidateTitles()).toEqual(['Post moi', 'Post cu'])
  })

  it('reads ALL pages of the admin list, not only the first', async () => {
    // One page of 100 posts: a 101st post that gets dropped cannot be added, and a picked post
    // on a later page vanishes from the screen and then loses its rank on the next save.
    const first = Array.from({ length: 100 }, (_, i) => post(`p${i}`))
    listAdminPosts
      .mockResolvedValueOnce(page(first, 0, 2))
      .mockResolvedValueOnce(page([post('tre', { featured: true, featuredRank: 1 })], 1, 2))

    render(await CuratedPage())

    expect(listAdminPosts).toHaveBeenNthCalledWith(1, { page: 0, size: 100 })
    expect(listAdminPosts).toHaveBeenNthCalledWith(2, { page: 1, size: 100 })
    expect(listAdminPosts).toHaveBeenCalledTimes(2)
    expect(listedTitles()).toEqual(['Post tre'])
    expect(candidateTitles()).toHaveLength(100)
  })

  it('a post repeated on two pages (a newly created post pushes the list down) appears only once', async () => {
    // A duplicate id in the list sent is a 400 VALIDATION_ERROR at the backend, and a duplicate key in React.
    const shifted = post('bien', { featured: true, featuredRank: 1 })
    listAdminPosts
      .mockResolvedValueOnce(page([...Array.from({ length: 99 }, (_, i) => post(`p${i}`)), shifted], 0, 2))
      .mockResolvedValueOnce(page([shifted, post('cuoi')], 1, 2))

    render(await CuratedPage())

    expect(listedTitles()).toEqual(['Post bien'])
    expect(candidateTitles()).toHaveLength(100)
  })

  it('stops at an empty page even if totalPages says there are more', async () => {
    listAdminPosts.mockResolvedValueOnce(page([], 0, 5))

    render(await CuratedPage())

    expect(listAdminPosts).toHaveBeenCalledTimes(1)
    expect(screen.getByText(msg('Site.startHere.empty'))).toBeInTheDocument()
  })

  it('session expired while loading the page → to the login page', async () => {
    const { SessionExpiredError } = await import('@/lib/admin-api')
    listAdminPosts.mockRejectedValue(new SessionExpiredError())

    await expect(CuratedPage()).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/admin/login')
  })

  it('another error (backend down) is not turned into a redirect to the login page', async () => {
    listAdminPosts.mockRejectedValue(new Error('fetch failed'))

    await expect(CuratedPage()).rejects.toThrow('fetch failed')
    expect(redirect).not.toHaveBeenCalled()
  })

  it('not ADMIN: AUTHOR does not call the backend; a 403 from a stale token is also the admin-only page', async () => {
    adminRole.mockResolvedValueOnce('AUTHOR')
    const author = render(await CuratedPage())
    expect(screen.getByRole('heading', { level: 1, name: msg('Site.footer.links.startHere') })).toBeInTheDocument()
    expect(screen.getByText(msg('Admin.common.adminOnly.title'))).toBeInTheDocument()
    // The post list stays open to AUTHOR (their own posts): calling would draw a ranking screen with no usable button.
    expect(listAdminPosts).not.toHaveBeenCalled()
    author.unmount()

    listAdminPosts.mockRejectedValueOnce(new ApiError(403, 'FORBIDDEN', 'Access denied'))
    render(await CuratedPage())
    expect(screen.getByText(msg('Admin.common.adminOnly.title'))).toBeInTheDocument()
    expect(redirect).not.toHaveBeenCalled()
  })
})
