import { readdirSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'

/**
 * Maps every URL path the App Router actually serves to the file that serves it, by
 * walking `app/` the way Next does.
 *
 * Two tests used to hardcode paths like `app/writing/page.tsx`, and both broke the moment
 * the public pages moved into an `app/(site)/` route group — correctly, because they were
 * asserting something real: that no URL in the sitemap 404s, and that no listing route has
 * a `loading.tsx`. Hardcoding meant the assertion was about a file path rather than about
 * a route, so it had to be edited by hand every time the tree was reorganised, and it
 * would have silently passed if a page were moved somewhere that does not serve that URL
 * at all.
 *
 * The rules this implements, which are Next's:
 *
 * - a `(group)` segment is transparent: `app/(site)/writing/page.tsx` serves `/writing`
 * - a `[param]` segment is a template: it stays in the returned key as `[param]`, so a
 *   caller can look for `/posts/[slug]`
 * - `@slot` parallel routes and `_private` folders are skipped; neither is used here, and
 *   treating them as path segments would invent URLs that do not exist
 */
export type RouteMap = Map<string, string>

const PAGE_FILES = ['page.tsx', 'page.ts', 'page.jsx', 'page.js']

/** A `(group)` is transparent, and so is the locale segment: `app/[locale]/(site)/writing/page.tsx` serves `/writing` (and `/en/writing`). */
function isTransparent(segment: string): boolean {
  return (segment.startsWith('(') && segment.endsWith(')')) || segment === '[locale]'
}

function isSkipped(segment: string): boolean {
  return segment.startsWith('@') || segment.startsWith('_')
}

/**
 * @param appDir absolute path to the `app` directory
 * @returns URL path (always leading-slash, never trailing except for `/`) → repo-relative file
 */
export function routeMap(appDir: string): RouteMap {
  const routes: RouteMap = new Map()

  function walk(dir: string, urlSegments: string[]): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        if (isSkipped(entry)) continue
        walk(full, isTransparent(entry) ? urlSegments : [...urlSegments, entry])
        continue
      }
      if (!PAGE_FILES.includes(entry)) continue
      const url = urlSegments.length === 0 ? '/' : `/${urlSegments.join('/')}`
      routes.set(
        url,
        full
          .slice(full.indexOf(`app${sep}`))
          .split(sep)
          .join('/'),
      )
    }
  }

  walk(appDir, [])
  return routes
}

/**
 * The directory that serves a URL path, or undefined if nothing does. Lets a test assert
 * the ABSENCE of a file in a route's own folder — `loading.tsx`, say — without knowing
 * which route group the route happens to live in today.
 */
export function routeDir(appDir: string, urlPath: string): string | undefined {
  const file = routeMap(appDir).get(urlPath)
  if (file === undefined) return undefined
  return join(appDir, '..', ...file.split('/').slice(0, -1))
}
