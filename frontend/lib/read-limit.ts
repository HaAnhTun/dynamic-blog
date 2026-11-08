import 'server-only'
import { clientIp } from './client-ip'
import { rateLimit, retryAfterSeconds } from './rate-limit'

/**
 * A per-address allowance for the anonymous reads that cost the most, in front of the work they do (docs/SECURITY.md, "Rate limits"):
 * - `media`: an image goes from the database to the heap as one array of up to 4 MiB. Counted in `/media/<id>` for a request that
 *   comes from a reader; the fetch `/_next/image` makes for itself is not (see {@link isOptimizerFetch}).
 * - `image`: `/_next/image` decodes, resizes and encodes a picture for every size of every picture it has not optimized yet, and
 *   asks `/media` for the original. Counted in `proxy.ts`, on the request of the reader, where the address is the real one.
 * - `sitemap`: every request reads every published post from the backend (five requests plus one per hundred posts). A metadata route
 *   cannot answer 429, so it is counted in `proxy.ts` too.
 * - `og`: a share card is a 1200x630 PNG drawn by Satori and resvg, and a made-up slug asks the backend twice.
 * - `feed`: every poll reads the list from the backend and, for an item the process does not remember, one post.
 *
 * The numbers are generous on purpose: a gallery page with a hundred pictures, or an office behind one address, must not trip them. They
 * stop one source that asks without end, not a crowd; the proxy examples limit the rate too (docs/INSTALL.md) and the backend has its own
 * ceilings. A caller whose address cannot be read (no proxy header, `TRUSTED_PROXY_HOPS` too high) is not limited here: the shared
 * "unknown" bucket would answer 429 to every reader of the site and break every picture, which is worse than the flood it stops.
 */
export const READ_LIMITS = {
  media: { limit: 1200, windowMs: 60_000 },
  image: { limit: 1200, windowMs: 60_000 },
  sitemap: { limit: 60, windowMs: 60_000 },
  og: { limit: 60, windowMs: 60_000 },
  feed: { limit: 120, windowMs: 60_000 },
} as const

export type ReadKind = keyof typeof READ_LIMITS

/** `null` while the caller is within its allowance; otherwise the 429 to return, with `Retry-After`, and nothing is read or rendered. */
export function limitReads(request: Request, kind: ReadKind): Response | null {
  const ip = clientIp(request)
  if (ip === null) return null
  const { limit, windowMs } = READ_LIMITS[kind]
  const bucket = `read-${kind}`
  if (rateLimit(bucket, ip, limit, windowMs)) return null
  return new Response(null, {
    status: 429,
    headers: { 'retry-after': String(Math.max(1, retryAfterSeconds(bucket, ip))), 'cache-control': 'no-store' },
  })
}

/**
 * True for the request `/_next/image` makes to `/media/<id>` to get the original it is about to optimize (`fetchInternalImage` in
 * `next/dist/server/image-optimizer.js`), false for a request that came over HTTP. Next builds that request itself with NO headers,
 * on the socket of the reader's request, and then fills `x-forwarded-for` with the address of that socket: the proxy's own. Counting it
 * would put every `/_next/image` miss of every reader in one bucket (the proxy's address) and the allowance would be the whole site's, so
 * a source making 20 requests a second would answer 429 for every picture of every reader. The reader's own request is counted once, in
 * `proxy.ts` (`image`), where the header the proxy wrote is intact.
 *
 * What tells them apart is `Host`: HTTP/1.1 requires it, every proxy sends it, and Next's mocked request has none. A request that
 * reaches the process without one did not come through a proxy, and the process is not published without one (docs/INSTALL.md).
 * `lib/read-limit.test.ts` reads the optimizer's source for `headers: {}`, so an upgrade of Next that changes this fails a test.
 */
export function isOptimizerFetch(request: Request): boolean {
  return !request.headers.has('host')
}
