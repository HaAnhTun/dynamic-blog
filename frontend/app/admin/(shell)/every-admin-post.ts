import { listAdminPosts } from '@/lib/admin-api'
import type { PostSummary } from '@/lib/types'

/*
 * A single copy for every screen that needs EVERY post the admin sees: the post list (page.tsx, filtering and counting
 * in memory), "Best posts" (curated/page.tsx), series editing (series/[id]/page.tsx) and Topics
 * (topics/page.tsx, counting the posts of each category and tag). Before, each place kept its own copy, and
 * two copies of a pagination loop are the spot where one gets fixed and the other does not. A
 * plain module, no directive: a function exported from a 'use server' file is a public endpoint.
 */

/** The backend clamps `size` to 100 (PostService.MAX_PAGE_SIZE); asking for more makes the first page look
 *  like the whole list while `totalPages` says otherwise. */
const PAGE_SIZE = 100
/** Guard against a backend that reports a wrong `totalPages`: 100 × 100 posts, far beyond anything this blog has. */
const MAX_PAGES = 100

/**
 * Every post the admin sees, every status, reading all pages. There is no separate endpoint for the admin list
 * needed (the public one only has published posts), and a 101st post that gets dropped can be neither picked nor
 * added to a series.
 *
 * Three stop conditions as in lib/published-posts.ts: `totalPages` reached, an empty page, or no
 * `totalPages` and a short page. Deduplicated by id: the list is ordered by creation date, so a post created
 * between two calls pushes everything down and the last post of the previous page repeats at the top of the
 * next. A repeated id in the list sent is a 400 at the backend.
 */
export async function everyAdminPost(): Promise<PostSummary[]> {
  const all: PostSummary[] = []
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { items, meta } = await listAdminPosts({ page, size: PAGE_SIZE })
    all.push(...items)
    if (items.length === 0) break
    if (meta.totalPages > 0) {
      if (page + 1 >= meta.totalPages) break
    } else if (items.length < PAGE_SIZE) {
      break
    }
  }
  const seen = new Set<string>()
  return all.filter((post) => {
    if (seen.has(post.id)) return false
    seen.add(post.id)
    return true
  })
}
