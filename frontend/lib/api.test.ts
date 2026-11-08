import { afterEach, describe, expect, it, vi } from 'vitest'
import { GREETING_XIN, SEARCH_CATEGORY, SLUG_BAI_VIET, SLUG_TIENG_VIET } from '@/test/fixtures/vi/accented-text'
import { ApiError, NotFoundError, getPost, getPostRedirect, getPosts } from './api'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getPosts', () => {
  it('unwraps the envelope into items and meta', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [{ id: '1', title: GREETING_XIN, slug: 'xin-chao', excerpt: null, category: null, tags: [], publishedAt: null }],
        pagination: { page: 0, size: 20, totalElements: 1, totalPages: 1 },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await getPosts({ page: 0, size: 20 })

    expect(result.items).toHaveLength(1)
    expect(result.items[0].title).toBe(GREETING_XIN)
    expect(result.meta.totalPages).toBe(1)
  })

  it('sends page, size and the filters it was given', async () => {
    // mockImplementation, not mockResolvedValue: the latter hands back the same
    // Response instance every call, and a Response body can only be read once, so
    // the second getPosts below would die with "Body is unusable".
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse({ data: [], pagination: { page: 2, size: 5, totalElements: 0, totalPages: 0 } })),
      )
    vi.stubGlobal('fetch', fetchMock)

    await getPosts({ page: 2, size: 5, category: SEARCH_CATEGORY })

    const url = new URL(fetchMock.mock.calls[0][0] as string)
    expect(url.pathname).toBe('/api/v1/posts')
    expect(url.searchParams.get('page')).toBe('2')
    expect(url.searchParams.get('size')).toBe('5')
    expect(url.searchParams.get('category')).toBe(SEARCH_CATEGORY)
    expect(url.searchParams.has('tag')).toBe(false)

    // `has('tag') === false` above would also hold if the tag branch did not exist
    // at all, so it pins nothing on its own. Send one and check it arrives.
    await getPosts({ page: 0, size: 10, tag: 'cong-nghe' })

    const tagged = new URL(fetchMock.mock.calls[1][0] as string)
    expect(tagged.searchParams.get('tag')).toBe('cong-nghe')
    expect(tagged.searchParams.has('category')).toBe(false)
  })

  it('asks for the cache behaviour the module claims to ask for', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: [], pagination: { page: 0, size: 20, totalElements: 0, totalPages: 0 } }))
    vi.stubGlobal('fetch', fetchMock)

    await getPosts({ page: 0, size: 20 })

    // The revalidate window and the tag list are deliberate, documented choices
    // and nothing else observes them: changing 300 to any
    // other number, or renaming the tag, leaves every other test green.
    expect(fetchMock.mock.calls[0][1]).toEqual({
      next: { revalidate: 300, tags: ['posts'] },
    })
  })

  it('raises ApiError carrying the status and the envelope code on a 500', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'boom', traceId: 't' } }, 500)),
    )

    await expect(getPosts({ page: 0, size: 20 })).rejects.toMatchObject({
      name: 'ApiError',
      status: 500,
      code: 'INTERNAL_ERROR',
    })
  })
})

describe('getPost', () => {
  it('percent-encodes a Vietnamese slug into the request URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          id: '1',
          title: 'T',
          slug: SLUG_TIENG_VIET,
          content: '# T',
          status: 'PUBLISHED',
          excerpt: null,
          category: null,
          tags: [],
          publishedAt: null,
          createdAt: '',
          updatedAt: '',
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await getPost(SLUG_TIENG_VIET)

    expect(fetchMock.mock.calls[0][0]).toContain('/api/v1/posts/ti%E1%BA%BFng-vi%E1%BB%87t')
  })

  // Additional case: a decoded slug can legitimately contain
  // '/', '..' and NUL — '%2Fetc%2Fpasswd' decodes to '/etc/passwd' — and that is safe
  // only because getPost wraps the slug in encodeURIComponent. Unencoded, the URL
  // parser resolves '../../admin' to /api/admin, escaping the posts path entirely.
  it('keeps a slug containing slashes, dot segments or NUL inside the posts path', async () => {
    const fetchMock = vi.fn().mockImplementation(() => jsonResponse({ data: { slug: 'x' } }))
    vi.stubGlobal('fetch', fetchMock)

    for (const slug of ['/etc/passwd', '../../admin', 'a\u0000b']) {
      await getPost(slug)
    }

    const paths = fetchMock.mock.calls.map((call) => new URL(call[0] as string).pathname)
    expect(paths).toEqual(['/api/v1/posts/%2Fetc%2Fpasswd', '/api/v1/posts/..%2F..%2Fadmin', '/api/v1/posts/a%00b'])
    for (const path of paths) {
      expect(path.startsWith('/api/v1/posts/')).toBe(true)
    }
  })

  it('raises NotFoundError on the backend 404 envelope rather than reading undefined', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(jsonResponse({ error: { code: 'POST_NOT_FOUND', message: 'Post not found', traceId: 't' } }, 404)),
    )

    await expect(getPost('missing')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('raises ApiError, not NotFoundError, on a 503', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })))

    const error = await getPost('x').catch((e) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).not.toBeInstanceOf(NotFoundError)
    expect(error.status).toBe(503)
  })

  // Additional case: an error body that is not JSON at all makes res.json() reject.
  // Verified by mutation that dropping the `.catch(() => ({}))` lets that SyntaxError
  // escape in place of an ApiError, so this pins both the catch and the fallback
  // message that stands in when the envelope carries none.
  it('falls back to a generated message when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>502</html>', { status: 502 })))

    const error = await getPost('x').catch((e) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error.code).toBeUndefined()
    expect(error.message).toBe('API responded 502 for /api/v1/posts/x')
  })
})

