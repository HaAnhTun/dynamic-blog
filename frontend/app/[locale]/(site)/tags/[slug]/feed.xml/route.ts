import { getTranslations } from 'next-intl/server'
import { DEFAULT_LOCALE, isLocale, type Locale } from '@/i18n/config'
import { NotFoundError, getPosts } from '@/lib/api'
import { FEED_LIMIT, feedNotFound, feedUnavailable, rssResponse } from '@/lib/feed'
import { absoluteLocaleUrl } from '@/lib/locale-path'
import { feedTitle } from '@/lib/metadata'
import { limitReads } from '@/lib/read-limit'
import { tagFeedPath } from '@/lib/site'
import { getSiteContent } from '@/lib/site-content'
import { getTag } from '@/lib/taxonomy'
import { normalizeSlug } from '@/lib/text'

/** Feed of one tag: the 20 newest posts carrying that tag, same entry format as /feed.xml. */

/** Reads the backend on every poll, like /feed.xml. */
export const fetchCache = 'force-no-store'

/**
 * The tag and its newest posts, or null when the slug matches no tag. The tag is looked up first (detail endpoint: visible when
 * it has a published post in ANY language, like the tag page) because the post list answers 200 with an empty page for an
 * unknown slug; a tag with no post in this language gives an empty feed, not a 404.
 */
async function load(slug: string, language: Locale) {
  const tag = await getTag(slug, language).catch((error: unknown) => {
    if (error instanceof NotFoundError) return null
    throw error
  })
  if (!tag) return null
  const { items } = await getPosts({ page: 0, size: FEED_LIMIT, tag: tag.slug, language })
  return { tag, posts: items }
}

export async function GET(request: Request, ctx: RouteContext<'/[locale]/tags/[slug]/feed.xml'>): Promise<Response> {
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
    // "Could not ask" is a 503, not a 404, like the category feed.
    return feedUnavailable(error, t)
  }
  if (!found) return feedNotFound(t)

  const { tag, posts } = found
  const { site } = await getSiteContent(locale)
  return rssResponse(
    {
      title: await feedTitle(locale, tag.name),
      link: absoluteLocaleUrl(`/tags/${encodeURIComponent(tag.slug)}`, locale),
      // A tag has no description (lib/taxonomy.ts), so the channel uses the site's positioning sentence.
      description: site.positioning,
      locale,
      selfPath: tagFeedPath(tag.slug),
    },
    posts,
  )
}
