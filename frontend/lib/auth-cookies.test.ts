// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import {
  MFA_CHALLENGE_COOKIE,
  accessCookieName,
  clearLegacySessionCookies,
  clearMfaChallengeCookie,
  clearSessionCookies,
  clearedMfaChallengeCookieOptions,
  mfaChallengeCookieOptions,
  readCookie,
  readSessionTokens,
  refreshCookieName,
  refreshCookieOptions,
  setMfaChallengeCookie,
  setSessionCookies,
} from './auth-cookies'

function withCookie(cookie: string | null): Request {
  const headers = new Headers()
  if (cookie !== null) headers.set('cookie', cookie)
  return new Request('http://localhost:3000/x', { headers })
}

afterEach(() => vi.unstubAllEnvs())

describe('readCookie', () => {
  it('picks the right cookie by name, ignoring whitespace around the semicolon', () => {
    const request = withCookie('access_token=a.b.c;  refresh_token=r-1 ; theme=dark')
    expect(readCookie(request, 'refresh_token')).toBe('r-1')
    expect(readCookie(request, 'access_token')).toBe('a.b.c')
  })

  it('does not confuse a name that is a prefix of another name', () => {
    expect(readCookie(withCookie('xrefresh_token=no; refresh_token=yes'), 'refresh_token')).toBe('yes')
  })

  it('missing header, missing cookie or empty value gives undefined', () => {
    expect(readCookie(withCookie(null), 'refresh_token')).toBeUndefined()
    expect(readCookie(withCookie('theme=dark'), 'refresh_token')).toBeUndefined()
    expect(readCookie(withCookie('refresh_token='), 'refresh_token')).toBeUndefined()
  })

  it('percent-decodes like Next request.cookies, and keeps a malformed string as is', () => {
    expect(readCookie(withCookie('n=a%2Fb'), 'n')).toBe('a/b')
    expect(readCookie(withCookie('n=a%zz'), 'n')).toBe('a%zz')
  })
})

describe('setSessionCookies / clearSessionCookies', () => {
  it('sets both cookies HttpOnly, SameSite=Lax, Path=/; refresh lives 30 days', () => {
    const response = NextResponse.json({})
    setSessionCookies(response, { accessToken: 'eyJ.a.b', refreshToken: 'r-new' })
    const [access, refresh] = response.headers.getSetCookie()

    expect(access).toMatch(/^access_token=eyJ\.a\.b;/)
    expect(access).toContain('HttpOnly')
    expect(access).toContain('SameSite=lax')
    expect(access).toContain('Path=/')
    expect(access).not.toContain('Max-Age')
    expect(refresh).toMatch(/^refresh_token=r-new;/)
    expect(refresh).toContain(`Max-Age=${30 * 24 * 60 * 60}`)
  })

  it('Secure in production and not in development', () => {
    vi.stubEnv('NODE_ENV', 'production')
    const prod = NextResponse.json({})
    setSessionCookies(prod, { accessToken: 'a', refreshToken: 'r' })
    expect(prod.headers.getSetCookie().every((c) => c.includes('Secure'))).toBe(true)

    vi.stubEnv('NODE_ENV', 'development')
    const dev = NextResponse.json({})
    setSessionCookies(dev, { accessToken: 'a', refreshToken: 'r' })
    expect(dev.headers.getSetCookie().some((c) => c.includes('Secure'))).toBe(false)
  })

  it('clears both cookies with Max-Age=0', () => {
    const response = NextResponse.json({})
    clearSessionCookies(response)
    const cookies = response.headers.getSetCookie()

    expect(cookies.map((c) => c.split('=')[0]).sort()).toEqual(['access_token', 'refresh_token'])
    expect(cookies.every((c) => c.includes('Max-Age=0'))).toBe(true)
  })
})

/**
 * Audit 031. In production the session cookies carry the `__Host-` prefix: a browser accepts such a cookie only if it is Secure,
 * has Path=/ and has no Domain, so a sibling subdomain or a network attacker cannot plant one that is read before ours. Outside
 * production the names stay plain (the prefix needs Secure, development runs on plain HTTP).
 */
