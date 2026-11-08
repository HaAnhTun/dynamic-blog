// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { A_DOT_BELOW, SLUG_BAI_VIET } from '@/test/fixtures/vi/accented-text'
import {
  clearOauthFlowCookie,
  clearedOauthFlowCookieOptions,
  decodeOauthFlow,
  encodeOauthFlow,
  isAuthRequestBlob,
  oauthFlowCookieName,
  oauthFlowCookieOptions,
  oauthRedirect,
  setOauthFlowCookie,
} from './oauth-flow-cookie'

const BLOB = 'eyJ2IjoxfQ.c2lnbmF0dXJl'

afterEach(() => vi.unstubAllEnvs())

describe('cookie name and attributes by NODE_ENV', () => {
  it('production: __Host-, Secure, Path=/', () => {
    vi.stubEnv('NODE_ENV', 'production')
    expect(oauthFlowCookieName()).toBe('__Host-oauth_flow')
    expect(oauthFlowCookieOptions()).toEqual({ httpOnly: true, sameSite: 'lax', secure: true, path: '/', maxAge: 600 })
  })

  it('development: no prefix, not Secure, narrow Path at /api/auth/github', () => {
    vi.stubEnv('NODE_ENV', 'development')
    expect(oauthFlowCookieName()).toBe('oauth_flow')
    expect(oauthFlowCookieOptions()).toEqual({
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      path: '/api/auth/github',
      maxAge: 600,
    })
  })

  it('the deletion has the same Path as the set: with a different Path the browser sees another cookie and does not delete', () => {
    for (const env of ['production', 'development']) {
      vi.stubEnv('NODE_ENV', env)
      expect(clearedOauthFlowCookieOptions()).toEqual({ ...oauthFlowCookieOptions(), maxAge: 0 })
    }
  })

  it('the real Set-Cookie in production satisfies the __Host- rules: Secure, Path=/, no Domain', () => {
    vi.stubEnv('NODE_ENV', 'production')
    const response = new NextResponse(null)
    response.cookies.set(oauthFlowCookieName(), encodeOauthFlow('/', BLOB), oauthFlowCookieOptions())
    const [cookie] = response.headers.getSetCookie()

    expect(cookie).toMatch(/^__Host-oauth_flow=/)
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('Path=/;')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=lax')
    expect(cookie).toContain('Max-Age=600')
    expect(cookie).not.toMatch(/Domain=/i)
  })
})

describe('value: <base64url(returnTo)>.<blob>', () => {
  it('encoding then decoding gives back exactly the returnTo and the blob', () => {
    const value = encodeOauthFlow('/posts/' + SLUG_BAI_VIET + '?x=1#binh-luan', BLOB)

    expect(value).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    expect(decodeOauthFlow(value)).toEqual({ returnTo: '/posts/' + SLUG_BAI_VIET + '?x=1#binh-luan', blob: BLOB })
  })

  it('splits at the FIRST dot: the blob itself has exactly one dot', () => {
    const decoded = decodeOauthFlow(encodeOauthFlow('/', BLOB))
    expect(decoded?.blob).toBe(BLOB)
  })

  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['no dot', 'abc'],
    ['blob missing the signature part', 'Lw.abc'],
    ['blob with two dots', 'Lw.a.b.c'],
    ['empty returnTo', '.a.b'],
    ['character outside base64url', 'L+w.a.b'],
    ['abnormally long', `Lw.${'a'.repeat(5000)}.b`],
  ])('broken value (%s) gives null', (_label, value) => {
    expect(decodeOauthFlow(value)).toBeNull()
  })
})

describe('setOauthFlowCookie', () => {
  function flowValueOf(response: NextResponse): string {
    const cookie = response.headers.getSetCookie()[0]!
    return cookie.split(';', 1)[0]!.split('=').slice(1).join('=')
  }

  it('sets the cookie with the encoded value of returnTo and the blob', () => {
    vi.stubEnv('NODE_ENV', 'development')
    const response = new NextResponse(null)
    setOauthFlowCookie(response, '/posts/a', BLOB)

    expect(decodeOauthFlow(flowValueOf(response))).toEqual({ returnTo: '/posts/a', blob: BLOB })
  })

  it('a returnTo that grows past the cookie size after encoding goes back to "/", still keeping the blob', () => {
    // 500 characters U+1EA1 (a with dot below) through safeReturnTo become 4500 characters of %E1%BA%A1: valid, but the browser would drop the whole cookie.
    const huge = `/search?q=${encodeURIComponent(A_DOT_BELOW.repeat(500))}`
    const response = new NextResponse(null)
    setOauthFlowCookie(response, huge, BLOB)

    const value = flowValueOf(response)
    expect(value.length).toBeLessThan(4096)
    expect(decodeOauthFlow(value)).toEqual({ returnTo: '/', blob: BLOB })
  })

  it('clearOauthFlowCookie deletes exactly the name and Path in use', () => {
    vi.stubEnv('NODE_ENV', 'production')
    const response = new NextResponse(null)
    clearOauthFlowCookie(response)
    const [cookie] = response.headers.getSetCookie()

    expect(cookie).toMatch(/^__Host-oauth_flow=;/)
    expect(cookie).toContain('Max-Age=0')
    expect(cookie).toContain('Path=/;')
  })
})

describe('oauthRedirect', () => {
  it('303 with a relative Location, no cache, no-referrer', () => {
    const response = oauthRedirect('/login?error=state')

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/login?error=state')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
  })
})

describe('isAuthRequestBlob', () => {
  it('exactly one dot between the two base64url parts', () => {
    expect(isAuthRequestBlob(BLOB)).toBe(true)
    expect(isAuthRequestBlob('abc')).toBe(false)
    expect(isAuthRequestBlob('a.b.c')).toBe(false)
    expect(isAuthRequestBlob('a b.c')).toBe(false)
    expect(isAuthRequestBlob('')).toBe(false)
  })
})
