import 'server-only'
import type { Locale } from '@/i18n/config'
import { getJson } from './fetch-json'
import type { PostSummary } from './types'

/**
 * The most viewed posts, most first (`sort=popular`).
 *
 * `sort` is a query param, not the path `/posts/popular` — that path would hide a post whose slug is
 * "popular". No filter is sent along: the backend returns 400 when popular is combined with
 * category/tag/featured.
 *
 * Only the `posts` tag and NEVER emptied by views: the ranking is allowed to be up to 300
 * seconds stale. The view count is approximate, not worth a re-render on every read.
 */
export async function getPopularPosts(size: number, language?: Locale): Promise<PostSummary[]> {
  const query = new URLSearchParams({ sort: 'popular', page: '0', size: String(size) })
  if (language) query.set('lang', language)
  const body = await getJson<PostSummary[] | null>(`/api/v1/posts?${query}`, {
    next: { revalidate: 300, tags: ['posts'] },
  })
  return body.data ?? []
}
