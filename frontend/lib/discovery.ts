import 'server-only'
import { DEFAULT_LOCALE, type Locale } from '@/i18n/config'
import { getPosts } from './api'
import { collator } from './format'
import { getPopularPosts } from './popular'
import { fetchAllPublishedPosts } from './published-posts'
import { getSeriesList } from './series'
import { getSiteContent } from './site-content'
import type { BlogrollEntry } from './site-content-types'
import type { Category, PostSummary, SeriesSummary, Tag } from './types'

/**
 * Data for the "Discover" block on /writing and the "What to read next" block on the post page, and the
 * counts that /topics and /archive reuse.
 *
 * Counting tags, categories and months is done here from `fetchAllPublishedPosts()` — the same source as
 * the sitemap and feed, cached 300 seconds under the tag `posts` — instead of adding a count endpoint in the backend.
 */

/**
 * View count display thresholds. Below the threshold the number only makes the site look empty, so the
 * UI hides it completely rather than writing "3 views":
 * - `perPost`: a post shows its view count from 10 views.
 * - `siteTotal`: /writing adds "· N views" when the total reaches 100.
 * - `popularPosts`: the "Most read" block only exists when at least 3 posts pass the `perPost` threshold.
 */
export const VIEW_THRESHOLDS = { perPost: 10, siteTotal: 100, popularPosts: 3 } as const

/** Maximum number of items each widget shows. Exported so the display blocks do not set a different number themselves. */
export const DISCOVERY_LIMITS = { popular: 5, recent: 5, series: 5, tags: 20, months: 12 } as const

export type TagCount = { tag: Tag; count: number }
export type CategoryCount = { category: Category; count: number }
/** A month (UTC) that has posts. `month` is 1–12. */
export type MonthBucket = { year: number; month: number; count: number; posts: PostSummary[] }
export type PopularBlock = { kind: 'popular' | 'recommended'; posts: PostSummary[] }

/**
 * Each block is `null` when there is nothing to show — its source failed or is empty, two cases the UI
 * treats the same: the block is not rendered, no orphan heading. `seriesTotal`/`tagTotal` are
 * the totals before cutting, so the block knows whether it needs an "All …" link; 0 when the block is null.
 */
export type Discovery = {
  popular: PopularBlock | null
  recent: PostSummary[] | null
  series: SeriesSummary[] | null
  seriesTotal: number
  tags: TagCount[] | null
  tagTotal: number
  months: MonthBucket[] | null
  blogroll: readonly BlogrollEntry[]
}

export function shouldShowViews(viewCount: number | undefined): boolean {
  return typeof viewCount === 'number' && viewCount >= VIEW_THRESHOLDS.perPost
}

/**
 * Post count per tag, most posts first, ties by name in the alphabet of the locale. Counted from the posts themselves so a
 * tag with 0 posts never appears. A tag repeated on the same post counts once; the key is the
 * slug because that is what the link uses.
 */
export function countTags(posts: PostSummary[], locale: Locale = DEFAULT_LOCALE): TagCount[] {
  const counts = new Map<string, TagCount>()
  for (const post of posts) {
    const seen = new Set<string>()
    for (const tag of post.tags) {
      if (seen.has(tag.slug)) continue
      seen.add(tag.slug)
      const entry = counts.get(tag.slug)
      if (entry) entry.count += 1
      else counts.set(tag.slug, { tag, count: 1 })
    }
  }
  const order = collator(locale)
  return [...counts.values()].sort((a, b) => b.count - a.count || order.compare(a.tag.name, b.tag.name))
}

/**
 * Post count per category, keeping the order of `categories` (API order, like the old filter strip) and dropping
 * categories with 0 posts. Returns the Category of the list — the full version, with the description for /topics.
 */
export function countCategories(posts: PostSummary[], categories: Category[]): CategoryCount[] {
  const bySlug = new Map<string, number>()
  for (const post of posts) {
    const slug = post.category?.slug
    if (slug) bySlug.set(slug, (bySlug.get(slug) ?? 0) + 1)
  }
  return categories.flatMap((category) => {
    const count = bySlug.get(category.slug) ?? 0
    return count > 0 ? [{ category, count }] : []
  })
}

/** Publish time in ms, or null when the post has no date or the date is unreadable. */
function publishedTime(post: PostSummary): number | null {
  if (!post.publishedAt) return null
  const time = Date.parse(post.publishedAt)
  return Number.isFinite(time) ? time : null
}

/** Posts with a publish date, newest first. Do not trust the API order: this function also accepts hand-built arrays. */
export function newestFirst(posts: PostSummary[]): Array<{ post: PostSummary; time: number }> {
  return posts
    .map((post) => ({ post, time: publishedTime(post) }))
    .filter((entry): entry is { post: PostSummary; time: number } => entry.time !== null)
    .sort((a, b) => b.time - a.time)
}

