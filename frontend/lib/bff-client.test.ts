// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GREETING } from '@/test/fixtures/vi/accented-text'
import { callBff } from './bff-client'

afterEach(() => vi.restoreAllMocks())

describe('callBff', () => {
  it('2xx JSON gives { ok: true, data } taken from the { data } envelope', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: { liked: true, count: 4 } }))

    await expect(callBff('/api/posts/a/like')).resolves.toEqual({ ok: true, data: { liked: true, count: 4 } })
  })

  it('the { data: null } of /api/session comes out as exactly null', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: null }))

    await expect(callBff('/api/session')).resolves.toEqual({ ok: true, data: null })
  })

  it('204 gives { ok: true, data: null }', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))

    await expect(callBff('/api/comments/x', { method: 'DELETE' })).resolves.toEqual({ ok: true, data: null })
  })

  it('an error with an envelope gives { ok: false, status, code }, without the backend message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ error: { code: 'RATE_LIMITED', message: 'Too many requests' } }, { status: 429 }),
    )

    const result = await callBff('/api/posts/a/comments', { method: 'POST', body: '{}' })

    expect(result).toEqual({ ok: false, status: 429, code: 'RATE_LIMITED' })
  })

  it('an error without an envelope (proxy, HTML) gives code UNKNOWN with the real status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>413</html>', { status: 413 }))

    await expect(callBff('/api/x', { method: 'POST', body: '{}' })).resolves.toEqual({
      ok: false,
      status: 413,
      code: 'UNKNOWN',
    })
  })

  it('a network error gives code NETWORK, status 0, does not throw', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(callBff('/api/session')).resolves.toEqual({ ok: false, status: 0, code: 'NETWORK' })
  })

  it('a 2xx whose body cannot be read counts as a server error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not json', { status: 200 }))

    await expect(callBff('/api/session')).resolves.toEqual({ ok: false, status: 502, code: 'BAD_RESPONSE' })
  })

  it('a string body is sent with a JSON content-type; never uses the browser cache', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: {} }, { status: 201 }))

    await callBff('/api/posts/a/comments', { method: 'POST', body: JSON.stringify({ content: GREETING }) })

    const [url, init] = fetchSpy.mock.calls[0]!
    expect(url).toBe('/api/posts/a/comments')
    expect(init).toMatchObject({ method: 'POST', cache: 'no-store', credentials: 'same-origin' })
    const headers = new Headers(init!.headers)
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('accept')).toBe('application/json')
  })

  it('a PUT without a body still carries a JSON content-type: the BFF route requires it for every PUT', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: { liked: true, count: 1 } }))

    await callBff('/api/posts/a/like', { method: 'PUT' })

    expect(new Headers(fetchSpy.mock.calls[0]![1]!.headers).get('content-type')).toBe('application/json')
  })

  it('GET does not send a content-type', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: null }))

    await callBff('/api/session')

    expect(new Headers(fetchSpy.mock.calls[0]![1]!.headers).has('content-type')).toBe(false)
  })
})
