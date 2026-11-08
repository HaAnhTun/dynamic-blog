import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, NotFoundError } from './api'
import { getCategories, getCategory, getTag, getTags } from './taxonomy'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * `mockImplementation`, not `mockResolvedValue`: the latter hands back the same Response
 * instance on every call, and a Response body can only be read once — the second call
 * in any test below would die with "Body is unusable". lib/api.test.ts learned this the
 * same way.
 */
function stubFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(body, status)))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getCategories', () => {
  it('unwraps the envelope, which has no pagination key', async () => {
    // The exact shape measured off the running backend:
    //   curl -s localhost:8080/api/v1/categories
    // There is no `pagination`; this is the complete list, so there is no second page
    // to miss and no `size` to pass.
    const fetchMock = stubFetch({
      data: [
        { id: 'c1', name: 'Debugging', slug: 'go-loi', description: null },
        { id: 'c2', name: 'Architecture', slug: 'kien-truc', description: 'System design.' },
      ],
    })

    const categories = await getCategories()

    expect(categories).toHaveLength(2)
    expect(categories[0]).toEqual({
      id: 'c1',
      name: 'Debugging',
      slug: 'go-loi',
      description: null,
    })

    const url = new URL(fetchMock.mock.calls[0][0] as string)
    expect(url.pathname).toBe('/api/v1/categories')
    // No query string at all. A `?page=0&size=20` here would silently cap the list at
    // 20 categories and quietly 404 the 21st archive — the endpoint does not paginate.
    expect(url.search).toBe('')
  })

  it('caches for 300 seconds under its own tag, not under "posts"', async () => {
    const fetchMock = stubFetch({ data: [] })

    await getCategories()

    // Nothing else observes these options. Deleting `next` entirely, or widening the
    // tag to 'posts', leaves every other test in this suite green — which is the hole
    // the Task 3 review found in the client's fetch options.
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      next: { revalidate: 300, tags: ['categories'] },
    })
  })

  it('returns an empty list for a 200 whose data is missing or null', async () => {
    for (const body of [{ data: null }, {}]) {
      stubFetch(body)
      // `?? []` rather than a bare `body.data`: handing callers `undefined` would crash
      // in `.find()` on the archive pages and in `.map()` on the filter strip, far from
      // the cause.
      await expect(getCategories()).resolves.toEqual([])
      vi.unstubAllGlobals()
    }
  })

  it('THROWS on a non-2xx instead of returning an empty list', async () => {
    // The single most important behaviour in lib/taxonomy.ts.
    //
    // Both archive pages call these and `notFound()` when the slug is not in the list.
    // If a transport failure came back as `[]`, EVERY category and tag archive would
    // answer 404 for as long as the API was unwell — and 404s get cached. A throw
    // reaches app/error.tsx and says 500, which is the truth: "I could not tell".
    stubFetch({ error: { code: 'INTERNAL', message: 'nope' } }, 500)

    const thrown = await getCategories().then(
      () => null,
      (error: unknown) => error,
    )

    expect(thrown, 'a 500 was swallowed into an empty list').toBeInstanceOf(ApiError)
    expect((thrown as ApiError).status).toBe(500)
    expect((thrown as ApiError).code).toBe('INTERNAL')
    expect((thrown as ApiError).message).toBe('nope')
  })

  it('throws NotFoundError for a 404 so callers can tell it apart', async () => {
    stubFetch({ error: { code: 'NOT_FOUND', message: 'gone' } }, 404)

    await expect(getCategories()).rejects.toBeInstanceOf(NotFoundError)
  })

  it('still throws when the error body is not JSON at all', async () => {
    // A proxy 502 serves HTML. `res.json()` rejects, and without the `.catch(() => ({}))`
    // the rejection that escapes is a SyntaxError about an unexpected token — which
    // tells whoever reads the log nothing about the 502.
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response('<html>502</html>', { status: 502 })))
    vi.stubGlobal('fetch', fetchMock)

    const thrown = await getCategories().then(
      () => null,
      (error: unknown) => error,
    )

    expect(thrown).toBeInstanceOf(ApiError)
    expect((thrown as ApiError).status).toBe(502)
    expect((thrown as ApiError).message).toContain('502')
    expect((thrown as ApiError).message).toContain('/api/v1/categories')
  })
})

describe('getTags', () => {
  it('unwraps the envelope and keeps name and slug separate', async () => {
    // Measured: curl -s localhost:8080/api/v1/tags. A tag has NO description field,
    // and its name and slug differ for most real tags — which is the whole reason the
    // archive route keys on the slug.
    const fetchMock = stubFetch({
      data: [
        { id: 't1', name: 'Lessons', slug: 'bai-hoc' },
        { id: 't2', name: 'CI/CD', slug: 'ci-cd' },
      ],
    })

    const tags = await getTags()

    expect(tags).toEqual([
      { id: 't1', name: 'Lessons', slug: 'bai-hoc' },
      { id: 't2', name: 'CI/CD', slug: 'ci-cd' },
    ])

    const url = new URL(fetchMock.mock.calls[0][0] as string)
    expect(url.pathname).toBe('/api/v1/tags')
    expect(url.search).toBe('')
  })

  it('caches under the "tags" tag, separately from categories', async () => {
    const fetchMock = stubFetch({ data: [] })

    await getTags()

    // Two tags, not one shared one: publishing a post does not create a category, and
    // revalidating one list must not sweep the other — nor may either sit under
    // 'posts', where publishing would sweep both.
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      next: { revalidate: 300, tags: ['tags'] },
    })
  })

  it('THROWS on a non-2xx instead of returning an empty list', async () => {
    stubFetch({ error: { code: 'INTERNAL', message: 'nope' } }, 503)

    await expect(getTags()).rejects.toBeInstanceOf(ApiError)
  })
})

describe('language and the detail helpers', () => {
  it('lists send lang only when a language is given', async () => {
    const fetchMock = stubFetch({ data: [] })

    await getCategories('en')
    await getTags('en')
    await getTags()

    const urls = fetchMock.mock.calls.map((call) => String(call[0]))
    expect(urls[0]).toMatch(/\/api\/v1\/categories\?lang=en$/)
    expect(urls[1]).toMatch(/\/api\/v1\/tags\?lang=en$/)
    expect(urls[2]).toMatch(/\/api\/v1\/tags$/)
  })

  it('getCategory and getTag read the detail by encoded slug, localized, under the list cache tags', async () => {
    const fetchMock = stubFetch({ data: { id: 'c1', name: 'Architecture', slug: 'kien-truc', description: null } })

    const category = await getCategory('kien-truc', 'en')
    await getTag('a/b', 'en')

    expect(category.name).toBe('Architecture')
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/api\/v1\/categories\/kien-truc\?lang=en$/)
    expect(fetchMock.mock.calls[0][1]).toEqual({ next: { revalidate: 300, tags: ['categories'] } })
    expect(String(fetchMock.mock.calls[1][0])).toMatch(/\/api\/v1\/tags\/a%2Fb\?lang=en$/)
  })

  it('an unknown slug is a NotFoundError and another failure an ApiError', async () => {
    stubFetch({ error: { code: 'CATEGORY_NOT_FOUND', message: 'nope' } }, 404)
    await expect(getCategory('khong-co')).rejects.toBeInstanceOf(NotFoundError)

    stubFetch({}, 503)
    await expect(getTag('x')).rejects.toBeInstanceOf(ApiError)
  })
})
