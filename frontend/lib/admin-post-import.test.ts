// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

const { cookieGet } = vi.hoisted(() => ({ cookieGet: vi.fn() }))
vi.mock('next/headers', () => ({ cookies: async () => ({ get: cookieGet }) }))

import { SessionExpiredError } from './admin-api'
import { ApiError } from './api'
import { applyPostFiles, fetchPostTemplate, previewPostArticle, previewPostFiles } from './admin-post-import'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const first = new File(['---\ntitle: One\n---\nBody\n'], 'one.md', { type: 'text/markdown' })
const second = new File(['---\ntitle: Two\n---\nBody\n'], 'two.md', { type: 'text/markdown' })

afterEach(() => {
  vi.clearAllMocks()
})

describe('admin post import calls', () => {
  it('previews with one file part per file in order, the token and no caching, and sets no content type itself', async () => {
    cookieGet.mockReturnValue({ value: 'token-value' })
    fetchMock.mockResolvedValue(json({ data: { files: [], filesWithProblems: [] } }))

    const preview = await previewPostFiles([first, second])

    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toMatch(/\/api\/v1\/admin\/post-import\/preview$/)
    expect(init.method).toBe('POST')
    expect(init.cache).toBe('no-store')
    expect(init.headers.authorization).toBe('Bearer token-value')
    expect(init.headers['content-type']).toBeUndefined()
    const parts = (init.body as FormData).getAll('file') as File[]
    expect(parts.map((part) => part.name)).toEqual(['one.md', 'two.md'])
    expect((init.body as FormData).has('manifest')).toBe(false)
    expect(preview.filesWithProblems).toEqual([])
  })

  it('asks for the article of one file with a single file part and the token, and returns the data', async () => {
    cookieGet.mockReturnValue({ value: 'token-value' })
    fetchMock.mockResolvedValue(json({ data: { fileName: 'one.md', body: 'Body', bodyLine: 4, assets: [] } }))

    const article = await previewPostArticle(first)

    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toMatch(/\/api\/v1\/admin\/post-import\/article-preview$/)
    expect(init.method).toBe('POST')
    expect(init.cache).toBe('no-store')
    expect(init.headers.authorization).toBe('Bearer token-value')
    expect(((init.body as FormData).getAll('file') as File[]).map((part) => part.name)).toEqual(['one.md'])
    expect(article).toMatchObject({ body: 'Body', bodyLine: 4 })
  })

  it('apply sends the file parts in order plus exactly one manifest part with one item per file', async () => {
    cookieGet.mockReturnValue({ value: 't' })
    fetchMock.mockResolvedValue(json({ data: { importId: 3, files: [] } }))
    const manifest = [
      { sha256: 'a'.repeat(64), selected: true, state: 'bmV3fHx8' },
      { sha256: 'b'.repeat(64), selected: false, state: null },
    ]

    await applyPostFiles({ files: [first, second], manifest })

    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toMatch(/\/post-import\/apply$/)
    const form = init.body as FormData
    expect((form.getAll('file') as File[]).map((part) => part.name)).toEqual(['one.md', 'two.md'])
    expect(form.getAll('manifest')).toHaveLength(1)
    expect(JSON.parse(form.get('manifest') as string)).toEqual(manifest)
  })

  it('the template is a plain GET that returns the raw response with the language in the query', async () => {
    cookieGet.mockReturnValue({ value: 't' })
    fetchMock.mockResolvedValueOnce(new Response('---\n---\n'))

    const res = await fetchPostTemplate('vi')

    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/\/post-import\/template\?language=vi$/)
    expect(fetchMock.mock.calls[0]![1].method).toBeUndefined()
    expect(await res.text()).toBe('---\n---\n')
  })

  it('a missing token or a 401 is an expired session; other failures keep the code and status', async () => {
    cookieGet.mockReturnValue(undefined)
    await expect(previewPostFiles([first])).rejects.toBeInstanceOf(SessionExpiredError)
    expect(fetchMock).not.toHaveBeenCalled()

    cookieGet.mockReturnValue({ value: 't' })
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'UNAUTHENTICATED', message: 'expired' } }, 401))
    await expect(previewPostFiles([first])).rejects.toBeInstanceOf(SessionExpiredError)

    fetchMock.mockResolvedValueOnce(json({ error: { code: 'POST_IMPORT_PREVIEW_OUT_OF_DATE', message: '2 posts' } }, 409))
    await expect(applyPostFiles({ files: [first], manifest: [] })).rejects.toMatchObject({
      status: 409,
      code: 'POST_IMPORT_PREVIEW_OUT_OF_DATE',
    })
  })

  it('an answer without a body is a 502, not a crash', async () => {
    cookieGet.mockReturnValue({ value: 't' })
    fetchMock.mockResolvedValueOnce(json({}))

    await expect(previewPostFiles([first])).rejects.toBeInstanceOf(ApiError)
  })
})
