import { DEFAULT_LOCALE, isLocale, type Locale } from '@/i18n/config'
import { formatUpdated } from '@/lib/date'
import { collator, lowerCase } from '@/lib/format'
import { slugifyOrEmpty } from '@/lib/slug'
import type { PostSummary } from '@/lib/types'

/*
 * Filter, search, sort and paginate the admin post list (app/admin/(shell)/page.tsx). Pure functions,
 * no API calls: the page reads EVERY post once (every-admin-post.ts) and does everything here, because the admin API
 * only has pagination — no filtering, no search, no counting — and the backend contract stays unchanged. A personal
 * blog of a few hundred posts is a few calls of 100 posts on the server (not an N+1 in the browser); in return
 * there are real counters per status, accent-insensitive search and the "Needs attention" checks over the same data.
 */

export const PAGE_SIZE = 20

/** Postgres/JPA page numbers are ints; anything larger makes the API 500. */
const MAX_PAGE = 100_000

/** A search box longer than this is a mistaken paste; truncate instead of folding a whole paragraph on every page open. */
const MAX_QUERY = 100

/** A category/tag slug longer than this is not one the backend ever generates (VARCHAR 255 column). */
const MAX_SLUG = 255

function first(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw
}

/**
 * Sprint 3a shipped `/?page=2147483648` as a 500 because the value was passed through
 * `Number()` and reached the wire as `page=1e+22`. The shape check comes first: a
 * string of digits, then a range.
 */
export function parsePage(raw: string | string[] | undefined): number {
  const value = first(raw)
  if (value === undefined || !/^\d+$/.test(value)) return 0
  const page = Number(value)
  return page > MAX_PAGE ? 0 : page
}

/**
 * There is no "archived" (the status) filter: the only way into `ARCHIVED` is an author deleting their own post, which hides it
 * (backend V49), and only an ADMIN's list returns such a post, so for an author a filter for it would always be empty — the UI
 * would promise something that does not exist. The ADMIN sees a hidden post (or one stranded in that status by hand-edited data)
 * under "All" with its own label (ui.ts) and can delete it for good.
 */
export type StatusFilter = 'all' | 'published' | 'draft'

/** The `?status=` value matching a backend status. */
const STATUS_OF: Record<Exclude<StatusFilter, 'all'>, string> = {
  published: 'PUBLISHED',
  draft: 'DRAFT',
}

/**
 * An unknown or missing `?status=` means "all": an old link never becomes a confusing empty list. That includes
 * the pre-"archived"-removal `?status=archived`.
 */
export function parseStatus(raw: string | string[] | undefined): StatusFilter {
  const value = first(raw)
  return value === 'published' || value === 'draft' ? value : 'all'
}

export function parseQuery(raw: string | string[] | undefined): string {
  return (first(raw) ?? '').trim().slice(0, MAX_QUERY)
}

/** `?cat=` / `?tag=`: one slug, or '' for no filter. Existence is not checked: an unknown slug just filters out 0 posts. */
export function parseSlug(raw: string | string[] | undefined): string {
  return (first(raw) ?? '').trim().toLowerCase().slice(0, MAX_SLUG)
}

/** `?lang=`: one enabled locale, or '' for every language. An unknown value means every language, like `parseStatus`. */
export function parseLanguage(raw: string | string[] | undefined): Locale | '' {
  const value = first(raw)
  return isLocale(value) ? value : ''
}

export type SortOrder = 'newest' | 'updated' | 'views'

/**
 * The default is "newest created first", exactly the order the backend returns; `updated` is "recently edited first",
 * `views` is "most read first".
 */
export function parseSort(raw: string | string[] | undefined): SortOrder {
  const value = first(raw)
  return value === 'views' || value === 'updated' ? value : 'newest'
}

/*
 * "Needs attention": what a post should have but is missing, counted over the real data of the
 * list. For reference only: it blocks no publishing — the only publishing condition is still the backend's
 * (content and category). The order is the order shown on screen, heavy work first. The wording of each check (label, hint, count line) is in the
 * catalog under `Admin.dashboard.health.<key>`.
 *
 * There is no "missing cover image": a post without a cover still has generated cover art on every page, which is
 * by design, not an omission. There is no separate "missing SEO description": the short description IS the meta description.
 */
export const HEALTH_CHECKS = [
  {
    key: 'draft-no-category',
    test: (post: PostSummary) => post.status === 'DRAFT' && post.category === null,
  },
  {
    key: 'featured-unpublished',
    test: (post: PostSummary) => post.featured && post.status !== 'PUBLISHED',
  },
  {
    key: 'no-excerpt',
    test: (post: PostSummary) => (post.excerpt ?? '').trim() === '',
  },
  {
    key: 'no-tags',
    test: (post: PostSummary) => post.tags.length === 0,
  },
] as const

