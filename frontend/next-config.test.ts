// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import nextConfig from './next.config'
import { IMAGE_QUALITY } from './lib/image-quality'

/**
 * Next converts a size string to bytes with the `bytes` copy it bundles itself
 * (`next/dist/compiled/bytes`, called in server/config.js and action-handler.js). The test uses that same
 * copy: it compares the two limits the way Next reads them, not the way the test guesses whether "5mb" is
 * 5,000,000 or 5,242,880.
 */
const bytes = createRequire(import.meta.url)('next/dist/compiled/bytes') as {
  parse(value: string | number): number | null
}

/**
 * Same reason as `bytes`: match the redirect `source` with the very function Next uses at run time
 * (`buildCustomRoute` in next/dist/server/lib/router-utils/filesystem.js calls `getPathMatch`
 * with `strict: true, removeUnnamedParams: true`), not with a regex the test writes itself.
 */
const { getPathMatch } = createRequire(import.meta.url)(
  'next/dist/shared/lib/router/utils/path-match',
) as typeof import('next/dist/shared/lib/router/utils/path-match')

/** The `regexModifier` that the Next router attaches to every header, redirect and rewrite rule. */
const { modifyRouteRegex } = createRequire(import.meta.url)(
  'next/dist/lib/redirect-status',
) as typeof import('next/dist/lib/redirect-status')

function toBytes(value: string | number | undefined): number {
  expect(value, 'the limit must be set explicitly').toBeDefined()
  const parsed = bytes.parse(value!)
  expect(parsed, `cannot parse ${String(value)}`).not.toBeNull()
  return parsed!
}

describe('next.config.ts: images', () => {
  it('only optimizes images from the same-origin /media route, with no query string', () => {
    // search: '' forbids every query string: `?v=` on src is how an image URL changes meaning by itself without
    // changing its id. A versioned image gets a new id, not a parameter.
    expect(nextConfig.images?.localPatterns).toEqual([{ pathname: '/media/**', search: '' }])
  })

  it('opens no path to any other host', () => {
    // The backend is not published outside and sits at an internal IP: a remotePattern to it would need
    // dangerouslyAllowLocalIP, and would print the backend host name into the HTML.
    expect(nextConfig.images?.remotePatterns).toBeUndefined()
    expect(nextConfig.images?.domains).toBeUndefined()
    expect(nextConfig.images?.dangerouslyAllowLocalIP).toBeUndefined()
    expect(nextConfig.images?.dangerouslyAllowSVG).toBeUndefined()
    expect(nextConfig.images?.unoptimized).toBeUndefined()
  })

  it('serves AVIF with WebP as the fallback, at the two qualities the components use, cached for a year', () => {
    expect(nextConfig.images?.formats).toEqual(['image/avif', 'image/webp'])
    expect(nextConfig.images?.qualities).toEqual([IMAGE_QUALITY.standard, IMAGE_QUALITY.sharp])
    // A media id never changes its bytes, so the optimized copy needs no early revalidation.
    expect(nextConfig.images?.minimumCacheTTL).toBe(31_536_000)
  })

  it('caps the image cache at 64 MB, under the 96 MB tmpfs it lives on in the container', () => {
    // Over the tmpfs the least used images are never deleted and every write fails with ENOSPC once it is full.
    // scripts/test_container_hardening.py reads this number and the tmpfs size of docker-compose.yml and keeps them in step.
    expect(nextConfig.images?.maximumDiskCacheSize).toBe(64_000_000)
  })

  it('adds no outputFileTracingIncludes for sharp', () => {
    // Measured: native sharp loads in the Alpine standalone image.
    expect(nextConfig.outputFileTracingIncludes).toBeUndefined()
  })
})

describe('next.config.ts: incremental cache', () => {
  it('keeps rendered pages and the data cache in memory with the handler of the repository', () => {
    // The container's application tree is read-only (docker-compose.yml): the built-in cache would log a failed write for every render.
    expect(nextConfig.cacheHandler).toBe(join(process.cwd(), 'cache-handler.mjs'))
    expect(existsSync(nextConfig.cacheHandler!)).toBe(true)
  })

  it('does not touch the optimized-image cache, which stays on disk', () => {
    // images.customCacheHandler would send images through the in-memory handler; isrFlushToDisk: false would turn the image cache off.
    expect(nextConfig.images?.customCacheHandler).toBeUndefined()
    expect(nextConfig.experimental?.isrFlushToDisk).toBeUndefined()
  })
})

