import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './api'
import { getPopularPosts } from './popular'
import type { PostSummary } from './types'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function post(n: number, viewCount: number): PostSummary {
  return {
    id: `p${n}`,
    title: `Post ${n}`,
    slug: `bai-${n}`,
    excerpt: null,
    status: 'PUBLISHED',
    category: null,
    tags: [],
    featured: false,
    readingMinutes: 3,
    publishedAt: '2026-10-03T00:00:00Z',
    viewCount,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('getPopularPosts', () => {
  it('sends lang when a language is given', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({ data: [] }))

    await getPopularPosts(6, 'en')
    await getPopularPosts(6)

    expect(new URL(String(fetchSpy.mock.calls[0]![0])).searchParams.get('lang')).toBe('en')
    expect(new URL(String(fetchSpy.mock.calls[1]![0])).searchParams.has('lang')).toBe(false)
  })

  it('asks for the post list with sort=popular, first page, right size', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () =>
        jsonResponse({ data: [post(1, 40), post(2, 12)], pagination: { page: 0, size: 6, totalElements: 2, totalPages: 1 } }),
      )

    const posts = await getPopularPosts(6)

    const url = new URL(String(fetchSpy.mock.calls[0]![0]))
    // A query param, not the path /posts/popular: that path would hide a post whose slug is "popular".
    expect(url.pathname).toBe('/api/v1/posts')
    expect(url.searchParams.get('sort')).toBe('popular')
    expect(url.searchParams.get('page')).toBe('0')
    expect(url.searchParams.get('size')).toBe('6')
    // Combining popular with a filter is a 400 at the backend: no filter may be sent along.
    expect(url.searchParams.has('category')).toBe(false)
    expect(url.searchParams.has('tag')).toBe(false)
    expect(url.searchParams.has('featured')).toBe(false)
    expect(posts.map((p) => p.slug)).toEqual(['bai-1', 'bai-2'])
  })

  it('caches 300 seconds under the posts tag only, with no tag for views to empty', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({ data: [] }))

    await getPopularPosts(5)

    expect(fetchSpy.mock.calls[0]![1]).toEqual({ next: { revalidate: 300, tags: ['posts'] } })
  })

  it('null data becomes an empty array', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({ data: null }))

    await expect(getPopularPosts(5)).resolves.toEqual([])
  })

  it('a backend error throws ApiError', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({ error: { code: 'VALIDATION_ERROR', message: 'bad sort' } }, 400),
    )

    await expect(getPopularPosts(5)).rejects.toBeInstanceOf(ApiError)
  })
})
