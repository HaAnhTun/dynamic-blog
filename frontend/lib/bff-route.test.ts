// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SLUG_XIN_CHAO } from '@/test/fixtures/vi/accented-text'
import { NextRequest } from 'next/server'
import {
  commentApiPath,
  forwardPrivateRead,
  forwardRead,
  forwardWrite,
  invalidParameter,
  isCommentCursor,
  notificationApiPath,
  postApiPath,
} from './bff-route'

const ORIGIN = 'http://localhost:3000'
const ID = '0b9a5a4e-7c1d-4f7e-8f52-3c1e2d9a6b10'

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

const FRESH = `${b64url({ alg: 'HS256' })}.${b64url({ sub: 'u1', role: 'USER', exp: Math.floor(Date.now() / 1000) + 600 })}.sig`

function write(method: string, headers: Record<string, string> = {}, body?: string): NextRequest {
  const request = new NextRequest(`${ORIGIN}/api/posts/bai-viet/comments`, {
    method,
    headers: {
      host: 'localhost:3000',
      origin: ORIGIN,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      ...headers,
    },
    body,
  })
  request.cookies.set('access_token', FRESH)
  return request
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('postApiPath: slug 1–255 characters, no "/", always through encodeURIComponent', () => {
  it('a normal slug of the site', () => {
    expect(postApiPath('bai-viet-dau-tien')).toBe('/api/v1/posts/bai-viet-dau-tien')
  })

  it('special characters are encoded, never becoming a delimiter of the backend URL', () => {
    expect(postApiPath(SLUG_XIN_CHAO)).toBe('/api/v1/posts/xin-ch%C3%A0o')
    expect(postApiPath('a?b#c')).toBe('/api/v1/posts/a%3Fb%23c')
    expect(postApiPath('a\\b')).toBe('/api/v1/posts/a%5Cb')
    // Next already decoded the param once; the remaining `%2e%2e` is text, encoded again as `%252e%252e`.
    expect(postApiPath('%2e%2e')).toBe('/api/v1/posts/%252e%252e')
  })

  it('255 characters is accepted, 256 is not', () => {
    expect(postApiPath('a'.repeat(255))).toBe(`/api/v1/posts/${'a'.repeat(255)}`)
    expect(postApiPath('a'.repeat(256))).toBeNull()
  })

  it.each([
    ['empty', ''],
    ['contains "/" (Next decodes %2F before it gets here)', 'a/b'],
    ['dot segment "."', '.'],
    ['dot segment ".."', '..'],
  ])('%s: null', (_label, slug) => {
    expect(postApiPath(slug)).toBeNull()
  })

  it('".." is blocked because the fetch URL collapses /posts/../like into /like: a completely different endpoint', () => {
    expect(new URL(`http://backend.test/api/v1/posts/${encodeURIComponent('..')}/like`).pathname).toBe('/api/v1/like')
  })

  it('a lone surrogate (encodeURIComponent throws) gives null, does not throw', () => {
    expect(postApiPath(String.fromCharCode(0xd800))).toBeNull()
  })
})

describe('commentApiPath: the id must be a UUID', () => {
  it('lowercase or uppercase UUID', () => {
    expect(commentApiPath(ID)).toBe(`/api/v1/comments/${ID}`)
    expect(commentApiPath(ID.toUpperCase())).toBe(`/api/v1/comments/${ID.toUpperCase()}`)
  })

  it.each(['', 'abc', `${ID}x`, `${ID}/replies`, ` ${ID}`, `${ID}?x=1`, '..', ID.replace(/-/g, '')])('%j gives null', (id) => {
    expect(commentApiPath(id)).toBeNull()
  })
})

describe('notificationApiPath: the id must be a UUID', () => {
  it('lowercase or uppercase UUID', () => {
    expect(notificationApiPath(ID)).toBe(`/api/v1/notifications/${ID}`)
    expect(notificationApiPath(ID.toUpperCase())).toBe(`/api/v1/notifications/${ID.toUpperCase()}`)
  })

  it.each(['', 'read-all', 'unread-count', `${ID}x`, `${ID}/read`, `${ID}?x=1`, '..', ID.replace(/-/g, '')])(
    '%j gives null',
    (id) => {
      expect(notificationApiPath(id)).toBeNull()
    },
  )
})

describe('isCommentCursor: ^[A-Za-z0-9_-]{1,200}$', () => {
  it('the backend base64url cursor', () => {
    expect(isCommentCursor(Buffer.from(`1759900000000000:${ID}`).toString('base64url'))).toBe(true)
    expect(isCommentCursor('a'.repeat(200))).toBe(true)
  })

  it.each(['', 'a'.repeat(201), 'abc=', 'a+b', 'a/b', 'a b', 'a&size=500'])('%j is rejected', (cursor) => {
    expect(isCommentCursor(cursor)).toBe(false)
  })
})

describe('invalidParameter', () => {
  it('400 VALIDATION_ERROR, private no-store', async () => {
    const res = invalidParameter()

    expect(res.status).toBe(400)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
  })
})

describe('forwardRead', () => {
  it('a broken parameter gives 400 without calling the backend', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await forwardRead(new NextRequest(`${ORIGIN}/api/posts/x/like`), null)

    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('GET optional: guests can read too, no Bearer', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: { liked: false, count: 2 } }))

    const res = await forwardRead(new NextRequest(`${ORIGIN}/api/posts/x/like`), '/api/v1/posts/x/like')

    expect(res.status).toBe(200)
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(new URL(String(url)).pathname).toBe('/api/v1/posts/x/like')
    expect(init).toMatchObject({ method: 'GET' })
    expect(new Headers(init?.headers).get('authorization')).toBeNull()
  })
})

