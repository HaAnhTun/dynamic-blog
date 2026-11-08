// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PostSummary } from '@/lib/types'

const { listAdminPosts } = vi.hoisted(() => ({ listAdminPosts: vi.fn() }))
vi.mock('@/lib/admin-api', () => ({ listAdminPosts }))

import { everyAdminPost } from './every-admin-post'

// Moved verbatim from series/series.test.ts when the two copies of the function (series.ts and
// curated/page.tsx) were merged into this module.

const post = (id: string): PostSummary => ({
  id,
  title: `Post ${id}`,
  slug: `post-${id}`,
  excerpt: null,
  status: 'PUBLISHED',
  category: null,
  tags: [],
  featured: false,
  readingMinutes: 3,
  publishedAt: '2026-10-03T02:00:00Z',
  series: null,
})

const page = (items: PostSummary[], index: number, totalPages: number) => ({
  items,
  meta: { page: index, size: 100, totalElements: items.length, totalPages },
})

afterEach(() => vi.clearAllMocks())

describe('everyAdminPost', () => {
  it('reads ALL pages, and a post repeated on two pages appears only once', async () => {
    // If the 101st post onwards were dropped it could not be added to a series; a repeated id in the list
    // sent is a 400 VALIDATION_ERROR at the backend.
    const first = Array.from({ length: 100 }, (_, i) => post(`p${i}`))
    listAdminPosts.mockResolvedValueOnce(page(first, 0, 2)).mockResolvedValueOnce(page([post('p99'), post('cuoi')], 1, 2))

    const all = await everyAdminPost()

    expect(listAdminPosts).toHaveBeenNthCalledWith(1, { page: 0, size: 100 })
    expect(listAdminPosts).toHaveBeenNthCalledWith(2, { page: 1, size: 100 })
    expect(listAdminPosts).toHaveBeenCalledTimes(2)
    expect(all).toHaveLength(101)
    expect(all.at(-1)?.id).toBe('cuoi')
  })

  it('stops at an empty page even if totalPages says there are more', async () => {
    listAdminPosts.mockResolvedValueOnce(page([], 0, 5))

    await expect(everyAdminPost()).resolves.toEqual([])
    expect(listAdminPosts).toHaveBeenCalledTimes(1)
  })

  it('no totalPages: stops when the page is not full', async () => {
    listAdminPosts.mockResolvedValueOnce(page([post('a'), post('b')], 0, 0))

    await expect(everyAdminPost()).resolves.toHaveLength(2)
    expect(listAdminPosts).toHaveBeenCalledTimes(1)
  })

  it('the backend keeps reporting a wrong totalPages: stops at the 100-page guard', async () => {
    listAdminPosts.mockImplementation(async ({ page: index }: { page: number }) =>
      page(
        Array.from({ length: 100 }, (_, i) => post(`t${index}-${i}`)),
        index,
        1_000_000,
      ),
    )

    await expect(everyAdminPost()).resolves.toHaveLength(100 * 100)
    expect(listAdminPosts).toHaveBeenCalledTimes(100)
  })
})
