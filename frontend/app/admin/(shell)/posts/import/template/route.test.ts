// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

const { fetchPostTemplate } = vi.hoisted(() => ({ fetchPostTemplate: vi.fn() }))
vi.mock('@/lib/admin-post-import', () => ({ fetchPostTemplate }))
vi.mock('@/lib/admin-api', async () => {
  const actual = await import('@/lib/api')
  return {
    SessionExpiredError: class SessionExpiredError extends actual.ApiError {
      constructor() {
        super(401, 'UNAUTHENTICATED', 'expired')
      }
    },
  }
})

import { SessionExpiredError } from '@/lib/admin-api'
import { ApiError } from '@/lib/api'
import { msg } from '@/test/render-intl'
import { GET } from './route'

const call = (query = '?locale=en') => GET(new Request(`http://localhost:3000/admin/posts/import/template${query}`))

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('GET /admin/posts/import/template', () => {
  it('passes the backend file on as an attachment named after the locale, never cached', async () => {
    const document = '---\ntitle: Example\n---\nBody\n'
    fetchPostTemplate.mockResolvedValue(
      new Response(document, { headers: { 'content-disposition': 'attachment; filename="other.md"' } }),
    )

    const res = await call('?locale=vi')

    expect(fetchPostTemplate).toHaveBeenCalledWith('vi')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="post-import-template-vi.md"')
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await res.text()).toBe(document)
  })

  it.each(['', '?locale=fr', '?locale=../etc'])('rejects the query "%s" without calling the backend', async (query) => {
    const res = await call(query)

    expect(res.status).toBe(400)
    expect(await res.text()).toBe(msg('Admin.posts.import.route.badLocale'))
    expect(fetchPostTemplate).not.toHaveBeenCalled()
  })

  it('an expired session goes to login, 403 stays 403, anything else is a 502 with no internal text', async () => {
    fetchPostTemplate.mockRejectedValueOnce(new SessionExpiredError())
    const expired = await call()
    expect(expired.status).toBe(307)
    expect(expired.headers.get('location')).toBe('http://localhost:3000/admin/login')

    fetchPostTemplate.mockRejectedValueOnce(new ApiError(403, 'FORBIDDEN', 'Access denied'))
    const forbidden = await call()
    expect(forbidden.status).toBe(403)
    expect(await forbidden.text()).toBe(msg('Admin.posts.import.route.forbidden'))

    vi.spyOn(console, 'error').mockImplementation(() => {})
    fetchPostTemplate.mockRejectedValueOnce(new TypeError('fetch failed'))
    const down = await call()
    expect(down.status).toBe(502)
    expect(await down.text()).toBe(msg('Admin.posts.import.route.unavailable'))
  })
})