/**
 * Old path of a published post. The backend contract:
 * `GET /api/v1/posts/{slug}/redirect` → 200 `{"data":{"slug":"<current slug>"}}` only when `slug` is
 * an old slug of a post that is PUBLISHED, otherwise 404 POST_NOT_FOUND.
 */
describe('getPostRedirect', () => {
  it('returns the current slug of the post the old path points to', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: { slug: 'duong-dan-moi' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(getPostRedirect('duong-dan-cu')).resolves.toBe('duong-dan-moi')
    expect(new URL(fetchMock.mock.calls[0][0] as string).pathname).toBe('/api/v1/posts/duong-dan-cu/redirect')
  })

  it('same cache as getPost: revalidate 300, tag "posts" and the tag of the slug asked about', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: { slug: 'moi' } }))
    vi.stubGlobal('fetch', fetchMock)

    await getPostRedirect('cu')

    // Saving a post in admin calls updateTag('posts'): a slug change (or change back) refreshes this
    // answer together with the post itself, not letting an old redirect live five more minutes.
    expect(fetchMock.mock.calls[0][1]).toEqual({ next: { revalidate: 300, tags: ['posts', 'post-cu'] } })
  })

  it('404 means "no post ever had this path": null, not an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(jsonResponse({ error: { code: 'POST_NOT_FOUND', message: 'Post not found', traceId: 't' } }, 404)),
    )

    await expect(getPostRedirect('khong-ton-tai')).resolves.toBeNull()
  })

  it('a backend without the endpoint (404 ENDPOINT_NOT_FOUND) is also null: an unknown slug is still a 404, not a 500', async () => {
    // Measured on a backend running at :8080 before the redirect endpoint: an unmatched route returns 404 ENDPOINT_NOT_FOUND
    // (GlobalExceptionHandler.handleFrameworkClientError). When the frontend ships before the backend every
    // unknown slug goes through exactly this branch.
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ error: { code: 'ENDPOINT_NOT_FOUND', message: 'The requested endpoint does not exist' } }, 404),
        ),
    )

    await expect(getPostRedirect('khong-ton-tai')).resolves.toBeNull()
  })

  it('an error other than 404 passes through intact: an incident must not become "the post does not exist"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })))

    const error = await getPostRedirect('cu').catch((e) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).not.toBeInstanceOf(NotFoundError)
    expect(error.status).toBe(503)
  })

  it('a returned body without a usable slug: null, no redirect to "/posts/" or "/posts/undefined"', async () => {
    for (const data of [{}, { slug: '' }, { slug: 42 }, null]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ data })))
      await expect(getPostRedirect('cu'), JSON.stringify(data)).resolves.toBeNull()
    }
  })

  it('encodes the slug like getPost: a slug with "/", ".." or NUL still stays within /api/v1/posts/…/redirect', async () => {
    const fetchMock = vi.fn().mockImplementation(() => jsonResponse({ data: { slug: 'x' } }))
    vi.stubGlobal('fetch', fetchMock)

    for (const slug of ['/etc/passwd', '../../admin', 'a\u0000b', SLUG_BAI_VIET]) {
      await getPostRedirect(slug)
    }

    expect(fetchMock.mock.calls.map((call) => new URL(call[0] as string).pathname)).toEqual([
      '/api/v1/posts/%2Fetc%2Fpasswd/redirect',
      '/api/v1/posts/..%2F..%2Fadmin/redirect',
      '/api/v1/posts/a%00b/redirect',
      `/api/v1/posts/${encodeURIComponent(SLUG_BAI_VIET)}/redirect`,
    ])
  })
})
