import { postLanguage, postPath } from '@/components/site/ArticleJsonLd'
import { DEFAULT_LOCALE, LOCALES, type Locale } from '@/i18n/config'
import { localePath } from '@/lib/locale-path'
import { fetchAllPublishedPosts } from '@/lib/published-posts'
import { siteUrl } from '@/lib/site'
import { normalizeSlug } from '@/lib/text'

/**
 * /random: redirects to a random post (the "Read a random post" link in the footer and the
 * "Discover" block).
 *
 * A route handler, not a page: a route handler GET is dynamic by default, so every click is a new
 * pick. A page would be prerendered at build time with the redirect baked in, unless `connection()` is remembered.
 * The post list is fetchAllPublishedPosts, the same function as the sitemap and the feed,
 * but read from a 300-second cache under the `posts` tag, so a click does not touch the backend. The sitemap
 * and the feed drop that cache (`fetchCache`) because crawlers and feed readers visit rarely and tend to
 * hit a stale copy; here it is kept on purpose: a post published outside admin missing from the pick for a few minutes
 * hurts nobody, while one request to the backend per click has a cost.
 *
 * The link to here must be `<a href="/random" rel="nofollow">`, not `<Link>`: the Next router
 * prefetches links and caches the redirect target, so "random" would stick to one post.
 */

/**
 * `private, no-store`: no browser or CDN may keep a pick. Without it
 * a shared cache could send everyone to the same post.
 */
const NEVER_CACHE = 'private, no-store, max-age=0'

/**
 * The post the reader is on when clicking, so "Read a random post" does not send them back to that same post (measured
 * before the fix: 36 clicks from one post went back to that very post 3 times). Null when unknown.
 *
 * Read from the Referer: the link to here is a same-origin `<a rel="nofollow">` without `noreferrer`, and the
 * `Referrer-Policy: strict-origin-when-cross-origin` of next.config.ts (next-config.test.ts pins it
 * for /posts/*) sends the full URL for a same-origin request. A browser or extension that drops the Referer only
 * loses the exclusion: it picks across every post, as before.
 *
 * - Only a Referer from the site itself: the public origin (NEXT_PUBLIC_SITE_URL — behind a reverse proxy,
 *   `request.url` carries the host and port Next listens on, not the domain the reader sees), or
 *   the origin of the request itself (`next dev`, `next start` without a proxy). /posts/x of another blog
 *   says nothing about which post of this site is open.
 * - Only `/posts/<one segment>`, decoded exactly as the post page decodes its param: normalizeSlug on
 *   the raw segment, ONCE (it is not idempotent, see posts/[slug]/page.tsx). Broken percent-encoding is skipped
 *   rather than guessed: no post has that address (Next returns 500 before the page runs), while
 *   normalizeSlug alone would keep the raw string.
 *
 * Never throws, for any Referer: a "read a random post" button must never get a 500.
 */
type Visitor = { locale: Locale; slug: string | null }

/** The locale prefix of a path (`/en/...`) and the rest of it; no prefix is the default locale. */
function splitLocale(pathname: string): { locale: Locale; rest: string } {
  const prefix = LOCALES.find(
    (locale) => locale !== DEFAULT_LOCALE && (pathname === `/${locale}` || pathname.startsWith(`/${locale}/`)),
  )
  return prefix ? { locale: prefix, rest: pathname.slice(prefix.length + 1) || '/' } : { locale: DEFAULT_LOCALE, rest: pathname }
}

function visitorOf(request: Request): Visitor {
  const referer = request.headers.get('referer')
  if (!referer) return { locale: DEFAULT_LOCALE, slug: null }

  let from: URL
  try {
    from = new URL(referer)
  } catch {
    return { locale: DEFAULT_LOCALE, slug: null }
  }
  if (!siteOrigins(request).has(from.origin)) return { locale: DEFAULT_LOCALE, slug: null }

  const { locale, rest } = splitLocale(from.pathname)
  const segment = /^\/posts\/([^/]+)$/.exec(rest)?.[1]
  if (segment === undefined) return { locale, slug: null }
  try {
    decodeURIComponent(segment)
  } catch {
    return { locale, slug: null }
  }
  return { locale, slug: normalizeSlug(segment) }
}

function siteOrigins(request: Request): Set<string> {
  const origins = new Set([new URL(request.url).origin])
  try {
    origins.add(new URL(siteUrl()).origin)
  } catch {
    // A NEXT_PUBLIC_SITE_URL that cannot be read already breaks the metadata of every page (lib/site.ts); here
    // it only means that the request own origin is the only accepted origin.
  }
  return origins
}

export async function GET(request: Request): Promise<Response> {
  const { locale, slug: current } = visitorOf(request)
  let location = localePath('/writing', locale)
  try {
    // The visitor's language first; a language with no post yet falls back to every language.
    const inLanguage = await fetchAllPublishedPosts(locale)
    const posts = inLanguage.length > 0 ? inLanguage : await fetchAllPublishedPosts()
    const others = posts.filter((post) => post.slug !== current)
    // A blog with a single post and the reader is on it: still that post, not /writing.
    const pool = others.length > 0 ? others : posts
    const pick = pool[Math.floor(Math.random() * pool.length)]
    if (pick) location = localePath(postPath(pick.slug), postLanguage(pick))
  } catch (error) {
    // Never a 500 for a "read a random post" button: go to the post list, where an API error (if
    // it persists) will be reported the proper way by that page. Warn so the incident does not pass silently.
    console.warn(
      `[random] Could not read the post list (${error instanceof Error ? error.message : String(error)}). ` +
        'Redirecting to the post list.',
    )
  }

  // A plain Response with a RELATIVE Location: NextResponse.redirect demands an absolute URL, and building
  // it from the Host behind a reverse proxy can point at the wrong origin. 307 like `redirect()`.
  return new Response(null, { status: 307, headers: { location, 'cache-control': NEVER_CACHE } })
}
