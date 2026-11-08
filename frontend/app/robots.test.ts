import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPosts } from '@/lib/api'
import { getCategories, getTags } from '@/lib/taxonomy'
import robots from './robots'
import sitemap from './sitemap'

/**
 * `robots` itself touches no data, but this file imports `sitemap` to prove the two
 * agree on the origin (see the last describe block), and app/sitemap.ts imports the API
 * client — so the client has to be mocked here too or the import graph pulls in
 * `server-only` and a real fetch.
 */
vi.mock('@/lib/api', () => ({ getPosts: vi.fn() }))
vi.mock('@/lib/taxonomy', () => ({ getCategories: vi.fn(), getTags: vi.fn() }))

const ORIGIN = 'https://blog.example.com'

/** The shape of a single-rule `MetadataRoute.Robots`, which is what this file returns. */
function singleRule() {
  const { rules } = robots()
  if (Array.isArray(rules)) throw new Error('expected one rule object, not an array')
  return rules
}

function asArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', ORIGIN)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('the rules', () => {
  it('allows the whole site to every crawler', async () => {
    const rules = singleRule()

    expect(rules.userAgent).toBe('*')
    expect(asArray(rules.allow)).toContain('/')
  })

  it('disallows /admin', () => {
    // Behind a login, so this is not a security control — robots.txt is public and
    // advisory, and the authorization that protects /admin lives in the backend. The
    // point is that there is no reason for a login form to be in an index.
    expect(asArray(singleRule().disallow)).toContain('/admin')
  })

  it('disallows /api', () => {
    expect(asArray(singleRule().disallow)).toContain('/api')
  })

  it('blocks /random: it is only a random 307 redirect, nothing to index', () => {
    // A crawler following /random would get a different post each time under the same URL. The posts are still
    // crawled through the sitemap and ordinary links; only this random door is blocked.
    expect(asArray(singleRule().disallow)).toContain('/random')
  })

  it('disallows nothing else', () => {
    // An exact set. `Disallow: /posts` slipped in here would de-index every article on
    // the site while every other test in this file stayed green.
    expect(new Set(asArray(singleRule().disallow))).toEqual(new Set(['/admin', '/api', '/random']))
  })

  it('relies on prefix matching rather than listing the admin sub-paths', () => {
    const disallow = asArray(singleRule().disallow)

    // `Disallow: /admin` is a prefix match in the Robots Exclusion Standard, so it
    // already covers /admin/posts and /admin/posts/new. What would NOT cover /admin
    // itself is the trailing-slash spelling, so this pins that it is absent: if someone
    // "tidies" `/admin` into `/admin/`, the login page becomes crawlable again.
    expect(disallow).not.toContain('/admin/')
    expect(disallow.every((path) => !path.endsWith('/') || path === '/')).toBe(true)
  })

  it('does not disallow the public sections', () => {
    const disallow = asArray(singleRule().disallow)

    for (const path of ['/posts', '/writing', '/about', '/categories', '/tags']) {
      expect(disallow.some((rule) => path.startsWith(rule))).toBe(false)
    }
  })

  it('does not block uploaded images: the post og:image points into /media', () => {
    // X/Twitterbot does not fetch an og:image under a Disallowed path. Images are at /media and not
    // at /api for exactly that reason — and /random is a prefix that does not collide with /media.
    const disallow = asArray(singleRule().disallow)

    for (const path of ['/media/0b9a5a4e-7c1d-4f7e-8f52-3c1e2d9a6b10.jpg', '/_next/image']) {
      expect(disallow.some((rule) => path.startsWith(rule))).toBe(false)
    }
    expect(disallow).toContain('/api')
  })

  it('sets no crawlDelay', () => {
    // A crawl delay is a throttle on indexing; Google ignores it and Bing honours it,
    // so the only effect of a guessed value is a slower crawl of a small blog.
    expect(singleRule()).not.toHaveProperty('crawlDelay')
  })
})

describe('the sitemap directive', () => {
  it('names the sitemap absolutely, on the configured origin', () => {
    // Absolute and required to be: the Sitemap directive is the one line in robots.txt
    // a crawler will not resolve relative to the host it fetched the file from.
    expect(robots().sitemap).toBe(`${ORIGIN}/sitemap.xml`)
    expect(new URL(String(robots().sitemap)).origin).toBe(ORIGIN)
  })

  it('points at the path Next actually serves the sitemap at', () => {
    // app/sitemap.ts is served at /sitemap.xml — the file convention, not /sitemap.
    expect(new URL(String(robots().sitemap)).pathname).toBe('/sitemap.xml')
  })

  it('strips a trailing slash from the configured origin', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', `${ORIGIN}/`)

    // `https://blog.example.com//sitemap.xml` is a different URL to every crawler and
    // cache, and on most servers a 404.
    expect(robots().sitemap).toBe(`${ORIGIN}/sitemap.xml`)
  })

  it('falls back to localhost when the env var is unset, empty or whitespace', () => {
    for (const value of [undefined, '', '   ']) {
      vi.stubEnv('NEXT_PUBLIC_SITE_URL', value)
      expect(robots().sitemap).toBe('http://localhost:3000/sitemap.xml')
    }
  })
})

describe('robots.txt and sitemap.xml must not disagree about the origin', () => {
  /**
   * The reason this test exists rather than a shared constant: app/robots.ts and
   * app/sitemap.ts each resolve the origin themselves, because neither app/layout.tsx
   * nor components/site/ArticleJsonLd.tsx (the two files that already hold the same
   * expression) belongs to this agent, and a named export from app/sitemap.ts is
   * re-exported onto the generated route module by next-metadata-route-loader — which
   * `next build` would have to clear, and running it is out of scope here.
   *
   * So the duplication is caught instead of prevented. A `Sitemap:` line whose origin
   * disagrees with the sitemap's own `<loc>` entries tells a crawler to fetch a host
   * that the sitemap it finds there does not describe.
   */
  it.each([ORIGIN, `${ORIGIN}/`, 'http://localhost:3000', '', '   ', undefined])(
    'resolves the same origin as the sitemap for NEXT_PUBLIC_SITE_URL=%o',
    async (value) => {
      vi.stubEnv('NEXT_PUBLIC_SITE_URL', value)
      vi.mocked(getPosts).mockResolvedValue({
        items: [],
        meta: { page: 0, size: 100, totalElements: 0, totalPages: 0 },
      })
      vi.mocked(getCategories).mockResolvedValue([])
      vi.mocked(getTags).mockResolvedValue([])

      const sitemapOrigin = new URL((await sitemap())[0].url).origin
      const robotsOrigin = new URL(String(robots().sitemap)).origin

      expect(robotsOrigin).toBe(sitemapOrigin)
    },
  )
})
