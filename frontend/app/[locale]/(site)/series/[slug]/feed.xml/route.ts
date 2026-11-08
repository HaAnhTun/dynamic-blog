import { getTranslations } from 'next-intl/server'
import { DEFAULT_LOCALE, isLocale } from '@/i18n/config'
import { NotFoundError } from '@/lib/api'
import { feedNotFound, feedUnavailable, rssResponse } from '@/lib/feed'
import { absoluteLocaleUrl } from '@/lib/locale-path'
import { feedTitle } from '@/lib/metadata'
import { limitReads } from '@/lib/read-limit'
import { getSeries } from '@/lib/series'
import { seriesFeedPath } from '@/lib/site'
import { getSiteContent } from '@/lib/site-content'
import { normalizeSlug } from '@/lib/text'
import type { PostSummary, SeriesDetail } from '@/lib/types'

/** Feed of one series: the published parts, newest first, same entry format as /feed.xml. */

/** Reads the backend on every poll, like /feed.xml. */
export const fetchCache = 'force-no-store'

/** Publish time used for sorting; a post without a readable date goes last. */
function publishedTime(post: PostSummary): number {
  const time = post.publishedAt ? Date.parse(post.publishedAt) : Number.NaN
  return Number.isFinite(time) ? time : 0
}

export async function GET(request: Request, ctx: RouteContext<'/[locale]/series/[slug]/feed.xml'>): Promise<Response> {
  // A poll reads the list from the backend and renders what the process does not remember: one address may ask 120 times a minute.
  const limited = limitReads(request, 'feed')
  if (limited) return limited
  const params = await ctx.params
  const { locale } = params
  const t = await getTranslations({ locale: isLocale(locale) ? locale : DEFAULT_LOCALE, namespace: 'Meta.feed' })
  if (!isLocale(locale)) return feedNotFound(t)
  let series: SeriesDetail
  try {
    series = await getSeries(normalizeSlug(params.slug), locale)
  } catch (error) {
    // 404 only when the backend says there is no such series; any other error is 503, like every feed.
    return error instanceof NotFoundError ? feedNotFound(t) : feedUnavailable(error, t)
  }
  // Like the series page: a series with no published part does not exist for readers.
  if (series.posts.length === 0) return feedNotFound(t)

  const { site } = await getSiteContent(locale)
  // The parts arrive in reading order; the feed is newest first.
  const newestFirst = [...series.posts].sort((a, b) => publishedTime(b) - publishedTime(a))
  return rssResponse(
    {
      title: await feedTitle(locale, series.title),
      link: absoluteLocaleUrl(`/series/${encodeURIComponent(series.slug)}`, locale),
      // `||`: an RSS channel must have a description, so an empty string also falls back to the site's positioning sentence.
      description: series.description || site.positioning,
      locale,
      selfPath: seriesFeedPath(series.slug),
    },
    newestFirst,
  )
}