export type HealthKey = (typeof HEALTH_CHECKS)[number]['key']

const HEALTH_KEYS: readonly string[] = HEALTH_CHECKS.map((check) => check.key)

export function parseHealth(raw: string | string[] | undefined): HealthKey | null {
  const value = first(raw)
  return value !== undefined && HEALTH_KEYS.includes(value) ? (value as HealthKey) : null
}

export function healthCheck(key: HealthKey) {
  return HEALTH_CHECKS.find((check) => check.key === key)!
}

export function healthCounts(posts: readonly PostSummary[]): Record<HealthKey, number> {
  const counts = Object.fromEntries(HEALTH_CHECKS.map((check) => [check.key, 0])) as Record<HealthKey, number>
  for (const post of posts) {
    for (const check of HEALTH_CHECKS) if (check.test(post)) counts[check.key] += 1
  }
  return counts
}

export type PostCounts = {
  all: number
  published: number
  draft: number
  /**
   * Total counted views of PUBLISHED posts, exactly the number the public page prints: the backend only
   * sums published posts at /api/v1/stats, and this cell used to include removed posts so the two numbers differed.
   * An approximate number, like each `viewCount`.
   */
  views: number
}

export function countPosts(posts: readonly PostSummary[]): PostCounts {
  const counts: PostCounts = { all: posts.length, published: 0, draft: 0, views: 0 }
  for (const post of posts) {
    if (post.status === 'PUBLISHED') {
      counts.published += 1
      counts.views += post.viewCount ?? 0
    } else if (post.status === 'DRAFT') {
      counts.draft += 1
    }
  }
  return counts
}

/**
 * Search by title and slug, case- and accent-insensitive: "bat dong bo", "a Vietnamese query with diacritics" and
 * "a lowercase Vietnamese query with diacritics" all find the same post. Both sides are folded through `slugifyOrEmpty` (lib/slug.ts, a copy
 * of the backend's), so "U+0111/U+0110 (d with stroke)" and every tone mark are handled in one place.
 *
 * Unless the query has characters the slug drops (#, +, ., non-Latin letters, emoji…): folded to a slug,
 * "C#" becomes "c" and matches nearly every post, "#" becomes empty and matches all. Then compare verbatim,
 * only case-insensitively.
 */
export function matchesQuery(post: Pick<PostSummary, 'title' | 'slug'>, query: string, locale: Locale = DEFAULT_LOCALE): boolean {
  // NFC: Vietnamese text typed or pasted in decomposed form (NFD) has combining marks, which are not Latin letters.
  const raw = lowerCase(query.normalize('NFC').trim(), locale)
  if (raw === '') return true
  // Latin letters (including accented Vietnamese), digits, whitespace, hyphen: exactly what a slug can keep.
  if (/[^\p{Script=Latin}\p{N}\s-]/u.test(raw)) {
    return lowerCase(post.title.normalize('NFC'), locale).includes(raw) || post.slug.includes(raw)
  }
  const needle = slugifyOrEmpty(raw)
  return slugifyOrEmpty(post.title).includes(needle) || post.slug.includes(needle)
}

/** Everything the list is filtering on: one type for both reading the URL and rebuilding it. */
export type ListState = {
  status: StatusFilter
  query: string
  /** Category slug, '' means every category. */
  category: string
  /** Tag slug, '' means every tag. */
  tag: string
  sort: SortOrder
  health: HealthKey | null
  /** Post language, '' (or absent) means every language. */
  language?: Locale | ''
  page?: number
}

export function filterPosts(
  posts: readonly PostSummary[],
  {
    status,
    query,
    category = '',
    tag = '',
    health = null,
    language = '',
  }: Partial<ListState> & Pick<ListState, 'status' | 'query'>,
  locale: Locale = DEFAULT_LOCALE,
): PostSummary[] {
  const check = health === null ? null : healthCheck(health)
  return posts.filter(
    (post) =>
      (status === 'all' || post.status === STATUS_OF[status]) &&
      (category === '' || post.category?.slug === category) &&
      (tag === '' || post.tags.some((item) => item.slug === tag)) &&
      (language === '' || post.language === language) &&
      (check === null || check.test(post)) &&
      matchesQuery(post, query, locale),
  )
}