describe('the __Host- prefix of the session cookies', () => {
  const tokens = { accessToken: 'eyJ.a.b', refreshToken: 'r-new' }

  function cookiesOf(fill: (response: NextResponse) => void): string[] {
    const response = NextResponse.json({})
    fill(response)
    return response.headers.getSetCookie()
  }

  it('production: both names start with __Host-, each Secure, Path=/, HttpOnly, SameSite=Lax and with no Domain', () => {
    vi.stubEnv('NODE_ENV', 'production')
    expect(accessCookieName()).toBe('__Host-access_token')
    expect(refreshCookieName()).toBe('__Host-refresh_token')

    const cookies = cookiesOf((response) => setSessionCookies(response, tokens))
    const access = cookies.find((c) => c.startsWith('__Host-access_token='))!
    const refresh = cookies.find((c) => c.startsWith('__Host-refresh_token='))!

    for (const cookie of [access, refresh]) {
      expect(cookie).toContain('Secure')
      expect(cookie).toContain('Path=/')
      expect(cookie).toContain('HttpOnly')
      expect(cookie).toContain('SameSite=lax')
      // `__Host-` forbids a Domain attribute: with one the browser refuses the cookie.
      expect(cookie).not.toMatch(/;\s*Domain=/i)
    }
    expect(access).toMatch(/^__Host-access_token=eyJ\.a\.b;/)
    expect(refresh).toMatch(/^__Host-refresh_token=r-new;/)
  })

  it('development and test: the plain names, not Secure, and no cookie of the old names is touched', () => {
    for (const env of ['development', 'test']) {
      vi.stubEnv('NODE_ENV', env)
      expect(accessCookieName()).toBe('access_token')
      expect(refreshCookieName()).toBe('refresh_token')

      const cookies = cookiesOf((response) => setSessionCookies(response, tokens))
      expect(cookies.map((c) => c.split('=')[0]).sort(), env).toEqual(['access_token', 'refresh_token'])
      expect(
        cookies.some((c) => c.includes('Secure')),
        env,
      ).toBe(false)
      expect(
        cookies.every((c) => !c.includes('Max-Age=0')),
        env,
      ).toBe(true)
    }
  })

  it('production: a new session also deletes the cookies of the old names, with the attributes they were set with', () => {
    vi.stubEnv('NODE_ENV', 'production')

    const cookies = cookiesOf((response) => setSessionCookies(response, tokens))

    const legacy = cookies.filter((c) => /^(access_token|refresh_token)=/.test(c))
    expect(legacy.map((c) => c.split('=')[0]).sort()).toEqual(['access_token', 'refresh_token'])
    for (const cookie of legacy) {
      expect(cookie).toMatch(/^[a-z_]+=;/)
      expect(cookie).toContain('Max-Age=0')
      expect(cookie).toContain('Path=/')
      expect(cookie).toContain('Secure')
    }
    // The new pair is there too, and alive.
    expect(cookies.filter((c) => c.startsWith('__Host-') && !c.includes('Max-Age=0'))).toHaveLength(2)
  })

  it('production: clearing the session clears the new names and the old ones', () => {
    vi.stubEnv('NODE_ENV', 'production')

    const cookies = cookiesOf((response) => clearSessionCookies(response))

    expect(cookies.map((c) => c.split('=')[0]).sort()).toEqual([
      '__Host-access_token',
      '__Host-refresh_token',
      'access_token',
      'refresh_token',
    ])
    expect(cookies.every((c) => c.includes('Max-Age=0') && c.includes('Secure'))).toBe(true)
  })

  it('outside production there are no old names to delete: clearing the legacy cookies does nothing', () => {
    expect(cookiesOf((response) => clearLegacySessionCookies(response))).toEqual([])
  })

  it('production: readCookie finds the __Host- name and never confuses it with the plain one', () => {
    vi.stubEnv('NODE_ENV', 'production')
    const request = withCookie('refresh_token=planted; __Host-refresh_token=genuine')

    expect(readCookie(request, refreshCookieName())).toBe('genuine')
    expect(readCookie(withCookie('refresh_token=planted'), refreshCookieName())).toBeUndefined()
  })
})

/**
 * Audit 007. The refresh cookie ends when the backend would refuse the token: its Max-Age is the `refreshExpiresIn` of the
 * backend's answer (an ADMIN or AUTHOR session is shorter than a reader's), not a constant 30 days.
 */
