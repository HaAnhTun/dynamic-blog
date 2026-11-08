// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { POST } from './route'

const ORIGIN = 'http://localhost:3000'

/** Default as callBff sends it: a POST carrying `content-type: application/json`. */
function logout(headers: Record<string, string>): Request {
  return new Request(`${ORIGIN}/api/auth/logout`, {
    method: 'POST',
    headers: {
      host: 'localhost:3000',
      cookie: 'access_token=a; refresh_token=r-reader',
      'content-type': 'application/json',
      ...headers,
    },
  })
}

describe('POST /api/auth/logout', () => {
  afterEach(() => vi.restoreAllMocks())

  it('204, revokes the reader refresh token and clears both cookies', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))

    const res = await POST(logout({ 'sec-fetch-site': 'same-origin', origin: ORIGIN }))

    expect(res.status).toBe(204)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(String(fetchSpy.mock.calls[0]![0])).toMatch(/\/api\/v1\/auth\/logout$/)
    expect(JSON.parse(String(fetchSpy.mock.calls[0]![1]!.body))).toEqual({ refreshToken: 'r-reader' })
    const cookies = res.headers.getSetCookie()
    expect(cookies.map((c) => c.split('=')[0]).sort()).toEqual(['access_token', 'mfa_challenge', 'refresh_token'])
    expect(cookies.every((c) => c.includes('Max-Age=0'))).toBe(true)
  })

  it.each([
    ['forged form', 'application/x-www-form-urlencoded'],
    ['text/plain', 'text/plain;charset=UTF-8'],
    ['multipart', 'multipart/form-data; boundary=x'],
  ])('not JSON (%s) gives 415 and the session stays intact', async (_label, type) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    // No Sec-Fetch-Site, no Origin (an old browser): the JSON layer is what still blocks a cross-site form.
    const res = await POST(logout({ 'content-type': type }))

    expect(res.status).toBe(415)
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'UNSUPPORTED_MEDIA_TYPE' } })
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(res.headers.getSetCookie()).toHaveLength(0)
  })

  it('a bare POST without content-type is also 415: unlike /admin/logout, this route does not accept it', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const bare = new Request(`${ORIGIN}/api/auth/logout`, {
      method: 'POST',
      headers: { host: 'localhost:3000', 'sec-fetch-site': 'same-origin', cookie: 'refresh_token=r-reader' },
    })

    const res = await POST(bare)

    expect(res.status).toBe(415)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('from another site gives 403 and the session stays intact', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await POST(logout({ 'sec-fetch-site': 'cross-site' }))

    expect(res.status).toBe(403)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(res.headers.getSetCookie()).toHaveLength(0)
  })

  it('still logs out in the browser when the backend does not answer', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))

    const res = await POST(logout({ 'sec-fetch-site': 'same-origin' }))

    expect(res.status).toBe(204)
    expect(res.headers.getSetCookie().every((c) => c.includes('Max-Age=0'))).toBe(true)
  })
})
