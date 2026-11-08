import 'server-only'
import { getJson } from './fetch-json'
import type { SiteStats } from './types'

/**
 * The site's figures: post count, total views, series count, number of visible photos.
 *
 * The `posts` tag so publishing a post updates the post count at once. No tag is tied to views, and the
 * /api/views route does not empty the cache either: the view total is allowed to lag up to 300 seconds, while
 * emptying the cache after every read would make every read a re-render.
 */
export async function getStats(): Promise<SiteStats> {
  const body = await getJson<SiteStats>('/api/v1/stats', { next: { revalidate: 300, tags: ['stats', 'posts'] } })
  return body.data
}
