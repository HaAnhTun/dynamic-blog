import { AsyncLocalStorage } from 'node:async_hooks'
import { createRequire } from 'node:module'
import type { WorkStore } from 'next/dist/server/app-render/work-async-storage.external'
import type { WorkUnitStore } from 'next/dist/server/app-render/work-unit-async-storage.external'

/**
 * Next's own data-cache decision, run inside a unit test.
 *
 * A route's `fetchCache` and `dynamic` exports and a fetch's `next: { revalidate }` are combined at
 * request time by next/dist/server/lib/patch-fetch.js, and nothing in a unit test runs that code: a
 * test that only reads `mod.fetchCache` proves the export exists, not that it beats the
 * `revalidate: 300` the lib/ helpers ask for. And the precedence is not what the documentation
 * suggests — caching-without-cache-components.md calls `dynamic = 'force-dynamic'` equivalent to
 * `fetchCache = 'force-no-store'`, while patch-fetch.js only lets force-dynamic decide for a fetch
 * that set no cache option of its own (`noFetchConfigAndForceDynamic`).
 *
 * So this runs a route's real handler the way a request does: the global `fetch` is the one Next
 * installs on a server (`createPatchedFetcher`, which `patchFetch` calls), inside a work store built
 * like app-route/module.js builds it — `fetchCache` copied from the route module, `forceDynamic` set
 * when the module says `dynamic = 'force-dynamic'`, not a static generation — over a data cache that
 * already holds an OLD answer for every URL. That is the state the cache is in after a write that
 * went straight to the backend (seed/push.py, a curl): no Server Action ran, so no tag was cleared.
 *
 * Next internals, deliberately, as next-config.test.ts does with `getPathMatch`: the behaviour
 * under test is Next's. If an upgrade moves them, this file fails loudly, and that is the moment to
 * re-check by hand that the sitemap and the feed still read the backend on every request.
 */

const requireNext = createRequire(import.meta.url)

const { createPatchedFetcher } = requireNext(
  'next/dist/server/lib/patch-fetch',
) as typeof import('next/dist/server/lib/patch-fetch')

/** Read at runtime: the .d.ts declares it an ambient `const enum`, which `isolatedModules` forbids. */
const { CachedRouteKind } = requireNext('next/dist/server/response-cache/types') as {
  CachedRouteKind: { FETCH: string }
}

/** `createPatchedFetcher` sets this flag on the global object; restored after each run. */
const NEXT_PATCH_SYMBOL = Symbol.for('next-patch')

/** The two segment-config exports that decide caching, read off the real route module. */
export type RouteCacheConfig = { fetchCache?: unknown; dynamic?: unknown }

/** A JSON body for a backend path such as `/api/v1/posts?page=0&size=100`. */
export type Answers = (path: string) => unknown

export type DataCacheRun<T> = {
  result: T
  /** Paths, with query, that the live backend answered. */
  backend: string[]
  /** Paths answered from the data cache. */
  cacheReads: string[]
  /** Paths written to the data cache. */
  cacheWrites: string[]
}

function pathOf(input: unknown): string {
  const url = new URL(input instanceof Request ? input.url : String(input))
  return `${url.pathname}${url.search}`
}

function json(body: unknown): string {
  return JSON.stringify(body)
}

export async function runThroughDataCache<T>(
  config: RouteCacheConfig,
  answers: { live: Answers; cached: Answers },
  handler: () => Promise<T>,
): Promise<DataCacheRun<T>> {
  const backend: string[] = []
  const cacheReads: string[] = []
  const cacheWrites: string[] = []

  const origin = (async (input: RequestInfo | URL) => {
    const path = pathOf(input)
    backend.push(path)
    return new Response(json(answers.live(path)), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  // The interface patch-fetch.js calls: a key per URL, a lock, and an entry that is FRESH — so a
  // fetch that consults the cache at all is answered from it and never reaches the backend.
  const incrementalCache = {
    generateCacheKey: async (url: string) => url,
    lock: async () => async () => {},
    get: async (key: string) => {
      const path = pathOf(key)
      cacheReads.push(path)
      return {
        isStale: false,
        value: {
          kind: CachedRouteKind.FETCH,
          revalidate: 300,
          data: {
            headers: { 'content-type': 'application/json' },
            body: Buffer.from(json(answers.cached(path))).toString('base64'),
            status: 200,
            url: key,
          },
        },
      }
    },
    set: async (key: string) => {
      cacheWrites.push(pathOf(key))
    },
  }

  const store = {
    route: '/data-cache-test',
    page: '/data-cache-test',
    isStaticGeneration: false,
    fetchCache: config.fetchCache,
    forceDynamic: config.dynamic === 'force-dynamic',
    incrementalCache,
  } as unknown as WorkStore

  const workAsyncStorage = new AsyncLocalStorage<WorkStore>()
  // No work-unit store: a route handler's request store does not change the decision for these
  // fetches (patch-fetch.js reads no revalidate window from a 'request' store).
  const workUnitAsyncStorage = new AsyncLocalStorage<WorkUnitStore>()

  const scope = globalThis as unknown as Record<PropertyKey, unknown>
  const hadPatchFlag = Object.prototype.hasOwnProperty.call(scope, NEXT_PATCH_SYMBOL)
  const previousPatchFlag = scope[NEXT_PATCH_SYMBOL]
  const previousFetch = globalThis.fetch

  globalThis.fetch = createPatchedFetcher(origin, { workAsyncStorage, workUnitAsyncStorage })
  try {
    const result = await workAsyncStorage.run(store, handler)
    // Cache writes finish after the response is handed back; wait for them before reporting.
    await Promise.all(Object.values(store.pendingRevalidates ?? {}))
    return { result, backend, cacheReads, cacheWrites }
  } finally {
    globalThis.fetch = previousFetch
    if (hadPatchFlag) scope[NEXT_PATCH_SYMBOL] = previousPatchFlag
    else delete scope[NEXT_PATCH_SYMBOL]
  }
}
