import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './api'
import { getGallery } from './gallery'
import type { GalleryPhoto } from './types'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const PHOTO: GalleryPhoto = {
  id: 'g1',
  image: {
    id: '0b9a5a4e-7c1d-4f7e-8f52-3c1e2d9a6b10',
    fileName: '0b9a5a4e-7c1d-4f7e-8f52-3c1e2d9a6b10.jpg',
    width: 1200,
    height: 800,
    altText: 'A road',
    dominantColor: '#2f4858',
  },
  caption: null,
  takenOn: '2026-09-14',
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('getGallery', () => {
  it('sends page and size, returns items and meta from the paged envelope', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () =>
        jsonResponse({ data: [PHOTO], pagination: { page: 1, size: 24, totalElements: 25, totalPages: 2 } }),
      )

    const page = await getGallery({ page: 1, size: 24 })

    const url = new URL(String(fetchSpy.mock.calls[0]![0]))
    expect(url.pathname).toBe('/api/v1/gallery')
    expect(url.searchParams.get('page')).toBe('1')
    expect(url.searchParams.get('size')).toBe('24')
    expect(page).toEqual({ items: [PHOTO], meta: { page: 1, size: 24, totalElements: 25, totalPages: 2 } })
  })

  it('caches for 300 seconds under exactly one gallery tag', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () =>
        jsonResponse({ data: [], pagination: { page: 0, size: 6, totalElements: 0, totalPages: 0 } }),
      )

    await getGallery({ page: 0, size: 6 })

    // No posts tag: uploading a photo publishes no post, and publishing a post does not change the gallery.
    expect(fetchSpy.mock.calls[0]![1]).toEqual({ next: { revalidate: 300, tags: ['gallery'] } })
  })

  it('a missing pagination or null data still yields a valid empty page', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({ data: null }))

    await expect(getGallery({ page: 2, size: 24 })).resolves.toEqual({
      items: [],
      meta: { page: 2, size: 24, totalElements: 0, totalPages: 0 },
    })
  })

  it('a backend error throws ApiError so the caller decides to hide the block', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 500 }))

    await expect(getGallery({ page: 0, size: 6 })).rejects.toBeInstanceOf(ApiError)
  })
})
