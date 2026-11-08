import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './api'
import { getStats } from './stats'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('getStats', () => {
  it('reads /api/v1/stats and returns the data part', async () => {
    const stats = { publishedPosts: 7, totalViews: 31, seriesCount: 1, galleryPhotos: 0 }
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({ data: stats }))

    await expect(getStats()).resolves.toEqual(stats)
    expect(new URL(String(fetchSpy.mock.calls[0]![0])).pathname).toBe('/api/v1/stats')
  })

  it('caches 300 seconds under the tags stats and posts', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () =>
        jsonResponse({ data: { publishedPosts: 0, totalViews: 0, seriesCount: 0, galleryPhotos: 0 } }),
      )

    await getStats()

    // The posts tag so publishing a post updates the post count at once; no tag is tied to views —
    // the view total is allowed to lag up to 300 seconds instead of emptying the cache after every read.
    expect(fetchSpy.mock.calls[0]![1]).toEqual({ next: { revalidate: 300, tags: ['stats', 'posts'] } })
  })

  it('a backend error throws ApiError', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 503 }))

    await expect(getStats()).rejects.toBeInstanceOf(ApiError)
  })
})