describe('next.config.ts: body limits', () => {
  it('a Server Action accepts at most 5 MiB, on purpose', () => {
    // Next reads EVERY multipart POST to EVERY page up to this limit before checking the action id,
    // so it is also the memory limit for an anonymous request. Raising it raises all of that.
    expect(nextConfig.experimental?.serverActions?.bodySizeLimit).toBe('5mb')
    expect(nextConfig.experimental?.proxyClientMaxBodySize).toBe('10mb')
  })

  it('the proxy always holds the whole body a Server Action may receive', () => {
    // proxy.ts matches /admin/*, exactly where the upload actions POST to. It clones the body and truncates
    // SILENTLY when proxyClientMaxBodySize is exceeded: the action receives a broken file with no
    // error. This relation is what must hold, not two separate numbers.
    const actionLimit = toBytes(nextConfig.experimental?.serverActions?.bodySizeLimit)
    const proxyLimit = toBytes(nextConfig.experimental?.proxyClientMaxBodySize)

    expect(actionLimit).toBeLessThan(proxyLimit)
  })

  it('leaves room for a 4 MB image already downsized in the browser plus the multipart overhead', () => {
    // The browser downsizes every file > 4 MB before sending, and the Next docs allow
    // 10–20 KB for the boundary, each part header and the accompanying fields.
    const actionLimit = toBytes(nextConfig.experimental?.serverActions?.bodySizeLimit)

    expect(toBytes('4mb') + toBytes('20kb')).toBeLessThan(actionLimit)
  })
})

describe('next.config.ts: how long a page may be served stale', () => {
  it('bounds stale-while-revalidate to an hour, for Next itself and for a CDN in front (issues 063, 064)', () => {
    // Default: one year. With it, a page nobody opened since a post was unpublished by a script gives its first visitor the old copy
    // however old it is, and a shared cache is told it may do the same for a year. `expireTime` is the length of the whole stale window
    // counted from the render: past it Next renders before it answers, and the header says `s-maxage=300, stale-while-revalidate=3300`.
    expect(nextConfig.expireTime).toBe(3600)
  })

  it('is longer than the 300 seconds of revalidation of the pages, or stale-while-revalidate would be zero', () => {
    expect(nextConfig.expireTime).toBeGreaterThan(300)
  })
})

describe('next.config.ts: the older parts are intact', () => {
  it('still builds standalone', () => {
    expect(nextConfig.output).toBe('standalone')
  })

  it('still redirects the three old filter URLs of the homepage, tag and category before the page', async () => {
    const redirects = await nextConfig.redirects!()
    const fromRoot = redirects.filter((r) => r.source === '/')

    expect(fromRoot).toEqual([
      {
        source: '/',
        has: [{ type: 'query', key: 'tag', value: '(?<tag>.*)' }],
        destination: '/tags/:tag',
        permanent: true,
      },
      {
        source: '/',
        has: [{ type: 'query', key: 'category', value: '(?<category>.*)' }],
        destination: '/categories/:category',
        permanent: true,
      },
      {
        source: '/',
        has: [{ type: 'query', key: 'page', value: '(?<page>.*)' }],
        destination: '/writing?page=:page',
        permanent: true,
      },
    ])
  })
})