describe("forwardPrivateRead: GET of the reader's own data, auth required", () => {
  it('a broken parameter gives 400 without calling the backend', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await forwardPrivateRead(new NextRequest(`${ORIGIN}/api/notifications`), null)

    expect(res.status).toBe(400)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('no session: 401 UNAUTHENTICATED without calling the backend (unlike forwardRead: does not go through as a guest)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await forwardPrivateRead(
      new NextRequest(`${ORIGIN}/api/notifications/unread-count`),
      '/api/v1/notifications/unread-count',
    )

    expect(res.status).toBe(401)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'UNAUTHENTICATED' } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('with a session: GET with Bearer, needs no Origin or Sec-Fetch-Site', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: { count: 3 } }))
    // A bare GET, no same-origin header at all: reading changes nothing, so it is not blocked like a write.
    const request = new NextRequest(`${ORIGIN}/api/notifications/unread-count`)
    request.cookies.set('access_token', FRESH)

    const res = await forwardPrivateRead(request, '/api/v1/notifications/unread-count')

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ data: { count: 3 } })
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(new URL(String(url)).pathname).toBe('/api/v1/notifications/unread-count')
    expect(init).toMatchObject({ method: 'GET' })
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${FRESH}`)
  })
})

describe('forwardWrite: order of the checks', () => {
  it('a different origin gives 403 before even checking parameters and reading the body', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const request = write('POST', { 'sec-fetch-site': 'cross-site' }, '{"content":"Hello"}')

    const res = await forwardWrite(request, null, 'POST', { forwardBody: true })

    expect(res.status).toBe(403)
    expect(request.bodyUsed).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a broken parameter gives 400, does not read the body', async () => {
    const request = write('POST', {}, '{"content":"Hello"}')

    const res = await forwardWrite(request, null, 'POST', { forwardBody: true })

    expect(res.status).toBe(400)
    expect(request.bodyUsed).toBe(false)
  })

  it('a body over 16 KB gives 413 PAYLOAD_TOO_LARGE without calling the backend', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await forwardWrite(
      write('POST', {}, JSON.stringify({ content: 'x'.repeat(17_000) })),
      '/api/v1/posts/bai-viet/comments',
      'POST',
      { forwardBody: true },
    )

    expect(res.status).toBe(413)
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('forwardBody: forwards the body unchanged with a JSON content-type, auth required (Bearer)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: { id: ID } }, { status: 201 }))

    const res = await forwardWrite(write('POST', {}, '{"content":"Hello there"}'), '/api/v1/posts/bai-viet/comments', 'POST', {
      forwardBody: true,
    })

    expect(res.status).toBe(201)
    const init = fetchSpy.mock.calls[0]![1]!
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{"content":"Hello there"}')
    const headers = new Headers(init.headers)
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('authorization')).toBe(`Bearer ${FRESH}`)
  })

  it('without forwardBody: the body is dropped (still limited to 16 KB), the backend receives no content-type', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: { liked: true, count: 1 } }))

    await forwardWrite(write('PUT', {}, '{"liked":false,"userId":"x"}'), '/api/v1/posts/bai-viet/like', 'PUT', {
      forwardBody: false,
    })

    const init = fetchSpy.mock.calls[0]![1]!
    expect(init.method).toBe('PUT')
    expect(init.body).toBeUndefined()
    expect(new Headers(init.headers).get('content-type')).toBeNull()

    const tooLarge = await forwardWrite(write('PUT', {}, 'x'.repeat(17_000)), '/api/v1/posts/bai-viet/like', 'PUT', {
      forwardBody: false,
    })
    expect(tooLarge.status).toBe(413)
  })
})
