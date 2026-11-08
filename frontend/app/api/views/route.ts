import { createHash } from 'node:crypto'
import { after, userAgent } from 'next/server'
import { clientIp } from '@/lib/client-ip'
import { rateLimit } from '@/lib/rate-limit'
import { readSmallBody } from '@/lib/read-small-body'
import { apiBaseUrl } from '@/lib/api-base-url'

/**
 * POST /api/views: receives the "viewed" beacon from ViewBeacon (a text/plain body: the slug, an optional second line
 * is the previous page host) and adds one view at the backend.
 *
 * A route handler, not a Server Action: `navigator.sendBeacon` cannot send the Next action
 * header, and the actions of a client run one at a time. Next never caches a POST. robots.ts already blocks /api.
 *
 * The view count is approximate and only for display, but it orders "Most read"
 * (`sort=popular`), so a curl loop must not be able to pump it up. The filters below:
 * block beacons from another site, block bots by UA, one per session in the browser (ViewBeacon), a per-IP
 * quota and in-process per-IP duplicate suppression. The IP is the trusted proxy's entry in
 * X-Forwarded-For, counted from the right (lib/client-ip.ts), not the first entry that the client sets. The backend
 * only counts PUBLISHED posts.
 */

const BASE_URL = apiBaseUrl()

/** A slug is at most 255 characters, a host 253; 512 bytes is plenty for any real beacon and is the memory limit. */
const MAX_BODY_BYTES = 512

/** The exact shape of a site slug (lib/slug.ts produces lowercase letters, digits and hyphens). */
const SLUG = /^[a-z0-9-]{1,255}$/

/**
 * The previous page host, in the shape `URL.hostname` returns: lowercase, a-z and 0-9 labels with hyphens joined by
 * dots, at most 253 characters. A malformed one drops the host and the view is still counted (the backend files it under "direct"); the backend checks again.
 */
const HOST = /^[a-z0-9-]+(?:[.][a-z0-9-]+)*$/
const MAX_HOST_LENGTH = 253

/**
 * An addition to Next's `userAgent().isBot`, a case-insensitive substring match: command-line tools and
 * HTTP libraries, headless browsers, speed-measuring tools (Chrome-Lighthouse), SEO and AI crawlers. It only reduces bots,
 * it does not remove them all: the UA is set by the client.
 */
const NON_READER_AGENTS = [
  'curl',
  'wget',
  'python-requests',
  'python-urllib',
  'aiohttp',
  'httpx',
  'go-http-client',
  'java/',
  'okhttp',
  'apache-httpclient',
  'node-fetch',
  'axios',
  'headlesschrome',
  'phantomjs',
  'lighthouse',
  'pagespeed',
  'page speed',
  'ahrefsbot',
  'semrushbot',
  'mj12bot',
  'dotbot',
  'petalbot',
  'bytespider',
  'claudebot',
  'ccbot',
  'anthropic-ai',
  'perplexitybot',
  'amazonbot',
]

/** A UA that calls itself a bot or crawler. Except "cubot": a phone maker (CUBOT_X30), whose UA is a real Chrome on Android. */
const CRAWLER = /(?<!cu)bot|crawl|spider/i

/** A missing or empty UA is not a reader browser either. The UA is not stored or logged. */
function isNonReader(ua: string | null): boolean {
  const agent = ua?.trim().toLowerCase() ?? ''
  return agent === '' || CRAWLER.test(agent) || NON_READER_AGENTS.some((token) => agent.includes(token))
}

/** One reader (IP + browser) re-reading a post within 30 minutes counts as one view. */
const REPEAT_WINDOW_MS = 30 * 60_000
const REPEAT_MAX_ENTRIES = 10_000

/**
 * One IP is counted for at most 30 beacons per minute (lib/rate-limit.ts, bucket 'views'). A real reader opens
 * a post every few minutes; 30 posts a minute from one address is a loop, or a whole office behind
 * one NAT — there, undercounting a few views is an acceptable price.
 */
const VIEWS_LIMIT = 30
const VIEWS_WINDOW_MS = 60_000

/**
 * key → expiry time. A Map keeps insertion order, so the first element is the oldest: when over
 * the limit, drop it. The raw IP is not stored — the key is a sha256 — and nothing is written anywhere: it is lost when the
 * process restarts, and each instance has its own copy (on serverless it is almost
 * useless, which is accepted).
 */
const recent = new Map<string, number>()

