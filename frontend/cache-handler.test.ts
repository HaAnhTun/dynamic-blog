// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CacheHandler from './cache-handler.mjs'

/**
 * The cache handler that keeps ISR output and the data cache in memory (cache-handler.mjs). The stack runs with a read-only
 * root file system and the application tree owned by root (docker-compose.yml, docs/SECURITY.md "Containers"), so Next must
 * not write under `.next/server`. These tests run the real class of the installed Next, because what it relies on
 * (the module path, the tag semantics) is what an upgrade can change.
 */

/** The file system Next hands to a cache handler (next/dist/server/lib/node-fs-methods.js), with every write turned into a failure. */
const readOnlyFs = {
  existsSync,
  readFile,
  readFileSync,
  stat,
  writeFile: () => Promise.reject(new Error('EROFS: write to the file system')),
  writeFileAtomic: () => Promise.reject(new Error('EROFS: write to the file system')),
  mkdir: () => Promise.reject(new Error('EROFS: write to the file system')),
}

function listing(dir: string): string[] {
  return readdirSync(dir, { recursive: true }).map(String).sort()
}

let root: string
let serverDistDir: string

/**
 * What the tests call on the handler. Next types the keys and values with enums of its internals (`IncrementalCacheKind.FETCH`, not
 * 'FETCH'); the plain strings are what it passes at run time, so the handler is typed by what the tests use of it.
 */
type Handler = {
  get(key: string, context: Record<string, unknown>): Promise<{ value: Record<string, unknown> } | null>
  set(key: string, data: Record<string, unknown>, context: Record<string, unknown>): Promise<void>
  revalidateTag(tags: string[]): Promise<void>
}

function handler(overrides: Record<string, unknown> = {}): Handler {
  const context = {
    fs: readOnlyFs,
    serverDistDir,
    dev: false,
    flushToDisk: true,
    maxMemoryCacheSize: 5_000_000,
    revalidatedTags: [],
    _requestHeaders: {},
    ...overrides,
  }
  return new CacheHandler(context as never) as unknown as Handler
}

const entry = (body: string) => ({
  kind: 'FETCH' as const,
  data: { headers: {}, body, url: 'http://backend/api', status: 200 },
  revalidate: 300,
})
const setContext = { fetchCache: true, tags: ['posts'], fetchIdx: 0, fetchUrl: 'http://backend/api' }
const getContext = { kind: 'FETCH' as const, tags: ['posts'], softTags: [], fetchIdx: 0, fetchUrl: 'http://backend/api' }

/**
 * Next compares a tag with the millisecond an entry was stored, and its clock (`performance.timeOrigin + performance.now()`) can run a
 * millisecond behind `Date.now()`: leave a few milliseconds before and after revalidating.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 8))

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cache-handler-'))
  serverDistDir = join(root, '.next', 'server')
  mkdirSync(join(serverDistDir, 'app', 'en'), { recursive: true })
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe('cache-handler.mjs', () => {
  it('stores and returns an entry without writing to the file system', async () => {
    const cache = handler()
    const before = listing(root)

    await expect(cache.set('/fetch/store-read', entry('one'), setContext)).resolves.toBeUndefined()
    const found = await cache.get('/fetch/store-read', getContext)

    expect(found?.value).toMatchObject({ kind: 'FETCH', data: { body: 'one' } })
    expect(listing(root)).toEqual(before)
  })

  it('does not write ISR pages either (the failure that was logged as "Failed to update prerender cache")', async () => {
    const cache = handler()
    const before = listing(root)
    const page = {
      kind: 'APP_PAGE' as const,
      html: '<html>post</html>',
      rscData: Buffer.from('rsc'),
      headers: { 'x-next-cache-tags': 'posts,post:hello' },
      status: 200,
    }

    await expect(
      cache.set('/en/posts/hello', page, { cacheControl: { revalidate: 300, expire: undefined } }),
    ).resolves.toBeUndefined()
    const found = await cache.get('/en/posts/hello', { kind: 'APP_PAGE', isFallback: false })

    expect(found?.value).toMatchObject({ kind: 'APP_PAGE', html: '<html>post</html>' })
    expect(listing(root)).toEqual(before)
  })

  it('drops an entry whose tag was revalidated afterwards (updateTag in the admin actions)', async () => {
    const cache = handler()
    await cache.set('/fetch/tagged', entry('old'), setContext)
    expect(await cache.get('/fetch/tagged', getContext)).not.toBeNull()

    // The tag is compared with the millisecond the entry was stored: revalidate strictly later.
    await settle()
    await cache.revalidateTag(['posts'])
    await settle()

    expect(await cache.get('/fetch/tagged', getContext)).toBeNull()
  })

  it('drops an ISR page when a tag it carries was revalidated', async () => {
    const cache = handler()
    const page = {
      kind: 'APP_PAGE' as const,
      html: '<html>post</html>',
      rscData: Buffer.from('rsc'),
      headers: { 'x-next-cache-tags': 'posts,post:tagged-page' },
      status: 200,
    }
    await cache.set('/en/posts/tagged-page', page, { cacheControl: { revalidate: 300, expire: undefined } })
    expect(await cache.get('/en/posts/tagged-page', { kind: 'APP_PAGE', isFallback: false })).not.toBeNull()

    await settle()
    await cache.revalidateTag(['post:tagged-page'])
    await settle()

    expect(await cache.get('/en/posts/tagged-page', { kind: 'APP_PAGE', isFallback: false })).toBeNull()
  })

  it('still serves the page prerendered at build time from the read-only tree, without copying it', async () => {
    const base = join(serverDistDir, 'app', 'en', 'seeded')
    writeFileSync(`${base}.html`, '<html>built</html>')
    writeFileSync(`${base}.rsc`, 'rsc')
    writeFileSync(`${base}.meta`, JSON.stringify({ status: 200, headers: {}, cacheControl: { revalidate: 300 } }))
    const before = listing(root)

    const found = await handler().get('/en/seeded', { kind: 'APP_PAGE', isFallback: false })

    expect(found?.value).toMatchObject({ kind: 'APP_PAGE', html: '<html>built</html>' })
    expect(statSync(`${base}.html`).isFile()).toBe(true)
    expect(listing(root)).toEqual(before)
  })

  it('keeps the default behavior while `next build` runs: the build may write its own cache', async () => {
    vi.stubEnv('NEXT_PHASE', 'phase-production-build')
    const nodeFs = {
      ...readOnlyFs,
      writeFile: (file: string, data: string) => import('node:fs/promises').then((fs) => fs.writeFile(file, data)),
      mkdir: (dir: string) => import('node:fs/promises').then((fs) => fs.mkdir(dir, { recursive: true })),
    }

    await handler({ fs: nodeFs }).set('/fetch/build-time', entry('built'), setContext)

    expect(listing(root).some((name) => name.includes('fetch-cache'))).toBe(true)
  })
})
