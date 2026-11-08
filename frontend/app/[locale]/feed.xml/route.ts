import { getTranslations } from 'next-intl/server'
import { DEFAULT_LOCALE, isLocale } from '@/i18n/config'
import { feedNotFound, feedUnavailable, rssResponse } from '@/lib/feed'
import { absoluteLocaleUrl } from '@/lib/locale-path'
import { feedTitle } from '@/lib/metadata'
import { limitReads } from '@/lib/read-limit'
import { fetchAllPublishedPosts } from '@/lib/published-posts'
import { FEED_PATH } from '@/lib/site'
import { getSiteContent } from '@/lib/site-content'
import type { PostSummary } from '@/lib/types'

/**
 * RSS 2.0, at /feed.xml.
 *
 * For a technical blog a feed is a real distribution channel rather than an SEO tag:
 * readers, aggregators and link-collection sites all consume one, and without it the only
 * way to find a new article is to search for it. /feed.xml, /rss.xml, /feed and /atom.xml
 * all answered 404 before this file.
 *
 * ## RSS 2.0 rather than Atom
 *
 * Atom requires a feed-level `<updated>`, and on a blog with nothing published — or during
 * an outage — the only value available for it is `new Date()`. That is the invented-date
 * pattern app/sitemap.ts refuses in writing when it explains why it emits no
 * `changeFrequency` and no `priority`. RSS's `<lastBuildDate>` is optional, so it can be
 * honestly omitted instead. Both formats are read by everything that reads either.
 *
 * ## One source of posts, one spelling of each URL
 *
 * The post list comes from `fetchAllPublishedPosts` — the same function app/sitemap.ts
 * calls, so the feed cannot advertise an article the sitemap omits or vice versa. Each
 * item's URL comes from `postUrl`, which is also the canonical tag on the article page and
 * the string the copy-link button puts on the clipboard. Four places, one string.
 *
 * ## Read on every poll: `fetchCache`, and no `dynamic`
 *
 * app/sitemap.ts needs `force-dynamic` because `next build` prerenders a metadata route and
 * would bake an empty sitemap into the image. A route handler's GET is already rendered per
 * request ("Route Handlers are not cached by default"), so the declaration here would be
 * redundant.
 *
 * What WAS cached is the data (V6 P3-8): getPosts asks for `revalidate: 300` under the `posts`
 * tag, and only the admin's Server Actions clear that tag. An article published by
 * seed/push.py or straight through the API reached subscribers up to five minutes late — later
 * in practice, since a reader polls rarely and a rare poll of a stale entry is answered with
 * the stale copy while Next refreshes it in the background. `fetchCache = 'force-no-store'`
 * sets that `revalidate` to 0 for every fetch this route makes (next/dist/server/lib/
 * patch-fetch.js; route.test.ts runs Next's own fetch to show it). The price is one backend
 * request per poll, one more per extra hundred posts, and (V7b D13) one per item whose HTML
 * lib/feed.ts has not rendered yet for that `updatedAt`. Like `dynamic`, it belongs to the
 * caching model without Cache Components, where it becomes a build error.
 *
 * The item format, the 20-item cap and the escaping live in lib/feed.ts, shared with the
 * per-category, per-series and per-tag feeds (V7b D14).
 */

/** The backend on every poll, never the data cache: "Read on every poll" above. */
export const fetchCache = 'force-no-store'

export async function GET(request: Request, ctx: RouteContext<'/[locale]/feed.xml'>): Promise<Response> {
  // A poll reads the list from the backend and renders what the process does not remember: one address may ask 120 times a minute.
  const limited = limitReads(request, 'feed')
  if (limited) return limited
  const { locale } = await ctx.params
  const t = await getTranslations({ locale: isLocale(locale) ? locale : DEFAULT_LOCALE, namespace: 'Meta.feed' })
  if (!isLocale(locale)) return feedNotFound(t)

  let posts: PostSummary[]
  try {
    posts = await fetchAllPublishedPosts(locale)
  } catch (error) {
    return feedUnavailable(error, t)
  }

  // The first twenty of the shared list ARE the newest: the API answers `sort=latest`, which is
  // `publishedAt DESC` (PostService.listPublished), and lib/published-posts.ts keeps that order.
  // The cap applies after its published filter, so a leaked draft cannot take an article's
  // place, and the fetch stays the one the sitemap makes — two answers to "which articles
  // exist" is the disagreement that module was written to prevent.
  const { site } = await getSiteContent(locale)
  return rssResponse(
    {
      title: await feedTitle(locale),
      link: absoluteLocaleUrl('/', locale),
      description: site.positioning,
      selfPath: FEED_PATH,
      locale,
    },
    posts,
  )
}