describe('next.config.ts: tag and category indexes', () => {
  /**
   * The destination of the first redirect matching `pathname`, or null. Skips rules with `has`/`missing`
   * (the three old filter rules of `/`): this function does not read the query, so it must not guess that they match.
   */
  async function redirectTarget(pathname: string): Promise<string | null> {
    const redirects = await nextConfig.redirects!()
    const rule = redirects
      .filter((r) => !r.has && !r.missing)
      .find((r) => getPathMatch(r.source, { strict: true, removeUnnamedParams: true })(pathname))
    return rule?.destination ?? null
  }

  it('redirects /tags and /categories to /topics, permanently', async () => {
    // Two index paths that never had a page (only /tags/<slug>, /categories/<slug> exist), so
    // a reader trimming the URL to "go up a level" hit a 404. /topics lists both categories and tags.
    const redirects = await nextConfig.redirects!()

    expect(redirects.filter((r) => r.destination === '/topics')).toEqual([
      { source: '/tags', destination: '/topics', permanent: true },
      { source: '/categories', destination: '/topics', permanent: true },
    ])
    // The same two index paths under a locale prefix keep their locale.
    expect(redirects.filter((r) => r.destination === '/:locale/topics')).toEqual([
      { source: '/:locale(vi|en)/tags', destination: '/:locale/topics', permanent: true },
      { source: '/:locale(vi|en)/categories', destination: '/:locale/topics', permanent: true },
    ])
  })

  it('matches only the index paths, and does not touch the page of an individual tag or category', async () => {
    expect(await redirectTarget('/tags')).toBe('/topics')
    expect(await redirectTarget('/categories')).toBe('/topics')

    // The "not" counterpart: the page of each tag/category is still a real page, and /topics does not redirect
    // back to itself.
    expect(await redirectTarget('/tags/aws')).toBeNull()
    expect(await redirectTarget('/categories/kien-truc')).toBeNull()
    expect(await redirectTarget('/topics')).toBeNull()
  })

  it('redirects the index paths under a locale prefix to that locale topics page', async () => {
    expect(await redirectTarget('/en/tags')).toBe('/:locale/topics')
    expect(await redirectTarget('/en/categories')).toBe('/:locale/topics')
    expect(await redirectTarget('/en/tags/aws')).toBeNull()
    expect(await redirectTarget('/xx/tags')).toBeNull()
  })

  it('redirects the old hashed share-card URL of a post to the card route, permanently', async () => {
    const redirects = await nextConfig.redirects!()
    const rule = redirects.find((r) => r.source === '/posts/:slug/opengraph-image-1tl6ux/card')

    expect(rule).toEqual({
      source: '/posts/:slug/opengraph-image-1tl6ux/card',
      destination: '/api/og/posts/:slug',
      permanent: true,
    })
    const match = getPathMatch(rule!.source, { strict: true, removeUnnamedParams: true })
    expect(match('/posts/sample-post-05/opengraph-image-1tl6ux/card')).toEqual({ slug: 'sample-post-05' })
    expect(match('/posts/sample-post-05/opengraph-image-zzzzzz/card')).toBe(false)
  })

  it('redirects the three old filter URLs under a locale prefix, in the same order as the unprefixed ones', async () => {
    const redirects = await nextConfig.redirects!()
    const fromLocaleRoot = redirects.filter((r) => r.source === '/:locale(vi|en)')

    expect(fromLocaleRoot).toEqual([
      {
        source: '/:locale(vi|en)',
        has: [{ type: 'query', key: 'tag', value: '(?<tag>.*)' }],
        destination: '/:locale/tags/:tag',
        permanent: true,
      },
      {
        source: '/:locale(vi|en)',
        has: [{ type: 'query', key: 'category', value: '(?<category>.*)' }],
        destination: '/:locale/categories/:category',
        permanent: true,
      },
      {
        source: '/:locale(vi|en)',
        has: [{ type: 'query', key: 'page', value: '(?<page>.*)' }],
        destination: '/:locale/writing?page=:page',
        permanent: true,
      },
    ])
  })
})

/**
 * The `source` matcher of a header rule, built exactly like `buildCustomRoute('header', …)` in
 * router-utils/filesystem.js: strict, removeUnnamedParams, and `regexModifier` is
 * `modifyRouteRegex` (adds an optional trailing `/`). Without that step `/:path*` does not match `/` — measured
 * while writing this test — and the test would report the homepage missing a header while real Next still sends it.
 */
function headerMatcher(source: string) {
  return getPathMatch(source, {
    strict: true,
    removeUnnamedParams: true,
    regexModifier: (regex) => modifyRouteRegex(regex),
  })
}

