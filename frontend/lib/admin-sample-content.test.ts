// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

const { cookieGet } = vi.hoisted(() => ({ cookieGet: vi.fn() }))
vi.mock('next/headers', () => ({ cookies: async () => ({ get: cookieGet }) }))

import { SessionExpiredError } from './admin-api'
import { requestSampleContent } from './admin-sample-content'
import { ApiError } from './api'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

afterEach(() => {
  vi.clearAllMocks()
})

describe('requestSampleContent', () => {
  it('posts with the token and no caching, and returns the counts', async () => {
    cookieGet.mockReturnValue({ value: 'token-value' })
    fetchMock.mockResolvedValue(json({ data: { posts: 4, series: 1, categories: 1, tags: 2, skipped: 0 } }))

    const result = await requestSampleContent()

    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toMatch(/\/api\/v1\/admin\/sample-content$/)
    expect(init.method).toBe('POST')
    expect(init.cache).toBe('no-store')
    expect(init.headers.authorization).toBe('Bearer token-value')
    expect(result).toEqual({ posts: 4, series: 1, categories: 1, tags: 2, skipped: 0 })
  })

  it('without a session cookie it is a SessionExpiredError and nothing is sent', async () => {
    cookieGet.mockReturnValue(undefined)

    await expect(requestSampleContent()).rejects.toBeInstanceOf(SessionExpiredError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('401 is SessionExpiredError, other statuses keep the backend code, an empty answer is a 502', async () => {
    cookieGet.mockReturnValue({ value: 't' })
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'UNAUTHENTICATED', message: 'expired' } }, 401))
    await expect(requestSampleContent()).rejects.toBeInstanceOf(SessionExpiredError)

    fetchMock.mockResolvedValueOnce(json({ error: { code: 'FORBIDDEN', message: 'Access denied' } }, 403))
    await expect(requestSampleContent()).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' })

    fetchMock.mockResolvedValueOnce(json({}, 200))
    const error = await requestSampleContent().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 502 })
  })
})
