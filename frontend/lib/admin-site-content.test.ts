// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

const { cookieGet } = vi.hoisted(() => ({ cookieGet: vi.fn() }))
vi.mock('next/headers', () => ({ cookies: async () => ({ get: cookieGet }) }))

import { SessionExpiredError } from './admin-api'
import { ApiError } from './api'
import { fetchExport, getSectionRow, importDocumentText, putSectionRow, restoreRevisionRow } from './admin-site-content'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

afterEach(() => {
  vi.clearAllMocks()
})

describe('admin site content calls', () => {
  it('sends the access token, no caching, and a JSON body only for string bodies', async () => {
    cookieGet.mockReturnValue({ value: 'token-value' })
    fetchMock.mockResolvedValue(json({ data: { key: 'site', locale: 'en', schemaVersion: 1, updatedAt: 'x', payload: {} } }))

    await putSectionRow('site', 'en', { name: 'A' })

    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toMatch(/\/api\/v1\/admin\/site-content\/site\?locale=en$/)
    expect(init.method).toBe('PUT')
    expect(init.cache).toBe('no-store')
    expect(init.headers.authorization).toBe('Bearer token-value')
    expect(init.headers['content-type']).toBe('application/json')
    expect(JSON.parse(init.body)).toEqual({ schemaVersion: 1, payload: { name: 'A' } })
  })

  it('no token means an expired session and no request; a 401 is an expired session too', async () => {
    cookieGet.mockReturnValue(undefined)
    await expect(getSectionRow('site', 'en')).rejects.toBeInstanceOf(SessionExpiredError)
    expect(fetchMock).not.toHaveBeenCalled()

    cookieGet.mockReturnValue({ value: 't' })
    fetchMock.mockResolvedValue(json({ error: { code: 'UNAUTHENTICATED', message: 'no' } }, 401))
    await expect(getSectionRow('site', 'en')).rejects.toBeInstanceOf(SessionExpiredError)
  })

  it('a missing row is null, other errors keep their code and message', async () => {
    cookieGet.mockReturnValue({ value: 't' })
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'SITE_CONTENT_NOT_FOUND', message: 'none' } }, 404))
    await expect(getSectionRow('site', 'en')).resolves.toBeNull()

    fetchMock.mockResolvedValueOnce(json({ error: { code: 'SITE_CONTENT_INVALID', message: '/name: too long' } }, 400))
    const error = await putSectionRow('site', 'en', {}).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 400, code: 'SITE_CONTENT_INVALID', message: '/name: too long' })
  })

  it('builds the restore, import and export requests', async () => {
    cookieGet.mockReturnValue({ value: 't' })
    fetchMock.mockImplementation(async () => json({ data: {} }))

    await restoreRevisionRow('about', 'vi', 12)
    await importDocumentText('{"a":1}')
    await fetchExport('en')

    expect(fetchMock.mock.calls.map(([url, init]) => [String(url).replace(/^.*\/api\/v1/, ''), init?.method ?? 'GET'])).toEqual([
      ['/admin/site-content/about/revisions/12/restore?locale=vi', 'POST'],
      ['/admin/site-content/import', 'POST'],
      ['/admin/site-content/export?locale=en', 'GET'],
    ])
    expect(fetchMock.mock.calls[1]![1].body).toBe('{"a":1}')
  })
})
