// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

const { cookieGet } = vi.hoisted(() => ({ cookieGet: vi.fn() }))
vi.mock('next/headers', () => ({ cookies: async () => ({ get: cookieGet }) }))

import { SessionExpiredError } from './admin-api'
import { ApiError } from './api'
import { applyImport, fetchProfileExport, fetchTemplate, getImportStatus, previewFile, undoImport } from './admin-site-import'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const file = new File(['# Site\n'], 'profile.md', { type: 'text/markdown' })

afterEach(() => {
  vi.clearAllMocks()
})

describe('admin site import calls', () => {
  it('previews with a multipart body, the token and no caching, and sets no content type itself', async () => {
    cookieGet.mockReturnValue({ value: 'token-value' })
    fetchMock.mockResolvedValue(json({ data: { sha256: 'a'.repeat(64), sections: [] } }))

    const preview = await previewFile(file)

    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toMatch(/\/api\/v1\/admin\/site-import\/preview$/)
    expect(init.method).toBe('POST')
    expect(init.cache).toBe('no-store')
    expect(init.headers.authorization).toBe('Bearer token-value')
    expect(init.headers['content-type']).toBeUndefined()
    expect(init.body).toBeInstanceOf(FormData)
    expect((init.body as FormData).get('file')).toBeInstanceOf(File)
    expect(preview.sha256).toBe('a'.repeat(64))
  })

  it('apply sends the file, the hash, the mode and one field per chosen section', async () => {
    cookieGet.mockReturnValue({ value: 't' })
    fetchMock.mockResolvedValue(json({ data: { importId: 3, locale: 'en', mode: 'update', sections: [] } }))

    await applyImport({ file, sha256: 'b'.repeat(64), mode: 'update', sections: ['identity', 'skills'] })

    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toMatch(/\/site-import\/apply$/)
    const form = init.body as FormData
    expect(form.get('sha256')).toBe('b'.repeat(64))
    expect(form.get('mode')).toBe('update')
    expect(form.getAll('sections')).toEqual(['identity', 'skills'])
  })

  it('undo and status are plain requests; the downloads return the raw response with the locale in the query', async () => {
    cookieGet.mockReturnValue({ value: 't' })
    fetchMock.mockResolvedValueOnce(json({ data: { importId: 1, locale: 'vi', sections: [] } }))
    await undoImport(12)
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/\/site-import\/undo\?importId=12$/)
    expect(fetchMock.mock.calls[0]![1].method).toBe('POST')
    expect(fetchMock.mock.calls[0]![1].body).toBeUndefined()

    fetchMock.mockResolvedValueOnce(json({ data: { lastImport: null } }))
    await expect(getImportStatus()).resolves.toEqual({ lastImport: null })
    expect(String(fetchMock.mock.calls[1]![0])).toMatch(/\/site-import\/status$/)

    const raw = new Response('# file')
    fetchMock.mockResolvedValueOnce(raw)
    await expect(fetchTemplate('vi')).resolves.toBe(raw)
    expect(String(fetchMock.mock.calls[2]![0])).toMatch(/\/site-import\/template\?locale=vi$/)

    fetchMock.mockResolvedValueOnce(new Response('# file'))
    await fetchProfileExport('en')
    expect(String(fetchMock.mock.calls[3]![0])).toMatch(/\/site-import\/export\?locale=en$/)

    fetchMock.mockResolvedValueOnce(new Response('zip'))
    await fetchProfileExport('vi', 'zip')
    expect(String(fetchMock.mock.calls[4]![0])).toMatch(/\/site-import\/export\?locale=vi&format=zip$/)
  })

  it('no token means an expired session and no request; a 401 is an expired session too', async () => {
    cookieGet.mockReturnValue(undefined)
    await expect(getImportStatus()).rejects.toBeInstanceOf(SessionExpiredError)
    expect(fetchMock).not.toHaveBeenCalled()

    cookieGet.mockReturnValue({ value: 't' })
    fetchMock.mockResolvedValue(json({ error: { code: 'UNAUTHENTICATED', message: 'no' } }, 401))
    await expect(getImportStatus()).rejects.toBeInstanceOf(SessionExpiredError)
  })

  it('undo needs a positive safe integer id and sends no request without one', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) expect(() => undoImport(bad)).toThrow(RangeError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('other errors keep their status, code and message; an empty answer is a 502', async () => {
    cookieGet.mockReturnValue({ value: 't' })
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'SITE_IMPORT_HASH_MISMATCH', message: 'changed' } }, 409))
    await expect(undoImport(3)).rejects.toMatchObject({ status: 409, code: 'SITE_IMPORT_HASH_MISMATCH', message: 'changed' })

    fetchMock.mockResolvedValueOnce(new Response('', { status: 200 }))
    const error = await getImportStatus().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBe(502)
  })
})