/**
 * The time of "recently edited": the last write of the post (`updatedAt`, on the list since a later backend change), then
 * the publish date when an old backend does not send it or sends an unreadable value. With neither it is −∞: the post
 * goes to the bottom, in backend order — i.e. "newest created first", exactly the `createdAt` order the
 * summary does not carry. Date.parse, not string comparison: "…:00Z" sorts AFTER "…:00.5Z" as text though it is earlier.
 */
function editedTime(post: PostSummary): number {
  for (const value of [post.updatedAt, post.publishedAt]) {
    const time = value ? Date.parse(value) : Number.NaN
    if (!Number.isNaN(time)) return time
  }
  return Number.NEGATIVE_INFINITY
}

/**
 * "Most read first" and "recently edited first": both stable (Array.prototype.sort), so two equal posts
 * keep the backend's newest-created-first order.
 */
export function sortPosts(posts: readonly PostSummary[], sort: SortOrder): PostSummary[] {
  if (sort === 'newest') return [...posts]
  if (sort === 'views') return [...posts].sort((a, b) => (b.viewCount ?? 0) - (a.viewCount ?? 0))
  return [...posts].sort((a, b) => {
    const ta = editedTime(a)
    const tb = editedTime(b)
    // Compare, do not subtract: −∞ − −∞ is NaN, and a comparator returning NaN makes the sort unstable.
    if (ta === tb) return 0
    return tb > ta ? 1 : -1
  })
}

/**
 * The edit worth printing on a row's secondary line ("edited 2 Oct 2026"), as ISO for `<time dateTime>`, or
 * null when it says nothing more:
 * - a draft (or any unpublished post): always — the last time it was touched tells a draft still being
 *   written from an abandoned one;
 * - while sorted by "recently edited": always, because that is the sort key itself;
 * - a published post: only when edited on a (UTC) day after the publish day — the same `formatUpdated` rule as the
 *   "Updated" line on the post page. Publishing is also a write, so an "edit" on the publish day is just noise.
 */
export function shownEditDate(post: PostSummary, sort: SortOrder, locale: Locale = DEFAULT_LOCALE): string | null {
  const updatedAt = post.updatedAt
  if (!updatedAt || Number.isNaN(Date.parse(updatedAt))) return null
  if (sort === 'updated' || post.status !== 'PUBLISHED') return updatedAt
  return formatUpdated(post.publishedAt, updatedAt, locale) === null ? null : updatedAt
}

export type Option = { slug: string; name: string }

/**
 * Choices for the category / tag filter: only those with at least one post, ordered by Vietnamese
 * name. Filtering by a category no post uses gives an empty list, so it is not offered in the box.
 */
export function categoryOptions(posts: readonly PostSummary[], locale: Locale = DEFAULT_LOCALE): Option[] {
  const seen = new Map<string, string>()
  for (const post of posts) if (post.category !== null) seen.set(post.category.slug, post.category.name)
  return byName(seen, locale)
}

export function tagOptions(posts: readonly PostSummary[], locale: Locale = DEFAULT_LOCALE): Option[] {
  const seen = new Map<string, string>()
  for (const post of posts) for (const tag of post.tags) seen.set(tag.slug, tag.name)
  return byName(seen, locale)
}

function byName(seen: Map<string, string>, locale: Locale): Option[] {
  const order = collator(locale)
  return [...seen].map(([slug, name]) => ({ slug, name })).sort((a, b) => order.compare(a.name, b.name))
}

/**
 * One page of the filtered list. A `page` beyond the last is clamped to the last (a filter that just made
 * the list shorter must not turn the old `?page=3` into an empty page); an empty list is page 0.
 */
export function pageOf<T>(items: readonly T[], page: number, size = PAGE_SIZE) {
  const totalPages = Math.max(1, Math.ceil(items.length / size))
  const current = Math.min(page, totalPages - 1)
  return {
    items: items.slice(current * size, current * size + size),
    page: current,
    totalPages,
  }
}

/** Query string of a list state, dropping every default parameter so the URL is as short as possible. */
export function listHref({
  status,
  query,
  category = '',
  tag = '',
  sort = 'newest',
  health = null,
  language = '',
  page,
}: Partial<ListState> & Pick<ListState, 'status' | 'query'>): string {
  const params = new URLSearchParams()
  if (status !== 'all') params.set('status', status)
  if (query !== '') params.set('q', query)
  if (category !== '') params.set('cat', category)
  if (tag !== '') params.set('tag', tag)
  if (sort !== 'newest') params.set('sort', sort)
  if (health !== null) params.set('health', health)
  if (language !== '') params.set('lang', language)
  if (page !== undefined && page > 0) params.set('page', String(page))
  const search = params.toString()
  return search === '' ? '/admin' : `/admin?${search}`
}
