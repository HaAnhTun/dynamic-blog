import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, NotFoundError } from './api'
import { getJson } from './fetch-json'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('getJson', () => {
  it('calls the backend with the right path and the right init, returns the envelope unchanged', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () =>
        jsonResponse({ data: [1, 2], pagination: { page: 0, size: 2, totalElements: 2, totalPages: 1 } }),
      )
    const init = { next: { revalidate: 300, tags: ['x'] } }

    const body = await getJson<number[]>('/api/v1/thu?a=1', init)

    const [url, passed] = fetchSpy.mock.calls[0]!
    expect(new URL(String(url)).pathname).toBe('/api/v1/thu')
    expect(new URL(String(url)).searchParams.get('a')).toBe('1')
    // Pass init through unchanged: the cache window and tag are decisions of each module, not of
    // this transport layer.
    expect(passed).toBe(init)
    expect(body).toEqual({
      data: [1, 2],
      pagination: { page: 0, size: 2, totalElements: 2, totalPages: 1 },
    })
  })

  it('404 becomes the NotFoundError of lib/api, carrying the envelope code', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({ error: { code: 'SERIES_NOT_FOUND', message: 'Series not found', traceId: 't' } }, 404),
    )

    const error = await getJson('/api/v1/series/khong-co', {}).catch((e: unknown) => e)

    // The same class as lib/api.ts, not a same-named duplicate: any page that does `instanceof
    // NotFoundError` to call notFound() must recognize errors from this new module.
    expect(error).toBeInstanceOf(NotFoundError)
    expect(error).toMatchObject({ status: 404, code: 'SERIES_NOT_FOUND', message: 'Series not found' })
  })

  it('an error other than 404 becomes an ApiError, not a NotFoundError', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, 500),
    )

    const error = await getJson('/api/v1/stats', {}).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ApiError)
    expect(error).not.toBeInstanceOf(NotFoundError)
    expect(error).toMatchObject({ status: 500, code: 'INTERNAL_ERROR' })
  })

  it('a non-JSON error body still yields an ApiError whose message names the status and path', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('<html>Bad gateway</html>', { status: 502 }))

    const error = await getJson('/api/v1/gallery', {}).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 502, code: undefined })
    expect((error as Error).message).toContain('502')
    expect((error as Error).message).toContain('/api/v1/gallery')
  })
})