/**
 * Groups posts by month, newest month first, newest post first within a month.
 *
 * In UTC, matching lib/date.ts: the date shown on each post is formatted in UTC, so a post
 * dated 31 October must fall in October even when the server runs at UTC+7 (where that instant is already
 * 01/11). Posts with no date or a broken date are skipped.
 */
export function bucketByMonth(posts: PostSummary[]): MonthBucket[] {
  const buckets: MonthBucket[] = []
  for (const { post, time } of newestFirst(posts)) {
    const date = new Date(time)
    const year = date.getUTCFullYear()
    const month = date.getUTCMonth() + 1
    const last = buckets.at(-1)
    // Already sorted newest first, so posts of the same month are always adjacent.
    if (last && last.year === year && last.month === month) {
      last.posts.push(post)
      last.count += 1
    } else {
      buckets.push({ year, month, count: 1, posts: [post] })
    }
  }
  return buckets
}

/**
 * "Most read" when at least 3 posts have 10 or more views, otherwise "Read first" from the
 * curated posts by rank (`featured` has already been sorted by `featured_rank` by the API).
 *
 * "Most read" only contains posts passing the threshold: a post below the threshold does not show a view count, so it would
 * be the only row of the block without a number.
 */
export function popularOrRecommended(popular: PostSummary[], featured: PostSummary[]): PopularBlock {
  const counted = popular.filter((post) => shouldShowViews(post.viewCount))
  if (counted.length >= VIEW_THRESHOLDS.popularPosts) {
    return { kind: 'popular', posts: counted.slice(0, DISCOVERY_LIMITS.popular) }
  }
  return { kind: 'recommended', posts: featured.slice(0, DISCOVERY_LIMITS.popular) }
}

function nonEmpty<T>(items: T[] | null | undefined): T[] | null {
  return items && items.length > 0 ? items : null
}

/**
 * Gathers the data for a context. Each source catches its own errors: a failing source only turns its block
 * into null, the other blocks still show, and this function never throws — a secondary block must not
 * trang 500.
 *
 * `article` (the post page, `excludeSlug` is the post being read): Most read / Read first and Recently
 * written, all minus the post being read. The series list is not called — that block does not exist on the post page.
 * `writing`: Most read / Read first, Series, Tags, Archive and Blogs to read.
 *
 * With `language`, every source is limited to that language (the popular and featured blocks are per language).
 *
 * Popular and curated posts are requested one more than the number shown, so enough remain after subtracting the post
 * being read. The "Most read" threshold is computed AFTER subtracting: if the post being read is one of the three posts passing
 * the threshold, only two remain, and the block falls back to curated.
 */
export async function getDiscovery(opts: {
  context: 'writing' | 'article'
  excludeSlug?: string
  language?: Locale
}): Promise<Discovery> {
  const isWriting = opts.context === 'writing'
  const keep = (post: PostSummary) => post.slug !== opts.excludeSlug

  const failures: string[] = []
  const settle = async <T>(name: string, load: () => Promise<T>): Promise<T | null> => {
    try {
      return await load()
    } catch (error) {
      failures.push(`${name} (${error instanceof Error ? error.message : String(error)})`)
      return null
    }
  }

  const { language } = opts
  const fetchSize = DISCOVERY_LIMITS.popular + 1
  const [popular, featured, all, series] = await Promise.all([
    settle('popular', () => getPopularPosts(fetchSize, language)),
    settle('featured', () => getPosts({ page: 0, size: fetchSize, featured: true, language }).then((page) => page.items)),
    settle('posts', () => fetchAllPublishedPosts(language)),
    isWriting ? settle('series', () => getSeriesList(language)) : Promise.resolve(null),
  ])

  if (failures.length > 0) {
    // One line for the whole gather, like app/sitemap.ts: a block hidden silently means nobody sees an API
    // incident, while one line per source makes the log noisy when the API is down for long.
    console.warn(`[discovery] Could not read ${failures.join(', ')}. Hiding the matching blocks.`)
  }

  const block = popularOrRecommended((popular ?? []).filter(keep), (featured ?? []).filter(keep))

  const allTags = isWriting && all ? countTags(all) : null
  const tags = nonEmpty(allTags?.slice(0, DISCOVERY_LIMITS.tags))
  const seriesShown = nonEmpty(series?.slice(0, DISCOVERY_LIMITS.series))

  return {
    popular: block.posts.length > 0 ? block : null,
    recent:
      !isWriting && all
        ? nonEmpty(
            newestFirst(all.filter(keep))
              .slice(0, DISCOVERY_LIMITS.recent)
              .map((entry) => entry.post),
          )
        : null,
    series: seriesShown,
    seriesTotal: seriesShown && series ? series.length : 0,
    tags,
    tagTotal: tags && allTags ? allTags.length : 0,
    months: isWriting && all ? nonEmpty(bucketByMonth(all).slice(0, DISCOVERY_LIMITS.months)) : null,
    // The blogroll is site content (never throws, falls back to the packaged default), only on /writing.
    blogroll: isWriting ? (await getSiteContent(language ?? DEFAULT_LOCALE)).blogroll : [],
  }
}
