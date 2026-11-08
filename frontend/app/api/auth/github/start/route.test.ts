// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from './route'

const ORIGIN = 'http://localhost:3000'
const GITHUB = 'https://github.com/login/oauth/authorize?response_type=code&client_id=abc&state=s1'
const BLOB = 'eyJ2IjoxLCJzdGF0ZSI6InMxIn0.bWFj'

/** One IP per request: the 20 per 10 minutes limit is module state that survives across tests. */
let ipCounter = 0
function freshIp(): string {
  ipCounter += 1
  return `10.2.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`
}

function start(returnTo: string | null, ip = freshIp()): NextRequest {
  const url = new URL('/api/auth/github/start', ORIGIN)
  if (returnTo !== null) url.searchParams.set('returnTo', returnTo)
  return new NextRequest(url, { headers: { 'x-forwarded-for': ip } })
}

/** The reply of OAuth2AuthorizationRequestRedirectFilter: a 302 to GitHub carrying the signed blob. */
function authorizationRedirect(
  setCookies: string[] = [`oauth2_auth_request=${BLOB}; Path=/api/v1/auth/oauth2; Max-Age=600; HttpOnly; SameSite=Lax`],
) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const headers = new Headers({ location: GITHUB })
    for (const cookie of setCookies) headers.append('set-cookie', cookie)
    return new Response(null, { status: 302, headers })
  })
}

function flowCookie(res: Response): string | undefined {
  return res.headers.getSetCookie().find((c) => /^(__Host-)?oauth_flow=/.test(c))
}

function flowValue(cookie: string): { returnTo: string; blob: string } {
  const value = cookie.split(';', 1)[0]!.split('=').slice(1).join('=')
  const dot = value.indexOf('.')
  return { returnTo: Buffer.from(value.slice(0, dot), 'base64url').toString('utf8'), blob: value.slice(dot + 1) }
}

function expectOAuthHeaders(res: Response) {
  expect(res.headers.get('cache-control')).toBe('private, no-store')
  expect(res.headers.get('referrer-policy')).toBe('no-referrer')
}

/** The Fetch Metadata a browser sends; `start()` itself sends none, like a client that has none. */
function startWith(metadata: Record<string, string>, ip = freshIp(), returnTo: string | null = null): NextRequest {
  const url = new URL('/api/auth/github/start', ORIGIN)
  if (returnTo !== null) url.searchParams.set('returnTo', returnTo)
  return new NextRequest(url, { headers: { 'x-forwarded-for': ip, ...metadata } })
}

const NAVIGATION = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

/**
 * Audit 037: the start is a GET that any page can trigger. Only a person's own navigation may start a round, and a request that is
 * not one must cost nothing: no backend call, and none of the 20 attempts per 10 minutes of the visitor's address.
 */
