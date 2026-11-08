// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

/*
 * "Download ZIP" (the default) and the legacy seed Markdown (`?format=md`): the route handler is an ordinary async function, called
 * directly with a Request and context; admin-api is mocked, no server is started.
 */
const { getAdminPost, fetchAdminPostExport } = vi.hoisted(() => ({ getAdminPost: vi.fn(), fetchAdminPostExport: vi.fn() }))
vi.mock('@/lib/admin-api', async () => {
  const actual = await import('@/lib/api')
  return {
    getAdminPost,
    fetchAdminPostExport,
    SessionExpiredError: class SessionExpiredError extends actual.ApiError {
      constructor() {
        super(401, 'UNAUTHENTICATED', 'expired')
      }
    },
  }
})

import { SessionExpiredError } from '@/lib/admin-api'
import { ApiError } from '@/lib/api'
import type { Post } from '@/lib/types'
import { msg } from '@/test/render-intl'
import { GET } from './route'

const POST: Post = {
  id: 'p1',
  title: 'From API Gateway to SQS',
  slug: 'from-api-gateway-to-sqs',
  language: 'en',
  translations: [{ language: 'vi', slug: 'tu-api-gateway-den-sqs', title: 'Ban vi', status: 'PUBLISHED' }],
  excerpt: 'Why I chose async.',
  status: 'DRAFT',
  category: { id: 'c1', name: 'Architecture', slug: 'architecture', description: null },
  tags: [{ id: 't1', name: 'AWS', slug: 'aws' }],
  featured: false,
  readingMinutes: 3,
  publishedAt: null,
  content: '## Introduction\n\nParagraph one.\n',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-02T00:00:00Z',
}

function call(id = 'p1', query = '') {
  return GET(new Request(`http://localhost:3000/admin/posts/${id}/export${query}`), { params: Promise.resolve({ id }) })
}

const callMarkdown = (id = 'p1') => call(id, '?format=md')

/** The bytes of a small ZIP: not valid content, the route must pass any bytes on untouched. */
const ZIP_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00, 0x80, 0x0a, 0x0d])

function backendZip(init: ResponseInit = {}) {
  return new Response(ZIP_BYTES, {
    status: 200,
    headers: { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="the-post.zip"' },
    ...init,
  })
}

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('GET /admin/posts/[id]/export (the ZIP package)', () => {
  it('passes the backend ZIP on as an attachment with the name the backend sent, uncached, no sniffing, bytes intact', async () => {
    fetchAdminPostExport.mockResolvedValue(backendZip())

    const res = await call()

    expect(fetchAdminPostExport).toHaveBeenCalledWith('p1')
    // The ZIP comes from the backend: the post itself is not read here.
    expect(getAdminPost).not.toHaveBeenCalled()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/zip')
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="the-post.zip"')
    // An author's draft, read with their session: no browser, proxy or CDN may keep it.
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(ZIP_BYTES)
  })

  it('an unknown or empty format value is the ZIP too, only format=md is the Markdown', async () => {
    fetchAdminPostExport.mockImplementation(async () => backendZip())

    for (const query of ['?format=zip', '?format=', '?format=MD']) {
      const res = await call('p1', query)
      expect(res.headers.get('content-type'), query).toBe('application/zip')
    }
    expect(getAdminPost).not.toHaveBeenCalled()
  })

  it('a missing or odd file name from the backend becomes a safe .zip name, never a quote or line break', async () => {
    fetchAdminPostExport.mockResolvedValueOnce(backendZip({ headers: { 'content-type': 'application/zip' } }))
    expect((await call()).headers.get('content-disposition')).toBe('attachment; filename="bai-viet.zip"')

    fetchAdminPostExport.mockResolvedValueOnce(
      backendZip({ headers: { 'content-disposition': 'attachment; filename="a b/../c.exe"' } }),
    )
    expect((await call()).headers.get('content-disposition')).toBe('attachment; filename="a-b-c-exe.zip"')
  })

  it('session expired → redirects to the login page', async () => {
    fetchAdminPostExport.mockRejectedValue(new SessionExpiredError())

    const res = await call()

    expect([303, 307]).toContain(res.status)
    expect(new URL(res.headers.get('location')!).pathname).toBe('/admin/login')
  })

  it('post does not exist (404) → 404 with the translated text, uncached, no attachment', async () => {
    fetchAdminPostExport.mockRejectedValue(new ApiError(404, 'POST_NOT_FOUND', 'Post not found: p1'))

    const res = await call()

    expect(res.status).toBe(404)
    expect(await res.text()).toBe(msg('Admin.posts.exportRoute.notFound'))
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('content-disposition')).toBeNull()
  })

  it("403 (another author's post) stays 403 with the translated text, not turned into 404 or the login page", async () => {
    fetchAdminPostExport.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'Access denied'))

    const res = await call()

    expect(res.status).toBe(403)
    expect(await res.text()).toBe(msg('Admin.posts.exportRoute.forbidden'))
    expect(res.headers.get('location')).toBeNull()
  })

  it('a package over the limits (413) → 413 with the translated text, not a 502', async () => {
    fetchAdminPostExport.mockRejectedValue(new ApiError(413, 'POST_EXPORT_TOO_LARGE', 'too large'))

    const res = await call()

    expect(res.status).toBe(413)
    expect(await res.text()).toBe(msg('Admin.posts.exportRoute.tooLarge'))
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('content-disposition')).toBeNull()
  })

  it('backend unreachable or any other failure → 502 with the translated text, the original error logged', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cause = new TypeError('fetch failed')
    fetchAdminPostExport.mockRejectedValue(cause)

    const res = await call()

    expect(res.status).toBe(502)
    expect(await res.text()).toBe(msg('Admin.posts.exportRoute.unavailable'))
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(log).toHaveBeenCalledWith(expect.any(String), cause)

    fetchAdminPostExport.mockRejectedValue(new ApiError(500, 'INTERNAL_ERROR', 'boom'))
    expect((await call()).status).toBe(502)
  })
})