function reply(status: 204 | 400 | 403 | 413): Response {
  return new Response(null, { status, headers: { 'cache-control': 'no-store' } })
}

/**
 * The second and later hits of the same IP + browser + post within the 30-minute window. The window counts from
 * the first hit and is not extended by each repeat: a reader returning after 30 minutes is still counted.
 *
 * `ip` is clientIp(request): the `TRUSTED_PROXY_HOPS`-th entry from the right of X-Forwarded-For (behind
 * nginx it is the address nginx appended at the end; when called directly Next fills one entry from the socket). An unknown IP
 * (missing header, malformed entry) is not suppressed: every such reader would then share one key per
 * browser, and suppression would badly undercount — overcounting a few views is the lesser fault. The quota in POST still
 * applies to them, in the shared "unknown" bucket.
 */
function isRepeat(ip: string | null, request: Request, slug: string): boolean {
  if (ip === null) return false

  const key = createHash('sha256')
    .update(`${ip}|${request.headers.get('user-agent') ?? ''}|${slug}`)
    .digest('base64url')
  const now = Date.now()
  const expiresAt = recent.get(key)
  if (expiresAt !== undefined && expiresAt > now) return true

  // Delete before setting again so a key that just expired moves to the end of the insertion order.
  recent.delete(key)
  recent.set(key, now + REPEAT_WINDOW_MS)
  if (recent.size > REPEAT_MAX_ENTRIES) {
    const oldest = recent.keys().next().value
    if (oldest !== undefined) recent.delete(oldest)
  }
  return false
}

export async function POST(request: Request): Promise<Response> {
  // A header that is not same-origin → a beacon from another page (or a typed URL). A missing
  // header passes: Safari before 16.4 does not send it, and that is still a real reader.
  const site = request.headers.get('sec-fetch-site')
  if (site !== null && site !== 'same-origin') return reply(403)

  // `Number(null)` is 0 and `Number('abc')` is NaN, and neither blocks here — the body is
  // actually measured right below.
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) return reply(413)

  // 204 rather than 403: a bot does not need to know it was skipped.
  if (userAgent(request).isBot || isNonReader(request.headers.get('user-agent'))) return reply(204)

  // `content-length` was checked above, but a chunked body has no such header:
  // readSmallBody measures for real and stops as soon as the limit is exceeded.
  const body = await readSmallBody(request, MAX_BODY_BYTES)
  if (body === null) return reply(413)

  // The first line is the slug, exactly the beacon shape from before the referrer line (an old cached page still sends it); the optional second line is the
  // host. One more line means it was not ViewBeacon that sent it.
  const [first, second, ...rest] = body.trim().split('\n')
  if (rest.length > 0) return reply(400)
  const slug = first.trim()
  if (!SLUG.test(slug)) return reply(400)
  const host = second?.trim() ?? ''
  const referrer = host.length <= MAX_HOST_LENGTH && HOST.test(host) ? host : null

  // The quota comes before duplicate suppression: the suppression key has the User-Agent and slug, which the client changes freely, while
  // the quota keys only on IP. Over it gives 204 like a bot, not 429: a beacon does not read the response.
  const ip = clientIp(request)
  if (!rateLimit('views', ip, VIEWS_LIMIT, VIEWS_WINDOW_MS)) return reply(204)

  if (isRepeat(ip, request, slug)) return reply(204)

  // Read at call time, not at module load: changing the env needs no rebuild. Empty or whitespace-only
  // means unset: dev, and the E2E stack. docker-compose.yml requires it for production.
  const token = process.env.VIEWS_TOKEN?.trim()

  // Only the token and the host go further: the reader IP and UA never leave this route.
  const headers: Record<string, string> = {}
  if (token) headers['x-view-token'] = token
  if (referrer !== null) headers['x-view-referrer'] = referrer

  // Return 204 first, count afterwards: the reader does not wait for the backend.
  after(async () => {
    try {
      const res = await fetch(`${BASE_URL}/api/v1/posts/${encodeURIComponent(slug)}/views`, {
        method: 'POST',
        cache: 'no-store',
        headers,
      })
      // 404 (an unpublished post) or 403 (a wrong token) leave nothing more to do; cancel the body so it
      // does not hold the connection.
      await res.body?.cancel()
    } catch {
      // The backend is unreachable: one approximate view is lost, not worth a log line per view.
    }
  })

  return reply(204)
}