describe('GET /api/auth/github/start, who may start a round', () => {
  it('25 cross-site image loads reach no backend and use no attempt: the next real click from that address still works', async () => {
    const fetchSpy = authorizationRedirect()
    const ip = freshIp()

    for (let i = 0; i < 25; i++) {
      const res = await GET(
        startWith({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' }, ip),
      )
      expect(res.status).toBe(303)
      expect(res.headers.get('location')).toBe('/login')
      expect(res.headers.getSetCookie()).toHaveLength(0)
    }
    expect(fetchSpy).not.toHaveBeenCalled()

    // The control: the same address, a click on the sign-in button of this site, is not "too many attempts".
    const click = await GET(startWith(NAVIGATION, ip, '/posts/a'))
    expect(click.status).toBe(303)
    expect(click.headers.get('location')).toBe(GITHUB)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a cross-site link (top-level navigation from another site)', { ...NAVIGATION, 'sec-fetch-site': 'cross-site' }],
    ['a link from a sibling host (same-site)', { ...NAVIGATION, 'sec-fetch-site': 'same-site' }],
    ['a fetch() of this site (not a navigation)', { ...NAVIGATION, 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }],
    ['an iframe of this site', { ...NAVIGATION, 'sec-fetch-dest': 'iframe' }],
    ['an image of this site', { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' }],
    ['only a cross-site Sec-Fetch-Site', { 'sec-fetch-site': 'cross-site' }],
  ])('%s goes to /login with nothing started', async (_label, metadata) => {
    const fetchSpy = authorizationRedirect()

    const res = await GET(startWith(metadata, freshIp(), '/posts/a'))

    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/login?returnTo=%2Fposts%2Fa')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(flowCookie(res)).toBeUndefined()
  })

  it('a refused start keeps the locale of the page it came from', async () => {
    const res = await GET(startWith({ ...NAVIGATION, 'sec-fetch-site': 'cross-site' }, freshIp(), '/en/posts/a'))

    expect(res.headers.get('location')).toBe('/en/login?returnTo=%2Fen%2Fposts%2Fa')
  })

  it.each([
    ['a click on the sign-in button (same-origin)', NAVIGATION],
    ['a typed or bookmarked address (none)', { ...NAVIGATION, 'sec-fetch-site': 'none' }],
    ['a browser that sends no Fetch Metadata at all', {}],
    ['a browser that sends only Sec-Fetch-Site: same-origin', { 'sec-fetch-site': 'same-origin' }],
  ])('%s starts the round', async (_label, metadata) => {
    const fetchSpy = authorizationRedirect()

    const res = await GET(startWith(metadata, freshIp()))

    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(GITHUB)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(flowCookie(res)).toBeDefined()
  })
})

describe('GET /api/auth/github/start', () => {
  it("redirects 303 to GitHub and wraps the backend blob in the site's own oauth_flow cookie", async () => {
    vi.stubEnv('API_BASE_URL', 'http://backend.test:8080')
    const fetchSpy = authorizationRedirect()

    const res = await GET(start('/posts/bai-viet?x=1#binh-luan'))

    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(GITHUB)
    expectOAuthHeaders(res)

    const [url, init] = fetchSpy.mock.calls[0]!
    expect(String(url)).toBe('http://backend.test:8080/api/v1/auth/oauth2/authorization/github')
    expect(init).toMatchObject({ redirect: 'manual', cache: 'no-store' })
    expect(init!.signal).toBeInstanceOf(AbortSignal)

    const cookie = flowCookie(res)!
    expect(flowValue(cookie)).toEqual({ returnTo: '/posts/bai-viet?x=1#binh-luan', blob: BLOB })
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=lax')
    expect(cookie).toContain('Max-Age=600')
    // Never pass the backend Set-Cookie through to the browser.
    expect(res.headers.getSetCookie().some((c) => c.startsWith('oauth2_auth_request='))).toBe(false)
  })

  it('development: name oauth_flow, Path=/api/auth/github, not Secure', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    authorizationRedirect()

    const cookie = flowCookie(await GET(start('/')))!

    expect(cookie).toMatch(/^oauth_flow=/)
    expect(cookie).toContain('Path=/api/auth/github;')
    expect(cookie).not.toContain('Secure')
  })

  it('production: __Host-oauth_flow, Path=/, Secure', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    authorizationRedirect()

    const cookie = flowCookie(await GET(start('/')))!

    expect(cookie).toMatch(/^__Host-oauth_flow=/)
    expect(cookie).toContain('Path=/;')
    expect(cookie).toContain('Secure')
  })

  it.each(['//evil.com', '/..//evil.com', 'https://evil.com', '/login', '/api/auth/github/start', null])(
    'returnTo %j is sanitized to "/" before it enters the cookie',
    async (returnTo) => {
      authorizationRedirect()

      const cookie = flowCookie(await GET(start(returnTo)))!

      expect(flowValue(cookie).returnTo).toBe('/')
    },
  )

  it('backend 404 (OAuth not enabled) goes to /login?error=disabled and sets no cookie', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ error: { code: 'ENDPOINT_NOT_FOUND', message: 'x' } }, { status: 404 }),
    )

    const res = await GET(start('/posts/a'))

    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/login?error=disabled&returnTo=%2Fposts%2Fa')
    expect(flowCookie(res)).toBeUndefined()
    expectOAuthHeaders(res)
  })

  it('a network error or timeout gives /login?error=unavailable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const res = await GET(start('/'))

    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/login?error=unavailable')
    expectOAuthHeaders(res)
  })

  it.each([
    ['500', () => new Response(null, { status: 500 })],
    ['302 without a blob', () => new Response(null, { status: 302, headers: { location: GITHUB } })],
    [
      '302 to a Location that is not http(s)',
      () =>
        new Response(null, {
          status: 302,
          headers: [
            ['location', 'javascript:alert(1)'],
            ['set-cookie', `oauth2_auth_request=${BLOB}; Path=/`],
          ],
        }),
    ],
    [
      '302 with a malformed blob',
      () =>
        new Response(null, {
          status: 302,
          headers: [
            ['location', GITHUB],
            ['set-cookie', 'oauth2_auth_request=no-dot-here; Path=/'],
          ],
        }),
    ],
    ['200', () => Response.json({})],
  ])('%s gives /login?error=unavailable', async (_label, reply) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply())

    const res = await GET(start('/'))

    expect(res.headers.get('location')).toBe('/login?error=unavailable')
    expect(flowCookie(res)).toBeUndefined()
  })

  it('picks the right oauth2_auth_request cookie among other Set-Cookie headers', async () => {
    authorizationRedirect(['JSESSIONID=nope; Path=/', `oauth2_auth_request=${BLOB}; Path=/api/v1/auth/oauth2`])

    const cookie = flowCookie(await GET(start('/')))!

    expect(flowValue(cookie).blob).toBe(BLOB)
  })

  it('with several Set-Cookie headers of the same name the last wins, as in a browser', async () => {
    authorizationRedirect([
      'oauth2_auth_request=; Path=/api/v1/auth/oauth2; Max-Age=0',
      `oauth2_auth_request=${BLOB}; Path=/api/v1/auth/oauth2; Max-Age=600`,
    ])
    expect(flowValue(flowCookie(await GET(start('/')))!).blob).toBe(BLOB)

    // Conversely: when the deletion comes later there is no blob left to keep.
    authorizationRedirect([
      `oauth2_auth_request=${BLOB}; Path=/api/v1/auth/oauth2; Max-Age=600`,
      'oauth2_auth_request=; Path=/api/v1/auth/oauth2; Max-Age=0',
    ])
    const res = await GET(start('/'))
    expect(res.headers.get('location')).toBe('/login?error=unavailable')
    expect(flowCookie(res)).toBeUndefined()
  })

  it('more than 20 per 10 minutes from one IP gives /login?error=rate and skips the backend', async () => {
    const fetchSpy = authorizationRedirect()
    const ip = '198.51.100.77'

    for (let i = 0; i < 20; i++) expect((await GET(start('/', ip))).headers.get('location')).toBe(GITHUB)
    const res = await GET(start('/posts/a', ip))

    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/login?error=rate&returnTo=%2Fposts%2Fa')
    expect(fetchSpy).toHaveBeenCalledTimes(20)
    expectOAuthHeaders(res)
  })
})
