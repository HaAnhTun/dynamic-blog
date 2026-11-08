// Removes the pages that `next build` prerendered and that Next revalidates (`revalidate = 300`: posts, writing, tags, the bookmarks,
// newsletter, profile and case-study pages, ...) from a `.next` folder: their `.html`, `.rsc`, `.meta` and the folder of `.segments`.
//
// Two callers, one rule (lib/runtime-cache.ts imports it, the build stage of the Dockerfile runs it):
// - The image build has no backend, so these pages were rendered from the neutral default site content. Next 16.4's FileSystemCache
//   serves such a copy once, as a stale answer, before it renders against the backend. The Dockerfile removes them from
//   `.next/standalone/.next` after `next build`, so the image holds no seed of them and the first request for each page is a render.
//   It has to happen at build: in the container `.next/server` belongs to root on a read-only file system, so the server cannot do it.
// - Without the image (`next start` on a host) `startRuntimeCacheGuard` removes them at every start, for the same reason.
//
// A page with `initialRevalidateSeconds: false` never changes after the build (`_global-error`, the icons) and is kept, and so is the
// body of a route handler (`routeType: 'route'`), which Next keeps elsewhere. Next reads an entry whose files are gone as a miss, so
// deleting is always safe.
import { readFile, readdir, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The files (and the folder of segments) of a prerendered page `route` of the manifest, under `.next/server/app`.
 * @param {string} distDir
 * @param {string} route
 * @returns {string[]}
 */
export function prerenderedFilesOf(distDir, route) {
  const parts = route === '/' ? ['index'] : route.split('/').filter(Boolean)
  // The manifest is written by the build, in the image; a name that climbs out of the folder is not one of its routes.
  if (parts.some((part) => part === '..' || part === '.')) return []
  const base = join(distDir, 'server', 'app', ...parts)
  return [`${base}.html`, `${base}.rsc`, `${base}.meta`, `${base}.segments`]
}

/** @param {string} path */
async function countFiles(path) {
  let info
  try {
    info = await stat(path)
  } catch {
    return 0 // Nothing there.
  }
  if (!info.isDirectory()) return 1
  let total = 0
  for (const entry of await readdir(path)) total += await countFiles(join(path, entry))
  return total
}

/**
 * Removes the revalidating prerendered pages of the manifest in `distDir` and returns how many files went. Throws when the manifest is
 * missing or unreadable (a build that did not write one is not a build to ship, and the caller decides what that means).
 * @param {string} distDir
 * @returns {Promise<number>}
 */
export async function clearPrerenderedPages(distDir) {
  /** @type {{ routes?: Record<string, { routeType?: string, initialRevalidateSeconds?: unknown }> }} */
  const manifest = JSON.parse(await readFile(join(distDir, 'prerender-manifest.json'), 'utf8'))
  let removed = 0
  for (const [route, info] of Object.entries(manifest.routes ?? {})) {
    if (info.routeType !== 'page' || typeof info.initialRevalidateSeconds !== 'number') continue
    for (const path of prerenderedFilesOf(distDir, route)) {
      removed += await countFiles(path)
      await rm(path, { recursive: true, force: true })
    }
  }
  return removed
}

// `node scripts/clear-prerendered-pages.mjs <distDir>`: the Dockerfile step. It prints a count, never a path. No top-level await: the
// bundler of the server also loads this module (through lib/runtime-cache.ts), where this block does not run.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) {
    console.error('usage: node scripts/clear-prerendered-pages.mjs <distDir>')
    process.exit(2)
  }
  clearPrerenderedPages(process.argv[2]).then(
    (removed) => console.info(`removed ${removed} prerendered page files that revalidate`),
    (error) => {
      console.error(`could not read the prerender manifest in the build output (${error?.code ?? 'unreadable'})`)
      process.exit(1)
    },
  )
}
