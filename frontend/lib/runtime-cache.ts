import type { Dirent } from 'node:fs'
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { clearPrerenderedPages } from '../scripts/clear-prerendered-pages.mjs'

/**
 * What Next keeps on disk between requests, and what this server does about it.
 *
 * Without `cache-handler.mjs` (the image and `next start` have it, and then nothing below is written to disk; `ROUTE_CACHE_MAX_MB` and the
 * prune have no effect, the in-memory LRU of Next bounds the pages), Next writes every page it renders on demand (an ISR entry: `html`, `rsc`, `meta` and a folder of `segments`, about 250 KB for one page
 * of this site) under `.next/server/route-cache`, and every cached backend answer under `.next/cache/fetch-cache`. Two things follow
 * that nothing in Next bounds (docs/SECURITY.md, "Caching, and a CDN in front"):
 * - The slug in `/posts/<slug>` is chosen by the caller and a 404 is cached like any other page, so a script that asks for random slugs
 *   writes a quarter of a megabyte per request, for ever. The files live in the container's write layer, next to the database volume on
 *   a single small server. {@link pruneRouteCache} keeps the folder under a size, oldest entries first.
 * - The record of which tags `updateTag` expired lives in memory, and the entries on disk outlive the process. After a restart a post
 *   taken down in the admin is valid again for as long as its entry is fresh, and an older one is served once, stale, from the entry on
 *   disk. {@link clearPersistedPages} removes every entry that can be revalidated when the server starts: the runtime ones and the
 *   pages prerendered at build time, so the first request for each is a render against the backend. Pages that never revalidate (the
 *   icons, `robots.txt`) are left alone. In the image the tree is read-only and this part cannot happen here: the Dockerfile runs the same
 *   rule (`scripts/clear-prerendered-pages.mjs`) after `next build`.
 *
 * Both are files Next treats as a cache miss when they are gone, so deleting them is always safe, also while the server runs. Every call
 * here is asynchronous (`node:fs/promises`): the walk over the route cache is thousands of files at the cap, and it must not hold the one
 * event loop that serves the site while it counts them.
 */

/** Seconds between two checks of the size of the route cache. A flood can write the cap again within one; the proxy limits are the first defence. */
const PRUNE_INTERVAL_MS = 30_000

/** The default size, in megabytes, the runtime page cache may reach before the oldest entries are removed. About a thousand pages. */
export const DEFAULT_ROUTE_CACHE_MAX_MB = 256

/** After a prune the folder is brought down to this share of the cap, so the next write does not trigger another one. */
const PRUNE_TARGET = 0.8

type Entry = { path: string; size: number; modified: number }

function routeCacheDir(distDir: string): string {
  return join(distDir, 'server', 'route-cache')
}

function fetchCacheDir(distDir: string): string {
  return join(distDir, 'cache', 'fetch-cache')
}

/** How many entries of one folder are looked at at the same time: the thread pool is small, and a folder may hold thousands. */
const BATCH = 128

/** Every file under `dir`, with its size and last write. A folder that does not exist is empty; a file that vanishes while it is read is skipped. */
async function filesUnder(dir: string): Promise<Entry[]> {
  const found: Entry[] = []
  let names: Dirent[]
  try {
    names = await readdir(dir, { withFileTypes: true })
  } catch {
    return found
  }
  for (let start = 0; start < names.length; start += BATCH) {
    const parts = await Promise.all(
      names.slice(start, start + BATCH).map(async (entry): Promise<Entry[]> => {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) return filesUnder(path)
        try {
          const info = await stat(path)
          return [{ path, size: info.size, modified: info.mtimeMs }]
        } catch {
          // Gone since the listing: another prune, or Next replacing the entry.
          return []
        }
      }),
    )
    for (const part of parts) for (const entry of part) found.push(entry)
  }
  return found
}

function remove(path: string): Promise<void> {
  return rm(path, { recursive: true, force: true })
}

/**
 * Removes every persisted page entry that Next can revalidate, and the cached backend answers, so that nothing written before this
 * start can be served after it. Returns how many files went. Never throws: a cache that cannot be cleared is not a reason to refuse to
 * serve (the entries are then as old as they were).
 */
export async function clearPersistedPages(distDir: string): Promise<number> {
  let removed = 0
  const wipe = async (path: string) => {
    try {
      removed += (await stat(path)).isDirectory() ? (await filesUnder(path)).length : 1
    } catch {
      return // Nothing there.
    }
    await remove(path)
  }
  try {
    await wipe(routeCacheDir(distDir))
    await wipe(fetchCacheDir(distDir))

    // The pages prerendered at build time that revalidate (the rule is shared with the image build, scripts/clear-prerendered-pages.mjs).
    removed += await clearPrerenderedPages(distDir)
  } catch {
    // No manifest (a development tree) or a file in use: what could not be removed stays as old as it is.
  }
  return removed
}

/**
 * Keeps the runtime page cache under `maxBytes`: when it is over, the files written longest ago are removed until it is down to 80 percent.
 * Returns the number of files removed. An entry is several files; Next reads an entry whose files are not all there as a miss and writes
 * it again.
 */
export async function pruneRouteCache(distDir: string, maxBytes: number): Promise<number> {
  const files = await filesUnder(routeCacheDir(distDir))
  let total = files.reduce((sum, file) => sum + file.size, 0)
  if (total <= maxBytes) return 0
  files.sort((a, b) => a.modified - b.modified)
  let removed = 0
  for (const file of files) {
    if (total <= maxBytes * PRUNE_TARGET) break
    await remove(file.path)
    total -= file.size
    removed += 1
  }
  return removed
}

/** `ROUTE_CACHE_MAX_MB` in bytes: a whole number of megabytes, `0` for no limit, anything else the default. */
export function routeCacheMaxBytes(value: string | undefined): number {
  const text = value?.trim() ?? ''
  const megabytes = /^\d{1,6}$/.test(text) ? Number(text) : DEFAULT_ROUTE_CACHE_MAX_MB
  return megabytes === 0 ? Number.POSITIVE_INFINITY : megabytes * 1024 * 1024
}

/**
 * Called once when the production server starts (`instrumentation.ts`): clears what an earlier process left, then keeps the route cache
 * under its size. Logs one line with a count, never a path (a path holds a slug).
 */
export async function startRuntimeCacheGuard(
  distDir: string,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const cleared = await clearPersistedPages(distDir)
  console.info(`[cache] cleared ${cleared} persisted page and data files at start`)
  const maxBytes = routeCacheMaxBytes(env.ROUTE_CACHE_MAX_MB)
  if (!Number.isFinite(maxBytes)) return
  // One walk at a time: on a slow disk a walk may take longer than the interval, and two walks would count the same files twice.
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    pruneRouteCache(distDir, maxBytes)
      .then((removed) => {
        if (removed > 0)
          console.info(`[cache] route cache over ${Math.round(maxBytes / 1024 / 1024)} MB: removed ${removed} files`)
      })
      .catch(() => {
        // The next tick tries again.
      })
      .finally(() => {
        running = false
      })
  }, PRUNE_INTERVAL_MS)
  // The timer must not keep the process alive on its own.
  timer.unref()
}