describe('the lifetime of the refresh cookie', () => {
  const THIRTY_DAYS = 30 * 24 * 60 * 60

  function refreshCookie(tokens: Parameters<typeof setSessionCookies>[1]): string {
    const response = NextResponse.json({})
    setSessionCookies(response, tokens)
    return response.headers.getSetCookie().find((c) => c.startsWith('refresh_token='))!
  }

  it('follows the backend: a session of 7 days gets a cookie of 7 days', () => {
    const sevenDays = 7 * 24 * 60 * 60
    expect(refreshCookie({ accessToken: 'a', refreshToken: 'r', refreshExpiresIn: sevenDays })).toContain(`Max-Age=${sevenDays}`)
    expect(refreshCookieOptions(sevenDays).maxAge).toBe(sevenDays)
  })

  it('a session close to its end gets a short cookie, not a long one', () => {
    expect(refreshCookie({ accessToken: 'a', refreshToken: 'r', refreshExpiresIn: 3_600 })).toContain('Max-Age=3600')
  })

  it('a fraction of a second is cut, never rounded up past the backend', () => {
    expect(refreshCookieOptions(86_399.9).maxAge).toBe(86_399)
  })

  it('without a usable number it is the 30 day maximum (an older backend): the backend still refuses a token past its end', () => {
    for (const value of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(refreshCookieOptions(value).maxAge, String(value)).toBe(THIRTY_DAYS)
    }
    expect(refreshCookie({ accessToken: 'a', refreshToken: 'r' })).toContain(`Max-Age=${THIRTY_DAYS}`)
  })

  it('never above the 30 day maximum, whatever the backend says', () => {
    expect(refreshCookieOptions(THIRTY_DAYS * 10).maxAge).toBe(THIRTY_DAYS)
  })

  it('readSessionTokens takes the pair and the lifetime from a backend answer, and nothing from a broken one', () => {
    expect(readSessionTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900, refreshExpiresIn: 604_800 })).toEqual({
      accessToken: 'a',
      refreshToken: 'r',
      refreshExpiresIn: 604_800,
    })
    // An older backend: no lifetime.
    expect(readSessionTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 })).toEqual({
      accessToken: 'a',
      refreshToken: 'r',
    })
    // A lifetime that is not a number is left out, not trusted.
    expect(readSessionTokens({ accessToken: 'a', refreshToken: 'r', refreshExpiresIn: '604800' })).toEqual({
      accessToken: 'a',
      refreshToken: 'r',
    })
    for (const broken of [
      null,
      undefined,
      'x',
      3,
      {},
      { accessToken: 'a' },
      { accessToken: '', refreshToken: 'r' },
      { refreshToken: 'r' },
    ]) {
      expect(readSessionTokens(broken), JSON.stringify(broken)).toBeNull()
    }
  })
})

describe('the second-step challenge cookie', () => {
  it('is httpOnly, Lax, valid for five minutes and only sent to the sign-in pages (Path=/admin/login)', () => {
    const response = NextResponse.json({})
    setMfaChallengeCookie(response, 'challenge-value')
    const [cookie] = response.headers.getSetCookie()

    expect(MFA_CHALLENGE_COOKIE).toBe('mfa_challenge')
    expect(cookie).toMatch(/^mfa_challenge=challenge-value;/)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=lax')
    expect(cookie).toContain('Path=/admin/login')
    expect(cookie).toContain('Max-Age=300')
    expect(mfaChallengeCookieOptions()).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/admin/login', maxAge: 300 })
  })

  it('is Secure in production and not in development', () => {
    vi.stubEnv('NODE_ENV', 'production')
    expect(mfaChallengeCookieOptions().secure).toBe(true)
    const prod = NextResponse.json({})
    setMfaChallengeCookie(prod, 'c')
    expect(prod.headers.getSetCookie()[0]).toContain('Secure')

    vi.stubEnv('NODE_ENV', 'development')
    expect(mfaChallengeCookieOptions().secure).toBe(false)
    const dev = NextResponse.json({})
    setMfaChallengeCookie(dev, 'c')
    expect(dev.headers.getSetCookie()[0]).not.toContain('Secure')
  })

  it('is cleared with the very same Path, or the browser would keep it as a different cookie', () => {
    expect(clearedMfaChallengeCookieOptions()).toMatchObject({ path: '/admin/login', maxAge: 0 })
    const response = NextResponse.json({})
    clearMfaChallengeCookie(response)
    const [cookie] = response.headers.getSetCookie()

    expect(cookie).toMatch(/^mfa_challenge=;/)
    expect(cookie).toContain('Path=/admin/login')
    expect(cookie).toContain('Max-Age=0')
  })

  it('is not a session cookie: clearing the session leaves it alone (a stale tab must not kill a sign-in in progress)', () => {
    const response = NextResponse.json({})
    clearSessionCookies(response)

    expect(response.headers.getSetCookie().some((c) => c.startsWith('mfa_challenge='))).toBe(false)
  })
})
