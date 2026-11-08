// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

const { fetchExport } = vi.hoisted(() => ({ fetchExport: vi.fn() }))
vi.mock('@/lib/admin-site-content', () => ({ fetchExport }))
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

const call = (query = '?locale=en') => GET(new Request(`http://localhost:3000/admin/settings/export${query}`))

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('GET /admin/settings/export', () => {
  it('passes the backend document on as an attachment named after the locale, never cached', async () => {
    const document = '{"format":"site-content","formatVersion":1,"locale":"en","sections":{}}'
    fetchExport.mockResolvedValue(
      new Response(document, { headers: { 'content-disposition': 'attachment; filename="other.json"' } }),
    )

    const res = await call()

    expect(fetchExport).toHaveBeenCalledWith('en')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="site-content-en.json"')
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.text()).toBe(document)
  })

  it('rejects an unknown locale without calling the backend', async () => {
    const res = await call('?locale=../etc')

    expect(res.status).toBe(400)
    expect(await res.text()).toBe(msg('Admin.settings.exportRoute.badLocale'))
    expect(fetchExport).not.toHaveBeenCalled()
  })

  it('an expired session goes to login, 403 stays 403, anything else is a 502 with no internal text', async () => {
    fetchExport.mockRejectedValueOnce(new SessionExpiredError())
    const expired = await call()
    expect(expired.status).toBe(307)
    expect(expired.headers.get('location')).toBe('http://localhost:3000/admin/login')

    fetchExport.mockRejectedValueOnce(new ApiError(403, 'FORBIDDEN', 'Access denied'))
    const forbidden = await call()
    expect(forbidden.status).toBe(403)
    expect(await forbidden.text()).toBe(msg('Admin.settings.exportRoute.forbidden'))

    vi.spyOn(console, 'error').mockImplementation(() => {})
    fetchExport.mockRejectedValueOnce(new TypeError('fetch failed'))
    const down = await call()
    expect(down.status).toBe(502)
    expect(await down.text()).toBe(msg('Admin.settings.exportRoute.unavailable'))
  })
})
