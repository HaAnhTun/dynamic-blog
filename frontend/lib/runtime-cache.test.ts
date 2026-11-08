// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_ROUTE_CACHE_MAX_MB,
  clearPersistedPages,
  pruneRouteCache,
  routeCacheMaxBytes,
  startRuntimeCacheGuard,
} from './runtime-cache'

/**
 * A `.next` folder as `next build` and a running server leave it, in a temporary directory: the build-time pages of the manifest in
 * `server/app`, a page written at run time in `server/route-cache`, a cached backend answer in `cache/fetch-cache`, and the files that
 * must stay (route modules, the image cache, a page that never revalidates).
 */
let dist: string

function put(relative: string, size = 10, modified?: number): string {
  const path = join(dist, relative)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, 'x'.repeat(size))
  if (modified !== undefined) utimesSync(path, modified / 1000, modified / 1000)
  return path
}

beforeEach(() => {
  dist = mkdtempSync(join(tmpdir(), 'runtime-cache-'))
  writeFileSync(
    join(dist, 'prerender-manifest.json'),
    JSON.stringify({
      routes: {
        '/vi/posts/hello': { routeType: 'page', initialRevalidateSeconds: 300 },
        '/en/posts/hello': { routeType: 'page', initialRevalidateSeconds: 300 },
        '/_global-error': { routeType: 'page', initialRevalidateSeconds: false },
        '/icon.png': { routeType: 'route', initialRevalidateSeconds: false },
        '/opengraph-image': { routeType: 'route', initialRevalidateSeconds: 300 },
        '/../../escape': { routeType: 'page', initialRevalidateSeconds: 300 },
      },
    }),
  )
})

