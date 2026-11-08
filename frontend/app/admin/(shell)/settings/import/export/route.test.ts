// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

const { fetchProfileExport } = vi.hoisted(() => ({ fetchProfileExport: vi.fn() }))
vi.mock('@/lib/admin-site-import', () => ({ fetchProfileExport }))
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

const call = (query = '?locale=en') => GET(new Request(`http://localhost:3000/admin/settings/import/export${query}`))

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('GET /admin/settings/import/export', () => {
  it('passes the backend file on as an attachment named after the locale, never cached', async () => {
    const document = '---\nschema_version: 1\n---\n'
    fetchProfileExport.mockResolvedValue(
      new Response(document, { headers: { 'content-disposition': 'attachment; filename="other.md"' } }),
    )

    const res = await call('?locale=vi')

    expect(fetchProfileExport).toHaveBeenCalledWith('vi')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="site-profile-vi.md"')
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await res.text()).toBe(document)
  })

  it('with format=zip asks the backend for the ZIP package and passes it on as a ZIP attachment', async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])
    fetchProfileExport.mockResolvedValue(new Response(bytes, { headers: { 'content-type': 'text/markdown' } }))

    const res = await call('?locale=en&format=zip')

    expect(fetchProfileExport).toHaveBeenCalledWith('en', 'zip')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="site-profile-en.zip"')
    expect(res.headers.get('content-type')).toBe('application/zip')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes)
  })

  it.each(['?locale=en&format=md', '?locale=en&format=', '?locale=en&format=ZIP'])(
    'any other format ("%s") is the Markdown file',
    async (query) => {
      fetchProfileExport.mockResolvedValue(new Response('document'))

      const res = await call(query)

      expect(fetchProfileExport).toHaveBeenCalledWith('en')
      expect(res.headers.get('content-disposition')).toBe('attachment; filename="site-profile-en.md"')
    },
  )

  it('a ZIP request with a bad locale is refused without calling the backend', async () => {
    const res = await call('?locale=fr&format=zip')

    expect(res.status).toBe(400)
    expect(fetchProfileExport).not.toHaveBeenCalled()
  })

  it.each(['', '?locale=fr', '?locale=../etc'])('rejects the query "%s" without calling the backend', async (query) => {
    const res = await call(query)

    expect(res.status).toBe(400)
    expect(await res.text()).toBe(msg('Admin.settings.profileImport.route.badLocale'))
    expect(fetchProfileExport).not.toHaveBeenCalled()
  })

  it('an expired session goes to login, 403 stays 403, anything else is a 502 with no internal text', async () => {
    fetchProfileExport.mockRejectedValueOnce(new SessionExpiredError())
    const expired = await call()
    expect(expired.status).toBe(307)
    expect(expired.headers.get('location')).toBe('http://localhost:3000/admin/login')

    fetchProfileExport.mockRejectedValueOnce(new ApiError(403, 'FORBIDDEN', 'Access denied'))
    const forbidden = await call()
    expect(forbidden.status).toBe(403)
    expect(await forbidden.text()).toBe(msg('Admin.settings.profileImport.route.forbidden'))

    vi.spyOn(console, 'error').mockImplementation(() => {})
    fetchProfileExport.mockRejectedValueOnce(new TypeError('fetch failed'))
    const down = await call()
    expect(down.status).toBe(502)
    expect(await down.text()).toBe(msg('Admin.settings.profileImport.route.unavailable'))
  })
})
