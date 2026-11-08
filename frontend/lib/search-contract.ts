import type { Locale } from '@/i18n/config'
import type { HighlightSegment } from './highlight'

/**
 * The contract of the quick search panel: `GET /api/search/suggest` returns exactly this shape, the palette depends only
 * on it — the engine behind it can change without the UI changing. No HTML travels over the wire: a match is a
 * `Segment[]`, React renders the `<mark>`.
 */

export const SEARCH_TYPES = ['post', 'topic', 'series', 'case-study', 'author', 'page'] as const
export type SearchType = (typeof SEARCH_TYPES)[number]
export type SearchScope = 'all' | SearchType

export type Segment = HighlightSegment

export type PostMeta = {
  kind: 'post'
  category?: string
  /** Only when the author is not the site owner: the owner's name on every row does not help tell them apart. */
  author?: string
  publishedAt?: string
  readingMinutes?: number
  /** At most 2. */
  tags?: string[]
}
export type TopicMeta = { kind: 'category' | 'tag'; count: number }
export type SeriesMeta = { kind: 'series'; parts: number }
export type AuthorMeta = { kind: 'author'; avatarUrl: string | null }
export type ItemMeta = PostMeta | TopicMeta | SeriesMeta | AuthorMeta

export type SearchItem = {
  /** `<type>:<slug or path>`, never an internal id. */
  id: string
  title: Segment[]
  description?: Segment[]
  href: string
  /** Language of the URL a post result lives under (its own), when it is known: the link must not take the page's prefix. */
  locale?: Locale
  meta?: ItemMeta
}

export type SearchGroup = { type: SearchType; total: number; items: SearchItem[] }

/**
 * `degraded`: the primary engine (Meilisearch) is down so the results come from the basic search (Postgres); the panel and
 * `/search` show a small note that basic search is in use. It never means "no results".
 */
export type SuggestResponse = { query: string; groups: SearchGroup[]; degraded?: boolean }

/** The backend response of `GET /api/v1/search`: the `post` group also carries pagination and a post summary. */
export type BackendSearchItem<TPost> = SearchItem & { post?: TPost }
export type BackendSearchGroup<TPost> = Omit<SearchGroup, 'items'> & {
  page?: number
  totalPages?: number
  items: BackendSearchItem<TPost>[]
}
export type BackendSearchResponse<TPost> = {
  query: string
  engine: 'postgres' | 'meilisearch'
  degraded: boolean
  groups: BackendSearchGroup<TPost>[]
}

export type PopularItem = { id: string; title: string; href: string; locale?: Locale }
export type PopularResponse = { items: PopularItem[] }

export const SEARCH_LIMITS = {
  /** Like `/search` and the backend (`PostService.search`). */
  query: 200,
  /** A single character only filters the quick navigation list in place, with no network call. */
  minChars: 2,
  perGroupAll: 5,
  perGroupTab: 10,
} as const

/** The message key of each group label, relative to the namespace `Site.palette` (group headings and tab labels). */
export const GROUP_LABEL_KEYS: Record<SearchType, string> = {
  post: 'groups.post',
  topic: 'groups.topic',
  series: 'groups.series',
  'case-study': 'groups.caseStudy',
  author: 'groups.author',
  page: 'groups.page',
}

/** The panel tabs: there is no tab of its own for static pages, they only show under "All". */
export const TAB_TYPES: readonly SearchType[] = ['post', 'topic', 'series', 'case-study', 'author']

export function isSearchScope(value: string): value is SearchScope {
  return value === 'all' || (SEARCH_TYPES as readonly string[]).includes(value)
}

/**
 * Trim then cut at 200 code units, dropping the orphaned first half of a surrogate pair — exactly like `parseQuery` of
 * `/search`, so the same typed string gives the same query in both places.
 */
export function cleanQuery(raw: string): string {
  // Cut by UTF-16 units (`length` in both JS and Java) so it does not exceed the limit however the backend
  // counts; no half of a surrogate pair (half an emoji) is left dangling at the cut edge.
  let query = raw.trim().slice(0, SEARCH_LIMITS.query)
  const last = query.charCodeAt(query.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) query = query.slice(0, -1)
  return query.trimEnd()
}