afterEach(() => {
  rmSync(dist, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const ROUTE_CACHE = 'server/route-cache/APP_PAGE/abc/$/vi/posts'

describe('clearPersistedPages: nothing written before this start can be served after it', () => {
  it('removes the entries of a page that revalidates, built or rendered at run time, and every cached backend answer', async () => {
    const built = [
      'vi/posts/hello.html',
      'vi/posts/hello.rsc',
      'vi/posts/hello.meta',
      'vi/posts/hello.segments/_full.segment.rsc',
    ]
    for (const file of built) put(`server/app/${file}`)
    put('server/app/en/posts/hello.html')
    put(`${ROUTE_CACHE}/random-slug.html`)
    put(`${ROUTE_CACHE}/random-slug.segments/_tree.segment.rsc`)
    put('cache/fetch-cache/0123abcd')

    const removed = await clearPersistedPages(dist)

    expect(removed).toBeGreaterThanOrEqual(7)
    for (const file of built) expect(existsSync(join(dist, 'server/app', file))).toBe(false)
    expect(existsSync(join(dist, 'server/app/en/posts/hello.html'))).toBe(false)
    expect(existsSync(join(dist, 'server/route-cache'))).toBe(false)
    expect(existsSync(join(dist, 'cache/fetch-cache'))).toBe(false)
  })

  it('leaves what is not a cache of the data: route modules, pages that never revalidate, route handler bodies, the image cache', async () => {
    const keep = [
      'server/app/vi/posts/[slug]/page.js',
      'server/app/_global-error.html',
      'server/app/icon.png.body',
      'server/app/icon.png.meta',
      'server/app/opengraph-image.body',
      'server/app/opengraph-image.meta',
      'cache/images/abc/1.png',
      'prerender-manifest.json',
    ]
    for (const file of keep) put(file)
    put('server/app/vi/posts/hello.html')

    await clearPersistedPages(dist)

    for (const file of keep) expect(existsSync(join(dist, file)), file).toBe(true)
  })

  it('never goes outside the folder, whatever a route of the manifest says', async () => {
    const outside = join(dist, '..', 'escape.html')
    writeFileSync(outside, 'keep')
    try {
      await clearPersistedPages(dist)
      expect(existsSync(outside)).toBe(true)
    } finally {
      rmSync(outside, { force: true })
    }
  })

  it('does not throw without a manifest or without any cache folder', async () => {
    rmSync(join(dist, 'prerender-manifest.json'))
    expect(await clearPersistedPages(dist)).toBe(0)
    expect(await clearPersistedPages(join(dist, 'missing'))).toBe(0)
  })
})

describe('pruneRouteCache: a flood of random slugs cannot fill the disk', () => {
  const page = (slug: string, modified: number) => {
    put(`${ROUTE_CACHE}/${slug}.html`, 100, modified)
    put(`${ROUTE_CACHE}/${slug}.rsc`, 100, modified)
  }

  it('does nothing under the cap', async () => {
    page('a', 1_000)
    expect(await pruneRouteCache(dist, 1_000)).toBe(0)
    expect(existsSync(join(dist, ROUTE_CACHE, 'a.html'))).toBe(true)
  })

  it('removes the oldest files first until the folder is down to 80 percent of the cap', async () => {
    for (let i = 0; i < 10; i++) page(`slug-${i}`, 1_000 + i)

    // 2,000 bytes against a cap of 1,000: down to 800, so the 12 oldest files of 20 go and the 8 newest stay.
    const removed = await pruneRouteCache(dist, 1_000)

    expect(removed).toBe(12)
    expect(existsSync(join(dist, ROUTE_CACHE, 'slug-0.html'))).toBe(false)
    expect(existsSync(join(dist, ROUTE_CACHE, 'slug-5.rsc'))).toBe(false)
    expect(existsSync(join(dist, ROUTE_CACHE, 'slug-9.html'))).toBe(true)
    expect(existsSync(join(dist, ROUTE_CACHE, 'slug-9.rsc'))).toBe(true)
  })

  it('never touches the pages built with the image or the cached backend answers', async () => {
    put('server/app/vi/posts/hello.html', 5_000)
    put('cache/fetch-cache/0123abcd', 5_000)
    for (let i = 0; i < 10; i++) page(`slug-${i}`, 1_000 + i)

    await pruneRouteCache(dist, 1_000)

    expect(existsSync(join(dist, 'server/app/vi/posts/hello.html'))).toBe(true)
    expect(existsSync(join(dist, 'cache/fetch-cache/0123abcd'))).toBe(true)
  })

  it('does not throw when there is no route cache yet', async () => {
    expect(await pruneRouteCache(dist, 1)).toBe(0)
  })
})

describe('routeCacheMaxBytes: ROUTE_CACHE_MAX_MB', () => {
  it('is a whole number of megabytes, 0 for no limit, and the default for anything else', () => {
    expect(routeCacheMaxBytes('64')).toBe(64 * 1024 * 1024)
    expect(routeCacheMaxBytes(' 64 ')).toBe(64 * 1024 * 1024)
    expect(routeCacheMaxBytes('0')).toBe(Number.POSITIVE_INFINITY)
    for (const bad of [undefined, '', 'big', '-5', '1.5', '64MB', '9999999']) {
      expect(routeCacheMaxBytes(bad), String(bad)).toBe(DEFAULT_ROUTE_CACHE_MAX_MB * 1024 * 1024)
    }
  })
})

describe('startRuntimeCacheGuard', () => {
  it('clears at start, then prunes every half minute, and logs counts and never a path', async () => {
    vi.useFakeTimers()
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    put(`${ROUTE_CACHE}/secret-slug.html`, 100)

    await startRuntimeCacheGuard(dist, { ROUTE_CACHE_MAX_MB: '1' })
    expect(existsSync(join(dist, 'server/route-cache'))).toBe(false)

    put(`${ROUTE_CACHE}/flood-1.html`, 700_000, 1_000)
    put(`${ROUTE_CACHE}/flood-2.html`, 700_000, 2_000)
    vi.advanceTimersByTime(30_000)

    // The walk is asynchronous: the files go a few turns of the file system later.
    await vi.waitFor(() => expect(existsSync(join(dist, ROUTE_CACHE, 'flood-1.html'))).toBe(false))
    expect(existsSync(join(dist, ROUTE_CACHE, 'flood-2.html'))).toBe(true)
    const lines = info.mock.calls.map((call) => String(call[0]))
    expect(lines.some((line) => /cleared 1 persisted/.test(line))).toBe(true)
    await vi.waitFor(() =>
      expect(info.mock.calls.map((call) => String(call[0])).some((line) => /removed 1 files/.test(line))).toBe(true),
    )
    expect(info.mock.calls.map((call) => String(call[0])).join('\n')).not.toMatch(/slug|flood/)
  })

  it('starts no timer when the size is unlimited', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'info').mockImplementation(() => undefined)

    await startRuntimeCacheGuard(dist, { ROUTE_CACHE_MAX_MB: '0' })

    expect(vi.getTimerCount()).toBe(0)
  })
})
