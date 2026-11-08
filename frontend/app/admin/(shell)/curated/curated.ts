import type { PostSummary } from '@/lib/types'

/*
 * The shared part of the "Best posts" screen: the page (server) and the action file
 * ('use server') both build `CuratedPost`, and CuratedManager (client) re-sorts the "Add post" box.
 * A plain module, no directive: a function exported from a 'use server' file is a public
 * endpoint, and a function imported from a 'use client' file into the server is just a client
 * reference that cannot be called.
 */

/**
 * One post on the screen: enough to show, sort and send the id, no more. This list travels to the
 * browser (props, action results), and a full PostSummary has a description, tags, a cover nobody uses here.
 */
export type CuratedPost = Pick<PostSummary, 'id' | 'title' | 'slug' | 'status' | 'publishedAt'> & {
  featuredRank: number | null
}

export function toCurated(post: PostSummary): CuratedPost {
  return {
    id: post.id,
    title: post.title,
    slug: post.slug,
    status: post.status,
    publishedAt: post.publishedAt,
    featuredRank: post.featuredRank ?? null,
  }
}

/** Date.parse, not string comparison: "…:00Z" sorts AFTER "…:00.5Z" as text though it is earlier. */
function publishedTime(post: CuratedPost): number {
  return post.publishedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(post.publishedAt)
}

/** Newest published first, unpublished (null) last. Equal gives 0, so a stable sort keeps the
 *  arrival order (the admin list: newest created first). */
export function newestFirst(a: CuratedPost, b: CuratedPost): number {
  const ta = publishedTime(a)
  const tb = publishedTime(b)
  if (ta === tb) return 0
  return tb > ta ? 1 : -1
}

/**
 * Exactly the order the backend returns "Best posts" in (PostRepository.findAllFeaturedByRank): rank ascending,
 * a picked post without a rank after them; within that group newest published first, drafts last.
 * The screen must open in the public order, otherwise pressing "Save order" without changing anything
 * would still silently reorder the site.
 */
export function curatedOrder(a: CuratedPost, b: CuratedPost): number {
  const ra = a.featuredRank ?? Number.POSITIVE_INFINITY
  const rb = b.featuredRank ?? Number.POSITIVE_INFINITY
  if (ra !== rb) return ra < rb ? -1 : 1
  return newestFirst(a, b)
}
