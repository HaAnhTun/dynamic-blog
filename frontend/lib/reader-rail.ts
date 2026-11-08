import type { Locale } from '@/i18n/config'
import { bucketByMonth, newestFirst } from './discovery'
import { postLinkLocale } from './post-language'
import { SERIES_FULL_LIST_MAX, seriesRows, type SeriesRow } from './series-rows'
import type { Post, PostSummary, SeriesDetail } from './types'

/**
 * The data of the left rail of the post page, as a pure function: no request, no React. The post page
 * already holds the post, its series and the list of every published post; this module only decides what the rail
 * shows from them, so the rules can be tested without rendering anything.
 *
 * The model carries category NAMES only, never category hrefs: the breadcrumb stays the one category link of the page.
 */

/** Posts shown in the category group when it is the main group, and when it is the secondary group of a series post. */
export const RAIL_CATEGORY_LIMIT = 6
export const RAIL_SECONDARY_LIMIT = 4
/** Posts shown in the "latest" fallback group. */
export const RAIL_LATEST_LIMIT = 5

/** A link to a post: `locale` is what `postLinkLocale` gives, the `locale` prop of the i18n `Link`. */
export type RailPost = { id: string; slug: string; title: string; locale: Locale | undefined }

export type RailCategoryGroup = { kind: 'category'; name: string; posts: RailPost[] }

export type LeftRailModel = {
  primary:
    | {
        kind: 'series'
        slug: string
        title: string
        /** The part being read, counted from 1 by position among the published parts. */
        current: number
        total: number
        rows: SeriesRow[]
        parts: RailPost[]
        /** More parts than the block lists in full: the rail adds a "view the whole series" link. */
        windowed: boolean
      }
    | RailCategoryGroup
    | { kind: 'latest'; posts: RailPost[] }
    | null
  secondary: RailCategoryGroup | null
  /** For the "Archive · <month>" link; null when the post has no readable date. */
  month: { year: number; month: number; href: string } | null
}

/** What the rail shows when nothing else can be computed: the static "Explore" group alone. */
const EXPLORE_ONLY: LeftRailModel = { primary: null, secondary: null, month: null }

/**
 * The target of a month on the archive page. That page shows one year at a time and the newest year is the
 * default page (canonical `/archive`, no `?year`), so a month of an older year must carry `?year`: the
 * `#thang-2025-12` section does not exist on the page of year 2026.
 *
 * A copy of `monthHref` in components/site/DiscoveryGrid.tsx, which keeps its own until it switches to this import.
 */
export function archiveMonthHref(year: number, month: number, newestYear: number): string {
  const anchor = `#thang-${year}-${String(month).padStart(2, '0')}`
  return year === newestYear ? `/archive${anchor}` : `/archive?year=${year}${anchor}`
}

/** The post's month in UTC, like `bucketByMonth` and lib/date.ts, or null when the date is missing or unreadable. */
function monthOf(post: Pick<PostSummary, 'publishedAt'>): { year: number; month: number } | null {
  if (!post.publishedAt) return null
  const time = Date.parse(post.publishedAt)
  if (!Number.isFinite(time)) return null
  const date = new Date(time)
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 }
}

export function buildLeftRail({
  post,
  series,
  all,
  language,
}: {
  post: Post | PostSummary
  series: SeriesDetail | null
  all: PostSummary[]
  language: Locale
}): LeftRailModel {
  try {
    return build(post, series, all, language)
  } catch (error) {
    // A secondary block must never take the post page down: show the "Explore" group alone.
    console.warn(`[reader-rail] Could not build the left rail (${error instanceof Error ? error.message : String(error)}).`)
    return EXPLORE_ONLY
  }
}

function build(
  post: Post | PostSummary,
  series: SeriesDetail | null,
  allPosts: PostSummary[] | null | undefined,
  language: Locale,
): LeftRailModel {
  const all = Array.isArray(allPosts) ? allPosts : []
  const toRail = (item: PostSummary): RailPost => ({
    id: item.id,
    slug: item.slug,
    title: item.title,
    locale: postLinkLocale(item, language),
  })

  /** The newest posts of the post's category, minus the post being read and the given slugs. */
  const categoryGroup = (excluded: ReadonlySet<string>, limit: number): RailCategoryGroup | null => {
    const category = post.category
    if (!category) return null
    const others = all.filter((item) => item.category?.slug === category.slug && !excluded.has(item.slug))
    const posts = newestFirst(others)
      .map((entry) => entry.post)
      .slice(0, limit)
      .map(toRail)
    return posts.length > 0 ? { kind: 'category', name: category.name, posts } : null
  }

  let primary: LeftRailModel['primary'] = null
  let secondary: LeftRailModel['secondary'] = null

  // Position among the published parts, never the stored `position` (which may have gaps).
  const parts = series?.posts ?? []
  const index = series ? parts.findIndex((part) => part.slug === post.slug) : -1

  if (series && index !== -1) {
    primary = {
      kind: 'series',
      slug: series.slug,
      title: series.title,
      current: index + 1,
      total: parts.length,
      rows: seriesRows(parts.length, index),
      parts: parts.map(toRail),
      windowed: parts.length > SERIES_FULL_LIST_MAX,
    }
    secondary = categoryGroup(new Set([post.slug, ...parts.map((part) => part.slug)]), RAIL_SECONDARY_LIMIT)
  } else {
    primary = categoryGroup(new Set([post.slug]), RAIL_CATEGORY_LIMIT)
    if (!primary) {
      const latest = newestFirst(all.filter((item) => item.slug !== post.slug))
        .slice(0, RAIL_LATEST_LIMIT)
        .map((entry) => toRail(entry.post))
      primary = latest.length > 0 ? { kind: 'latest', posts: latest } : null
    }
  }

  const own = monthOf(post)
  // The archive opens on its newest year; without any dated post in `all`, the post's own year is the best guess.
  const newestYear = bucketByMonth(all)[0]?.year ?? own?.year
  const month =
    own && newestYear !== undefined
      ? { year: own.year, month: own.month, href: archiveMonthHref(own.year, own.month, newestYear) }
      : null

  return { primary, secondary, month }
}
