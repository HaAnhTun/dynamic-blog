// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { absoluteUrl, categoryFeedPath, seriesFeedPath, siteUrl, siteUrlObject, tagFeedPath } from './site'
import { SLUG_GO_LOI } from '@/test/fixtures/vi/accented-text'

/**
 * The case that matters is the empty string.
 *
 * `app/layout.tsx` used `process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'`, and
 * `??` falls back only on null and undefined. With `NEXT_PUBLIC_SITE_URL=` in a .env file
 * the value is `''`, `new URL('')` throws, and because that happens inside `metadataBase`
 * it throws while generating metadata for every route — so every page on the site 500s.
 * Reachable from this repository's own Dockerfile, which declares the variable as a build
 * arg.
 *
 * Three other files had each worked the same rule out independently and written it
 * correctly. Four copies is how three end up right and one wrong with nobody noticing.
 */
describe('siteUrl', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('falls back when the variable is the empty string', () => {
    // The regression. `??` would return '' here and every page would 500.
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '')
    expect(siteUrl()).toBe('http://localhost:3000')
  })

  it('falls back when the variable is whitespace', () => {
    // `NEXT_PUBLIC_SITE_URL= ` with a trailing space is the same mistake wearing a
    // disguise: not empty, and still not an origin.
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '   ')
    expect(siteUrl()).toBe('http://localhost:3000')
  })

  it('falls back when the variable is absent', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', undefined)
    expect(siteUrl()).toBe('http://localhost:3000')
  })

  it('uses a configured origin', () => {
    // The positive control. Without it, a function hardcoded to the fallback would pass
    // every test above.
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://example.com')
    expect(siteUrl()).toBe('https://example.com')
  })

  it('strips a trailing slash, however many', () => {
    // `https://example.com/` in a .env file is at least as likely as the version without,
    // and `${siteUrl()}/writing` would otherwise produce `https://example.com//writing`.
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://example.com/')
    expect(siteUrl()).toBe('https://example.com')
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://example.com///')
    expect(siteUrl()).toBe('https://example.com')
  })

  it('trims surrounding whitespace rather than failing on it', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '  https://example.com  ')
    expect(siteUrl()).toBe('https://example.com')
  })
})

describe('siteUrlObject', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('parses a configured origin', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://example.com')
    expect(siteUrlObject().origin).toBe('https://example.com')
  })

  it('never throws on an empty variable, which is the whole point', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '')
    expect(() => siteUrlObject()).not.toThrow()
  })

  it('raises a message naming the variable when the value cannot be a URL', () => {
    // A bare hostname with no scheme does not parse. The bare `TypeError: Invalid URL`
    // that Next would otherwise surface from inside metadata generation names neither the
    // variable nor the value, which is the difference between a two-minute fix and an
    // afternoon.
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'example.com')
    expect(() => siteUrlObject()).toThrow(/NEXT_PUBLIC_SITE_URL is not a usable origin: "example\.com"/)
  })
})

describe('absoluteUrl', () => {
  afterEach(() => vi.unstubAllEnvs())

  it.each([
    ['/writing', 'https://example.com/writing'],
    ['writing', 'https://example.com/writing'],
    ['/posts/abc', 'https://example.com/posts/abc'],
    ['/', 'https://example.com/'],
    ['', 'https://example.com/'],
    // A path that already carries a slash must not double it — the bug this and the
    // trailing-slash strip together exist to prevent.
    ['//writing', 'https://example.com/writing'],
  ])('%s -> %s', (path, expected) => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://example.com')
    expect(absoluteUrl(path)).toBe(expected)
  })
})

describe('own feed', () => {
  it('is <page>/feed.xml, the slug encoded like the page href and not escaping its own segment', () => {
    expect(categoryFeedPath('kien-truc')).toBe('/categories/kien-truc/feed.xml')
    expect(seriesFeedPath('series-a')).toBe('/series/series-a/feed.xml')
    expect(tagFeedPath(SLUG_GO_LOI)).toBe(`/tags/${encodeURIComponent(SLUG_GO_LOI)}/feed.xml`)
    expect(tagFeedPath('a/../b')).toBe('/tags/a%2F..%2Fb/feed.xml')
  })
})
