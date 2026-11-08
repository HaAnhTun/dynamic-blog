import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, NotFoundError } from './api'
import { getSeries, getSeriesList } from './series'
import type { SeriesDetail, SeriesSummary } from './types'
import { SLUG_TIENG_VIET } from '@/test/fixtures/vi/accented-text'
import { msg } from '@/test/render-intl'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const SUMMARY: SeriesSummary = {
  id: 's1',
  title: 'A test series',
  slug: 'mot-series-thu',
  description: null,
  postCount: 2,
  readingMinutes: 9,
  latestPublishedAt: '2026-10-03T18:23:29.838073Z',
  parts: [
    { slug: 'phan-mot', title: 'Part one' },
    { slug: 'phan-hai', title: 'Part two' },
  ],
}

const DETAIL: SeriesDetail = {
  id: 's1',
  title: 'A test series',
  slug: 'mot-series-thu',
  description: msg('Admin.topics.manager.descriptionLabel'),
  posts: [],
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('getSeriesList', () => {
  it('reads /api/v1/series and returns the list inside the envelope', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({ data: [SUMMARY] }))

    const list = await getSeriesList()

    expect(new URL(String(fetchSpy.mock.calls[0]![0])).pathname).toBe('/api/v1/series')
    expect(list).toEqual([SUMMARY])
  })

  it('caches 300 seconds under the two tags series and posts', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({ data: [] }))

    await getSeriesList()

    // Two tags, because two things change the result: editing a series (tag series) and publishing/unpublishing a post
    // (tag posts) — a series only shows when it has a published part.
    expect(fetchSpy.mock.calls[0]![1]).toEqual({ next: { revalidate: 300, tags: ['series', 'posts'] } })
  })

  it('sends lang=<language> and keeps the cache tags', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({ data: [SUMMARY] }))

    await getSeriesList('en')

    expect(new URL(String(fetchSpy.mock.calls[0]![0])).search).toBe('?lang=en')
    expect(fetchSpy.mock.calls[0]![1]).toEqual({ next: { revalidate: 300, tags: ['series', 'posts'] } })
  })

  it('null data becomes an empty array instead of undefined', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({ data: null }))

    await expect(getSeriesList()).resolves.toEqual([])
  })

  it('a backend error throws ApiError, not swallowed into an empty list', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 503 }))

    await expect(getSeriesList()).rejects.toBeInstanceOf(ApiError)
  })
})

describe('getSeries', () => {
  it('reads /api/v1/series/{slug} with the same cache as the list', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({ data: DETAIL }))

    const detail = await getSeries('mot-series-thu')

    expect(new URL(String(fetchSpy.mock.calls[0]![0])).pathname).toBe('/api/v1/series/mot-series-thu')
    expect(fetchSpy.mock.calls[0]![1]).toEqual({ next: { revalidate: 300, tags: ['series', 'posts'] } })
    expect(detail).toEqual(DETAIL)
  })

  it('sends lang=<language> on the detail too', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({ data: DETAIL }))

    await getSeries('mot-series-thu', 'en')

    expect(new URL(String(fetchSpy.mock.calls[0]![0])).pathname + new URL(String(fetchSpy.mock.calls[0]![0])).search).toBe(
      '/api/v1/series/mot-series-thu?lang=en',
    )
  })

  it('encodes the slug so an odd slug from the URL cannot escape the series path', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({ data: DETAIL }))

    await getSeries('../../admin/users')
    await getSeries(SLUG_TIENG_VIET)

    const paths = fetchSpy.mock.calls.map((call) => new URL(String(call[0])).pathname)
    expect(paths).toEqual(['/api/v1/series/..%2F..%2Fadmin%2Fusers', '/api/v1/series/ti%E1%BA%BFng-vi%E1%BB%87t'])
  })

  it('404 becomes NotFoundError so the page calls notFound()', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({ error: { code: 'SERIES_NOT_FOUND', message: 'Series not found' } }, 404),
    )

    await expect(getSeries('khong-co')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('500 is ApiError, not NotFoundError: a sick backend must not become a 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, 500),
    )

    const error = await getSeries('mot-series-thu').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ApiError)
    expect(error).not.toBeInstanceOf(NotFoundError)
  })
})
