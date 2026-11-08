// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { POST } from './route'

const ORIGIN = 'http://localhost:3000'

function logoutRequest(origin: string | null): Request {
  const headers = new Headers({ host: 'localhost:3000', cookie: 'refresh_token=r; access_token=a' })
  if (origin !== null) headers.set('origin', origin)
  return new Request(`${ORIGIN}/admin/logout`, { method: 'POST', headers })
}

describe('POST /admin/logout', () => {
  afterEach(() => vi.restoreAllMocks())

  it('clears both cookies and revokes the refresh token', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))

    const res = await POST(logoutRequest(ORIGIN))
    const cookies = res.headers.getSetCookie()

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/auth/logout'),
      expect.objectContaining({ method: 'POST' }),
    )
    // Max-Age=0 is the clearing mechanism; asserting the value is empty would pass on a
    // cookie that is still live with an empty value.
    expect(cookies.every((c) => c.includes('Max-Age=0'))).toBe(true)
    expect(cookies.map((c) => c.split('=')[0]).sort()).toEqual(['access_token', 'mfa_challenge', 'refresh_token'])
  })

  it('accepts a bare POST with no content-type and answers 200 { ok: true }', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))

    // LogoutButton sends exactly this. Unlike /api/auth/logout, this route does not require JSON.
    const res = await POST(logoutRequest(ORIGIN))

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true, revoked: true })
  })

  it('refuses a cross-site origin', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await POST(logoutRequest('https://evil.example'))

    // sameSite=lax already stops a cross-site POST from carrying the cookies, so this is
    // the second of two independent defences. It matters because `lax` makes an exception
    // for top-level navigations, and a forged form submit is one.
    expect(res.status).toBe(403)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(res.headers.getSetCookie()).toHaveLength(0)
  })

  it('still clears the cookies when the backend revoke fails, and says the session was not ended (audit 038)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))

    const res = await POST(logoutRequest(ORIGIN))

    // The author pressed logout. Leaving them logged in because an unrelated service is
    // down is the wrong failure: the local session must go regardless.
    const cookies = res.headers.getSetCookie()
    expect(cookies.map((c) => c.split('=')[0]).sort()).toEqual(['access_token', 'mfa_challenge', 'refresh_token'])
    expect(cookies.every((c) => c.includes('Max-Age=0'))).toBe(true)
    // But the refresh token stays valid at the server until it expires: the body says so, and the button tells the person.
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true, revoked: false })
  })
})
