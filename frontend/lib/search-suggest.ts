import 'server-only'
import { postPath } from '@/components/site/ArticleJsonLd'
import { isLocale, type Locale } from '@/i18n/config'
import { ApiError, searchContent } from './api'
import { popularOrRecommended } from './discovery'
import { getPopularPosts } from './popular'
import { rateLimit } from './rate-limit'
import {
  SEARCH_LIMITS,
  SEARCH_TYPES,
  type BackendSearchGroup,
  type BackendSearchItem,
  type PopularItem,
  type SearchGroup,
  type SearchItem,
  type SearchScope,
  type Segment,
  type SuggestResponse,
} from './search-contract'

/**
 * The source of the quick search panel: every type goes through the backend `GET /api/v1/search` (`searchContent`, a client
 * shared with `/search`), which picks the engine and falls back to Postgres (`degraded`). Only the limit, the timeout, and copying
 * the answer into the contract remain here: no `post`, no pagination.
 */

/**
 * The search rate limit per IP, one shared bucket for `/api/search/suggest`, `/api/search/popular` and the `/search`
 * page: all three spend from the shared backend ceiling (1200/minute for the whole site), so one IP must not use up
 * that ceiling through any route. The typing panel has a 150–200 ms debounce and cancels the old request.
 */
export const SEARCH_RATE = { bucket: 'search', limit: 120, windowMs: 60_000 } as const

/**
 * One unit of the search allowance of `ip` (`SEARCH_RATE`); false once it is used up. An unknown address (`null`: a
 * misconfigured proxy, a junk X-Forwarded-For entry) is not exempt: it counts in the shared "unknown" bucket of
 * lib/rate-limit.ts, like every other limiter. Used by the quick search routes and the `/search` page.
 */
export function allowSearch(ip: string | null): boolean {
  return rateLimit(SEARCH_RATE.bucket, ip, SEARCH_RATE.limit, SEARCH_RATE.windowMs)
}

/** A timeout for the whole request: timing out means "not found yet", very different from "no results". */
export const SUGGEST_TIMEOUT_MS = 3_000

/** A backend error, reduced to a code: the route turns it into a status, never copies the message (it may contain `q`). */
export type SuggestFailure = 'timeout' | 'unavailable' | 'rate-limited' | 'invalid'

export class SearchUnavailableError extends Error {
  constructor(readonly failure: SuggestFailure) {
    super(`search ${failure}`)
    this.name = 'SearchUnavailableError'
  }
}

function failureOf(error: unknown, signal: AbortSignal): SuggestFailure {
  if (signal.aborted) return 'timeout'
  if (error instanceof ApiError && error.status === 429) return 'rate-limited'
  if (error instanceof ApiError && error.status === 400) return 'invalid'
  return 'unavailable'
}

/** A path within the site: the palette renders it as a `<Link>`, so `javascript:` or `//host` never gets there. */
function isLocalHref(href: unknown): href is string {
  return typeof href === 'string' && href.startsWith('/') && !href.startsWith('//') && !href.startsWith('/\\')
}

function segments(list: readonly Segment[]): Segment[] {
  return list.map((segment) => ({ text: typeof segment.text === 'string' ? segment.text : '', match: segment.match === true }))
}

function toItem(item: BackendSearchItem<unknown>): SearchItem | null {
  if (!isLocalHref(item.href) || !Array.isArray(item.title)) return null
  const out: SearchItem = { id: item.id, title: segments(item.title), href: item.href }
  const language = (item.post as { language?: unknown } | undefined)?.language
  if (isLocale(language)) out.locale = language
  if (Array.isArray(item.description) && item.description.length > 0) out.description = segments(item.description)
  if (item.meta) out.meta = item.meta
  return out
}

function toGroup(group: BackendSearchGroup<unknown>, limit: number): SearchGroup | null {
  if (!(SEARCH_TYPES as readonly string[]).includes(group.type)) return null
  const items = group.items.flatMap((item) => toItem(item) ?? []).slice(0, limit)
  return items.length > 0 ? { type: group.type, total: group.total, items } : null
}

export async function buildSuggest(
  query: string,
  scope: SearchScope,
  signal: AbortSignal,
  language?: Locale,
  /** The visitor's address (`clientIp(request)`) for the backend's per-address limit; `null` when unknown. */
  ip: string | null = null,
): Promise<SuggestResponse> {
  const limit = scope === 'all' ? SEARCH_LIMITS.perGroupAll : SEARCH_LIMITS.perGroupTab
  // The posts tab is a page of `/search` at the backend: page size follows `size`, not `limit`.
  const base = scope === 'post' ? { q: query, type: scope, limit, page: 0, size: limit } : { q: query, type: scope, limit }
  const params = language ? { ...base, language } : base
  const response = await searchContent(params, { signal, clientIp: ip }).catch((error: unknown) => {
    throw new SearchUnavailableError(failureOf(error, signal))
  })
  return {
    query,
    groups: response.groups.flatMap((group) => toGroup(group, limit) ?? []),
    degraded: response.degraded === true,
  }
}

/**
 * The empty state's "Most read" block: only when real view counts pass the site's threshold (`popularOrRecommended`,
 * ≥3 posts with ≥10 views). Under the threshold it is an empty list, never curated posts passed off as "most read".
 */
export async function buildPopular(language?: Locale): Promise<PopularItem[]> {
  const block = popularOrRecommended(await getPopularPosts(6, language), [])
  if (block.kind !== 'popular') return []
  return block.posts.map((post) => ({
    id: `post:${post.slug}`,
    title: post.title,
    href: postPath(post.slug),
    ...(isLocale(post.language) ? { locale: post.language } : {}),
  }))
}