/**
 * The effective headers of a path, computed like Next: every matching rule applies in order, a later rule overwrites
 * the same key (headers.md, "Header Overriding Behavior").
 */
async function effectiveHeaders(pathname: string): Promise<Record<string, string>> {
  const rules = await nextConfig.headers!()
  const out: Record<string, string> = {}
  for (const rule of rules) {
    expect(rule.has ?? rule.missing, 'these rules read neither query nor header').toBeUndefined()
    if (!headerMatcher(rule.source)(pathname)) continue
    for (const { key, value } of rule.headers) out[key.toLowerCase()] = value
  }
  return out
}

/** One representative per kind of route on the site: page, admin, route handler, OAuth, feed, uploaded image. */
const EVERY_KIND_OF_PATH = [
  '/',
  '/posts/xin-chao',
  '/series/series-a',
  '/login',
  '/profile',
  '/admin',
  '/admin/login',
  '/admin/posts/p1/edit',
  '/api/session',
  '/api/auth/github/callback',
  '/feed.xml',
  `/media/00000000-0000-4000-8000-000000000001.png`,
]

/**
 * No page of the site may be embedded in a frame of another site.
 * Liking a post, logging out and posting a comment are one-click actions, exactly what clickjacking targets.
 */
describe('next.config.ts: anti-framing', () => {
  afterEach(() => vi.unstubAllGlobals())

  const FRAME_ANCESTORS_NONE = /(^|;\s*)frame-ancestors 'none'\s*(;|$)/

  it('one rule for every path carrying both X-Frame-Options and frame-ancestors', async () => {
    // X-Frame-Options has been replaced by frame-ancestors (headers.md, the X-Frame-Options section), so send
    // both: an old browser understands the first, a new one the second.
    const rules = await nextConfig.headers!()
    const everyPath = rules.find((rule) => rule.source === '/:path*')

    expect(everyPath?.headers).toEqual(expect.arrayContaining([{ key: 'X-Frame-Options', value: 'DENY' }]))
    const policy = everyPath?.headers.find(({ key }) => key === 'Content-Security-Policy')?.value ?? ''
    expect(policy).toMatch(FRAME_ANCESTORS_NONE)
  })

  it.each(EVERY_KIND_OF_PATH)('%s cannot be embedded in a frame', async (pathname) => {
    const headers = await effectiveHeaders(pathname)

    expect(headers['x-frame-options']).toBe('DENY')
    expect(headers['content-security-policy']).toMatch(FRAME_ANCESTORS_NONE)
  })

  it('/media keeps the CSP of that route itself: Next drops the route header when the config already set the same name', async () => {
    // Measured in node_modules/next 16.3.7: router-server.js puts the config headers on the response BEFORE
    // the route runs, then send-response.js only copies a route header when the response does not already have
    // that header. A shared CSP for every path would therefore silently replace the `sandbox; script-src 'none'`
    // of an uploaded image. The separate /media rule restates exactly the route's own policy, plus frame-ancestors.
    const file = '00000000-0000-4000-8000-000000000001.png'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('png', { status: 200 })),
    )
    const { GET } = await import('./app/media/[file]/route')
    const res = await GET(new Request(`http://localhost/media/${file}`), { params: Promise.resolve({ file }) })
    const routePolicy = res.headers.get('content-security-policy')
    expect(routePolicy, 'does the /media route no longer set its own CSP?').toBeTruthy()

    const effective = (await effectiveHeaders(`/media/${file}`))['content-security-policy']!
    const directives = (policy: string) =>
      policy
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean)
    expect(directives(effective)).toEqual(expect.arrayContaining(directives(routePolicy!)))
    expect(effective).toMatch(FRAME_ANCESTORS_NONE)
  })

  // Stage 2 of the CSP plan (docs/SECURITY.md): the full policy is enforced, in one header, with frame-ancestors in it.
  it('the shared CSP is the full policy, enforced in one header; there is no Report-Only header any more', async () => {
    const rules = await nextConfig.headers!()
    const everyPath = rules.find((rule) => rule.source === '/:path*')

    const enforced = everyPath?.headers.filter(({ key }) => key === 'Content-Security-Policy')
    expect(enforced).toHaveLength(1)
    const policy = enforced![0]!.value
    for (const directive of [
      "default-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-src 'none'",
      "frame-ancestors 'none'",
      "connect-src 'self'",
    ]) {
      expect(policy.split('; ')).toContain(directive)
    }
    expect(policy).not.toContain('nonce-')
    expect(policy).not.toContain("'unsafe-eval'")
    for (const rule of rules) {
      expect(
        rule.headers.some(({ key }) => key === 'Content-Security-Policy-Report-Only'),
        rule.source,
      ).toBe(false)
    }
  })

  it('names the endpoint that the policy reports to, on the same origin', async () => {
    const headers = await effectiveHeaders('/en/writing')

    expect(headers['reporting-endpoints']).toBe('csp-endpoint="/api/csp-report"')
    const policy = headers['content-security-policy'] ?? ''
    expect(policy.split('; ')).toContain('report-uri /api/csp-report')
    expect(policy.split('; ')).toContain('report-to csp-endpoint')
  })

  it('the policy reaches the HTML pages and leaves the /media policy as the route sets it', async () => {
    const page = await effectiveHeaders('/en/writing')
    expect(page['content-security-policy']).toContain("script-src 'self'")
    const media = await effectiveHeaders('/media/00000000-0000-4000-8000-000000000001.png')
    expect(media['content-security-policy']).toContain('sandbox')
    expect(media['content-security-policy']).not.toContain("default-src 'self'")
  })
})

