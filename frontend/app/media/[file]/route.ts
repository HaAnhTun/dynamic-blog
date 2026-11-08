import { isOptimizerFetch, limitReads } from '@/lib/read-limit'

/**
 * /media/<uuid>.<jpg|png>: an uploaded image, same origin as the site.
 *
 * The browser never calls the backend. This route fetches the bytes from `GET /api/v1/media/…` and
 * returns them; `/_next/image?url=/media/…` calls this route directly (no loopback HTTP) for optimization.
 *
 * It lives at the app root, not under /api (robots.ts blocks /api, and X/Twitterbot does not fetch an og:image at a
 * blocked path) and not under (site) (proxy.ts only matches /admin, so this route never
 * touches the login session).
 *
 * No segment config: a route handler GET is dynamic by default and runs on every request. Caching in the right place is
 * the `immutable` header below — a URL never changes content, a new image is a new UUID.
 */

import { apiBaseUrl } from '@/lib/api-base-url'

const BASE_URL = apiBaseUrl()

/**
 * A lowercase UUID and exactly the two extensions the backend stores. Lowercase because the backend generates file names with
 * `UUID.toString()`: accepting uppercase too would give one image two URLs and two cache keys.
 *
 * This is also the SSRF gate: the backend URL is only built from a string that matched this regex, so
 * `../`, a query string or an unknown extension never reaches the backend.
 */
const FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(jpg|png)$/

/** Content-Type comes from the extension, NEVER from the backend: HTML/SVG served from this origin is stored XSS. */
const TYPE = { jpg: 'image/jpeg', png: 'image/png' } as const

/** Errors are never cached: a 404 cached for a year outlives the error that caused it. */
function failure(status: 404 | 502): Response {
  return new Response(null, { status, headers: { 'cache-control': 'no-store' } })
}

export async function GET(request: Request, ctx: RouteContext<'/media/[file]'>): Promise<Response> {
  const { file } = await ctx.params
  const match = FILE.exec(file)
  if (!match) return failure(404)

  // An image is read whole from the database into the heap, up to 4 MiB: one address may ask 1200 times a minute (lib/read-limit.ts).
  // Not for the fetch `/_next/image` makes for itself: it carries the address of the proxy, not of the reader, so it would put every
  // optimized picture of every reader in one bucket. That reader is counted once in proxy.ts, for `/_next/image`.
  const limited = isOptimizerFetch(request) ? null : limitReads(request, 'media')
  if (limited) return limited

  // Only forward If-None-Match: the backend returns 304 without reading the bytes when the ETag matches.
  const forward = new Headers()
  const ifNoneMatch = request.headers.get('if-none-match')
  if (ifNoneMatch) forward.set('if-none-match', ifNoneMatch)

  let upstream: Response
  try {
    upstream = await fetch(`${BASE_URL}/api/v1/media/${file}`, {
      headers: forward,
      // The Data Cache limits an entry to 2 MB, images go up to 4 MB; and caching here is the header's job.
      cache: 'no-store',
      // When the browser goes away, cancel the download from the backend too.
      signal: request.signal,
    })
  } catch {
    return failure(502)
  }

  const headers = new Headers({
    'content-type': TYPE[match[2] as keyof typeof TYPE],
    // `s-maxage` makes a CDN cache the function output only when present (Vercel); `immutable` so the
    // browser does not ask again even when the reader hits reload.
    'cache-control': 'public, max-age=31536000, s-maxage=31536000, immutable',
    'x-content-type-options': 'nosniff',
    // The same CSP the Next image optimizer sends: opening the image URL directly cannot run anything either.
    'content-security-policy': "script-src 'none'; frame-src 'none'; sandbox;",
  })
  const etag = upstream.headers.get('etag')
  if (etag) headers.set('etag', etag)

  if (upstream.status === 304) return new Response(null, { status: 304, headers })

  if (!upstream.ok || !upstream.body) {
    // Cancel the error body instead of leaving the connection hanging until GC cleans it up.
    await upstream.body?.cancel()
    return failure(upstream.status === 404 ? 404 : 502)
  }

  // Next answers HEAD by running GET; then nobody reads the body, so cancel the download.
  if (request.method === 'HEAD') {
    await upstream.body.cancel()
    return new Response(null, { status: 200, headers })
  }

  // Stream the body straight through. Do NOT copy content-length/content-encoding: Node fetch has already decompressed
  // the body but kept the original headers, copying them makes the browser truncate or decompress a second time.
  return new Response(upstream.body, { status: 200, headers })
}