describe('GET /admin/posts/[id]/export?format=md (the legacy seed Markdown)', () => {
  it('downloads the file <slug>.md in the seed/push.py format, uncached, no sniffing', async () => {
    getAdminPost.mockResolvedValue(POST)

    const res = await callMarkdown()

    expect(getAdminPost).toHaveBeenCalledWith('p1')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="from-api-gateway-to-sqs.md"')
    // An author's draft: no browser, proxy or CDN may keep it.
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    const body = await res.text()
    expect(body.startsWith('---\n')).toBe(true)
    expect(body).toContain('\ntitle: From API Gateway to SQS\n')
    expect(body).toContain('\nstatus: DRAFT\n')
    // The file carries what the post import needs: the slug, the language and the published translation.
    expect(body).toContain('\nslug: from-api-gateway-to-sqs\n')
    expect(body).toContain('\nlanguage: en\n')
    expect(body).toContain('\ntranslation_of: tu-api-gateway-den-sqs\n')
    expect(body.endsWith('\n---\n\n## Introduction\n\nParagraph one.\n')).toBe(true)
  })

  it('a post without a published translation has no translation_of line', async () => {
    getAdminPost.mockResolvedValue({ ...POST, translations: [] })

    const body = await (await callMarkdown()).text()

    expect(body).toContain('\nlanguage: en\n')
    expect(body).not.toContain('translation_of')
  })

  it('session expired → redirects to the login page', async () => {
    getAdminPost.mockRejectedValue(new SessionExpiredError())

    const res = await callMarkdown()

    expect([303, 307]).toContain(res.status)
    expect(new URL(res.headers.get('location')!).pathname).toBe('/admin/login')
  })

  it('post does not exist (404) → 404, uncached, not a 500 error page', async () => {
    getAdminPost.mockRejectedValue(new ApiError(404, 'POST_NOT_FOUND', 'Post not found: p1'))

    const res = await callMarkdown()

    expect(res.status).toBe(404)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('content-disposition')).toBeNull()
  })

  it("403 (another author's post) stays 403, not turned into 404 or the login page", async () => {
    getAdminPost.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'Access denied'))

    const res = await callMarkdown()

    expect(res.status).toBe(403)
    expect(res.headers.get('location')).toBeNull()
  })

  it('backend unreachable → 502, with the original error logged', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cause = new TypeError('fetch failed')
    getAdminPost.mockRejectedValue(cause)

    const res = await callMarkdown()

    expect(res.status).toBe(502)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(log).toHaveBeenCalledWith(expect.any(String), cause)
  })

  it('an odd slug (corrupt data) lets no quote or line break into the header', async () => {
    getAdminPost.mockResolvedValue({ ...POST, slug: 'a"b\r\nc' })

    const res = await callMarkdown()

    expect(res.headers.get('content-disposition')).toBe('attachment; filename="a-b-c.md"')
  })
})