/**
 * The standard defensive headers. Next puts the config headers on the response before the route runs
 * (the mechanism in the block above), so any header a route handler sets itself under the same name must be restated by the config
 * with exactly that value for its path, like /media with CSP and OAuth with Referrer-Policy.
 */
describe('next.config.ts: security headers', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('does not send X-Powered-By: Next.js', () => {
    expect(nextConfig.poweredByHeader).toBe(false)
  })

  it.each(EVERY_KIND_OF_PATH)(
    '%s: nosniff, Referrer-Policy, Permissions-Policy turning off camera, microphone, location',
    async (pathname) => {
      const headers = await effectiveHeaders(pathname)

      expect(headers['x-content-type-options']).toBe('nosniff')
      expect(headers['referrer-policy']).toBe(
        pathname.startsWith('/api/auth/github/') ? 'no-referrer' : 'strict-origin-when-cross-origin',
      )
      // No page uses the camera, microphone or location, and markdown strips every iframe (lib/markdown.tsx).
      expect(headers['permissions-policy']).toBe('camera=(), microphone=(), geolocation=()')
    },
  )

  it.each(['/api/auth/github/start', '/api/auth/github/callback'])(
    '%s keeps the route own `Referrer-Policy: no-referrer`: a URL carrying code and state does not travel in the Referer',
    async (pathname) => {
      // The shared `strict-origin-when-cross-origin` rule would silently replace the `no-referrer` that oauthRedirect
      // sets on every OAuth response; the specific rule after it restates the route's exact value.
      const { oauthRedirect } = await import('./lib/oauth-flow-cookie')
      const routePolicy = oauthRedirect('/').headers.get('referrer-policy')
      expect(routePolicy, 'does oauthRedirect no longer set its own Referrer-Policy?').toBe('no-referrer')

      expect((await effectiveHeaders(pathname))['referrer-policy']).toBe(routePolicy)
    },
  )

  it('the no-referrer rule covers only the OAuth path, not the other routes next to it', async () => {
    for (const pathname of ['/api/auth/logout', '/api/auth/githubx', '/api/session', '/login', '/admin/login']) {
      expect((await effectiveHeaders(pathname))['referrer-policy'], pathname).toBe('strict-origin-when-cross-origin')
    }
  })

  it.each([
    '/newsletter/confirm',
    '/newsletter/unsubscribe',
    '/newsletter',
    '/en/newsletter/confirm',
    '/en/newsletter/unsubscribe',
  ])(
    '%s: `Referrer-Policy: no-referrer`, a URL carrying a token does not travel in the Referer; the other headers stay intact',
    async (pathname) => {
      // The specific rule comes AFTER the shared one: the later rule wins on the same key. Swap the order and the token travels in the Referer again.
      const headers = await effectiveHeaders(pathname)

      expect(headers['referrer-policy']).toBe('no-referrer')
      expect(headers['x-frame-options']).toBe('DENY')
      expect(headers['content-security-policy']).toContain("frame-ancestors 'none'")
      expect(headers['content-security-policy']).toContain("default-src 'self'")
      expect(headers['x-content-type-options']).toBe('nosniff')
    },
  )

  it('the newsletter no-referrer rule is a path prefix, and does not cover the path next to it or the BFF route', async () => {
    for (const pathname of ['/newsletters', '/api/newsletter/unsubscribe']) {
      expect((await effectiveHeaders(pathname))['referrer-policy'], pathname).toBe('strict-origin-when-cross-origin')
    }
  })

  it.each(['/setup', '/setup/submit'])('%s: no Referer, not cached; the other headers stay intact', async (pathname) => {
    const headers = await effectiveHeaders(pathname)

    expect(headers['referrer-policy']).toBe('no-referrer')
    expect(headers['cache-control']).toBe('no-store')
    expect(headers['x-frame-options']).toBe('DENY')
    expect(headers['x-content-type-options']).toBe('nosniff')
  })

  it('the setup rule does not cover the path next to it', async () => {
    for (const pathname of ['/setups', '/en/setup']) {
      expect((await effectiveHeaders(pathname))['cache-control'], pathname).toBeUndefined()
    }
  })

  it('exactly this set of headers, no more: adding a header is a decision, not a silent line', async () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'http://localhost:3000')
    const keys = new Set((await nextConfig.headers!()).flatMap((rule) => rule.headers.map(({ key }) => key)))

    expect([...keys].sort()).toEqual([
      'Cache-Control',
      'Content-Security-Policy',
      'Permissions-Policy',
      'Referrer-Policy',
      'Reporting-Endpoints',
      'X-Content-Type-Options',
      'X-Frame-Options',
    ])
  })

  /**
   * HSTS only when the public origin at build time is https. It is written into the build (`next build` runs
   * `headers()` once), so it reads NEXT_PUBLIC_SITE_URL, a variable that already has to exist at build time. HSTS sent through
   * a site without working HTTPS locks readers out of the site until max-age expires: the default is one day.
   */
  describe('HSTS', () => {
    async function hsts(pathname = '/'): Promise<string | undefined> {
      return (await effectiveHeaders(pathname))['strict-transport-security']
    }

    it.each([undefined, '', '   ', 'http://localhost:3000', 'http://localhost:3100', 'http://blog.example.com'])(
      'NEXT_PUBLIC_SITE_URL=%j: does not send Strict-Transport-Security',
      async (site) => {
        vi.stubEnv('NEXT_PUBLIC_SITE_URL', site)
        // HSTS_MAX_AGE alone cannot turn it on.
        vi.stubEnv('HSTS_MAX_AGE', '31536000')

        const rules = await nextConfig.headers!()
        expect(rules.flatMap((rule) => rule.headers).map(({ key }) => key)).not.toContain('Strict-Transport-Security')
      },
    )

    it('https: max-age=86400 by default on every path; no includeSubDomains, no preload', async () => {
      vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://blog.example.com')
      vi.stubEnv('HSTS_MAX_AGE', undefined)

      for (const pathname of EVERY_KIND_OF_PATH) expect(await hsts(pathname), pathname).toBe('max-age=86400')
    })

    it('HSTS_MAX_AGE sets max-age: raise it to a year once HTTPS runs reliably', async () => {
      vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://blog.example.com/')
      vi.stubEnv('HSTS_MAX_AGE', '31536000')

      expect(await hsts()).toBe('max-age=31536000')
    })

    it('HSTS_MAX_AGE=0 turns HSTS off per RFC 6797: sends max-age=0 so the browser forgets the remembered policy', async () => {
      // Dropping the header entirely means any browser that already got the old max-age keeps forcing HTTPS until it expires; max-age=0 clears it
      // on the next visit over HTTPS. This is the way back when HTTPS has to be withdrawn.
      vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://blog.example.com')
      vi.stubEnv('HSTS_MAX_AGE', '0')

      expect(await hsts()).toBe('max-age=0')
    })

    it.each(['true', ' TRUE '])(
      'HSTS_INCLUDE_SUBDOMAINS=%j adds includeSubDomains on every path, and nothing else changes',
      async (value) => {
        vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://example.test')
        vi.stubEnv('HSTS_MAX_AGE', '31536000')
        vi.stubEnv('HSTS_INCLUDE_SUBDOMAINS', value)

        for (const pathname of EVERY_KIND_OF_PATH)
          expect(await hsts(pathname), pathname).toBe('max-age=31536000; includeSubDomains')
      },
    )

    it.each([undefined, '', 'false', '1', 'yes', 'true; preload'])(
      'HSTS_INCLUDE_SUBDOMAINS=%j adds nothing: only the exact word true opts in, and never preload',
      async (value) => {
        vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://example.test')
        vi.stubEnv('HSTS_MAX_AGE', '31536000')
        vi.stubEnv('HSTS_INCLUDE_SUBDOMAINS', value)

        const sent = await hsts()
        expect(sent).toBe('max-age=31536000')
        expect(sent).not.toContain('preload')
      },
    )

    it('HSTS_INCLUDE_SUBDOMAINS alone does not turn HSTS on over http, and max-age=0 stays a plain kill switch', async () => {
      vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'http://example.test')
      vi.stubEnv('HSTS_INCLUDE_SUBDOMAINS', 'true')
      expect(await hsts()).toBeUndefined()

      vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://example.test')
      vi.stubEnv('HSTS_MAX_AGE', '0')
      expect(await hsts()).toBe('max-age=0')
    })

    describe('the build notice', () => {
      it('says once per headers() call (one per build) that the max-age is under a year, when the origin is https', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {})
        vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://example.test')
        vi.stubEnv('HSTS_MAX_AGE', undefined)

        await nextConfig.headers!()

        const lines = info.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('Strict-Transport-Security'))
        expect(lines).toHaveLength(1)
        expect(lines[0]).toContain('86400')
        expect(lines[0]).toContain('HSTS_MAX_AGE=31536000')
        info.mockRestore()
      })

      it.each([
        ['http origin', 'http://example.test', '86400'],
        ['a year', 'https://example.test', '31536000'],
        ['more than a year', 'https://example.test', '63072000'],
        ['the kill switch', 'https://example.test', '0'],
      ])('stays silent for %s', async (_name, site, maxAge) => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {})
        vi.stubEnv('NEXT_PUBLIC_SITE_URL', site)
        vi.stubEnv('HSTS_MAX_AGE', maxAge)

        await nextConfig.headers!()

        expect(
          info.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('Strict-Transport-Security')),
        ).toEqual([])
        info.mockRestore()
      })
    })

    it.each(['', ' ', 'abc', '-1', '1.5', '1d', '86400; includeSubDomains'])(
      'HSTS_MAX_AGE=%j is not a number of seconds so the default 86400 is used',
      async (value) => {
        vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://blog.example.com')
        vi.stubEnv('HSTS_MAX_AGE', value)

        expect(await hsts()).toBe('max-age=86400')
      },
    )
  })
})

describe('vitest.config.mts', () => {
  it('skips the e2e directory while keeping the default exclusions', () => {
    // Vitest default include also matches *.spec.ts, so the Playwright tests in e2e/ would
    // run under jsdom and fail. Overriding `exclude` and forgetting the defaults makes Vitest scan
    // node_modules too. It reads the source because importing a .mts file from here needs a tsconfig flag the repo does not enable.
    const source = readFileSync(join(process.cwd(), 'vitest.config.mts'), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

    expect(code).toMatch(/exclude:\s*\[\s*\.\.\.configDefaults\.exclude,\s*'e2e\/\*\*'\s*,?\s*\]/)
    expect(code).toMatch(/import\s*\{[^}]*\bconfigDefaults\b[^}]*\}\s*from\s*'vitest\/config'/)
  })
})
