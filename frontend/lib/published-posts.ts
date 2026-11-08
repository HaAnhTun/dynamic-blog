import 'server-only'
import { getPosts } from '@/lib/api'
import type { Locale } from '@/i18n/config'
import type { PostSummary } from '@/lib/types'

/**
 * Every published post, paged until exhausted. The one place that answers "what is on this
 * blog", for the two routes that have to agree about it: app/sitemap.ts and
 * app/feed.xml/route.ts.
 *
 * It lived inside app/sitemap.ts and moved here when the feed arrived rather than being
 * copied — two independent paging loops is how a sitemap and a feed come to disagree about
 * which articles exist, and the disagreement is silent on both sides.
 *
 * It is a module under lib/ and NOT an export from app/sitemap.ts, which would have been
 * the smaller diff. `next-metadata-route-loader` re-exports every named export of
 * app/sitemap.ts onto the route module it generates (`createReExportsCode`), so a helper
 * exported from there becomes part of a generated route's public surface. lib/ is where
 * this project already puts a rule that more than one caller needs — lib/site.ts and
 * lib/date.ts exist for exactly that reason.
 *
 * `import 'server-only'`, matching lib/api.ts and lib/taxonomy.ts: this reaches the backend
 * directly and must never be pulled into a client bundle.
 */

/**
 * 100, because 100 is the most the backend will give. Measured, not assumed:
 *
 *   curl -s "localhost:8080/api/v1/posts?size=200"  ->  "pagination":{"size":100,...}
 *
 * The request asks for 200 and the answer says 100 — the service clamps it silently. A page
 * size above the clamp would make the FIRST page look like the whole list while
 * `totalPages` quietly disagreed, which is the shape of bug the loop below exists to avoid.
 */
const POSTS_PAGE_SIZE = 100

/**
 * A hard stop, so a backend that reports `totalPages` wrongly cannot hang a build.
 * 100 pages x 100 posts = 10,000 URLs, well past anything this blog will hold.
 */
const MAX_POST_PAGES = 100

/**
 * Only PUBLISHED posts.
 *
 * `/api/v1/posts` returns only published posts today — all 12 come back with
 * `"status":"PUBLISHED"` — so this filter removes nothing. It is here because the cost of
 * the two failures is wildly asymmetric: if the public listing ever leaks a draft, the
 * sitemap would hand a crawler a URL that answers 404 to anonymous requests and the feed
 * would push an unpublished article to every subscriber. Pinned by a test, so if the
 * backend ever renames the literal the test fails rather than the two routes emptying.
 */
function isPublished(post: PostSummary): boolean {
  return post.status === 'PUBLISHED'
}

/**
 * NOT one request. A blog starts with fewer posts than the default page size of 20, so a single
 * `getPosts({ page: 0, size: 20 })` returns everything and keeps returning everything right
 * up to post 21, at which point both the sitemap and the feed silently stop listing new
 * articles — a failure with no error, no log and no failing test.
 *
 * Three independent stop conditions, because each covers a different lie the API could tell:
 *  - `totalPages` says we are on the last page. The normal exit.
 *  - the page came back empty. Measured: `?page=99` answers 200 with `data: []` and
 *    `totalPages: 3`, so a bad cursor terminates instead of looping.
 *  - `totalPages` is 0 or missing (lib/api.ts substitutes a zeroed `meta` when the envelope
 *    has no `pagination` key) and the page was short, so it was the last one.
 *
 * De-duplicated by slug before returning: several requests are made, and a post published
 * between page 0 and page 1 shifts the ordering under the cursor, so the same article can
 * legitimately come back on both pages. The first occurrence wins, which is the ordering the
 * API intended.
 *
 * This REJECTS on a failed fetch rather than swallowing it. The sitemap must survive an
 * outage (an unhandled rejection there fails `next build`) and the feed must not answer 200
 * with an empty channel, and those are different recoveries — so the decision belongs to
 * each caller, not here.
 */
export async function fetchAllPublishedPosts(language?: Locale): Promise<PostSummary[]> {
  const all: PostSummary[] = []

  for (let page = 0; page < MAX_POST_PAGES; page += 1) {
    const { items, meta } = await getPosts({ page, size: POSTS_PAGE_SIZE, language })
    all.push(...items)

    if (items.length === 0) break
    if (meta.totalPages > 0) {
      if (page + 1 >= meta.totalPages) break
    } else if (items.length < POSTS_PAGE_SIZE) {
      break
    }
  }

  const seen = new Set<string>()
  return all.filter((post) => {
    if (!isPublished(post)) return false
    if (seen.has(post.slug)) return false
    seen.add(post.slug)
    return true
  })
}
