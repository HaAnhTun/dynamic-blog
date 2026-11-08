import { getTranslations } from 'next-intl/server'
import { DEFAULT_LOCALE, isLocale, type Locale } from '@/i18n/config'
import { NotFoundError, getPosts } from '@/lib/api'
import { FEED_LIMIT, feedNotFound, feedUnavailable, rssResponse } from '@/lib/feed'
import { absoluteLocaleUrl } from '@/lib/locale-path'
import { feedTitle } from '@/lib/metadata'
import { limitReads } from '@/lib/read-limit'
import { categoryFeedPath } from '@/lib/site'
import { getSiteContent } from '@/lib/site-content'
import { getCategory } from '@/lib/taxonomy'
import { normalizeSlug } from '@/lib/text'

/** Feed of one category: its 20 newest posts, same entry format as /feed.xml. */

/** Reads the backend on every poll, like /feed.xml. */
export const fetchCache = 'force-no-store'

/**
 * The category and its newest posts, or null when the slug matches no category. The API returns 200 with
 * an empty page for an unknown slug, so the category is looked up first (detail endpoint: visible when it has a published post
 * in ANY language, like the category page); a category with no post in this language gives an empty feed, not a 404.
 */
async function load(slug: string, language: Locale) {
  const category = await getCategory(slug, language).catch((error: unknown) => {
    if (error instanceof NotFoundError) return null
    throw error
  })
  if (!category) return null
  const { items } = await getPosts({ page: 0, size: FEED_LIMIT, category: category.slug, language })
  return { category, posts: items }
}

export async function GET(request: Request, ctx: RouteContext<'/[locale]/categories/[slug]/feed.xml'>): Promise<Response> {
  // A poll reads the list from the backend and renders what the process does not remember: one address may ask 120 times a minute.
  const limited = limitReads(request, 'feed')
  if (limited) return limited
  const params = await ctx.params
  const { locale } = params
  const t = await getTranslations({ locale: isLocale(locale) ? locale : DEFAULT_LOCALE, namespace: 'Meta.feed' })
  if (!isLocale(locale)) return feedNotFound(t)
  let found: Awaited<ReturnType<typeof load>>
  try {
    found = await load(normalizeSlug(params.slug), locale)
  } catch (error) {
    // "Could not ask" is a 503, not a 404: a 404 makes the reader unsubscribe because of one backend hiccup.
    return feedUnavailable(error, t)
  }
  if (!found) return feedNotFound(t)

  const { category, posts } = found
  const { site } = await getSiteContent(locale)
  return rssResponse(
    {
      title: await feedTitle(locale, category.name),
      link: absoluteLocaleUrl(`/categories/${encodeURIComponent(category.slug)}`, locale),
      // `||`: an RSS channel must have a description, so an empty string also falls back to the site's positioning sentence.
      description: category.description || site.positioning,
      locale,
      selfPath: categoryFeedPath(category.slug),
    },
    posts,
  )
}
