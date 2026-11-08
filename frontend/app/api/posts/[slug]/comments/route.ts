import type { NextRequest } from 'next/server'
import { forwardRead, forwardWrite, invalidParameter, isCommentCursor, postApiPath } from '@/lib/bff-route'

/**
 * /api/posts/<slug>/comments: the comments of one post.
 *
 * - GET (auth optional): one page of the comment thread. `after` is the backend keyset cursor, forwarded
 *   verbatim once it matches `^[A-Za-z0-9_-]{1,200}$`; `size` is always 10, the client cannot choose it
 *   (every other query parameter is dropped). When logged in, Bearer goes along so the backend computes `mine`.
 * - POST (auth required): post a top-level comment. The JSON body `{ content }` goes verbatim to the backend,
 *   which checks the length and normalizes the content; the writer is always the session owner, never taken from the body.
 *
 * Comments are fetched client-side through this route, not part of the post page cached data:
 * no tag to revalidate, and every response is `private, no-store`.
 */

type Context = RouteContext<'/api/posts/[slug]/comments'>

/** Top-level comments per page (the backend clamps 1..20, default 10). */
const PAGE_SIZE = 10

export async function GET(request: NextRequest, ctx: Context): Promise<Response> {
  const post = postApiPath((await ctx.params).slug)
  const after = request.nextUrl.searchParams.get('after')
  if (post === null || (after !== null && !isCommentCursor(after))) return invalidParameter()

  const query = new URLSearchParams()
  if (after !== null) query.set('after', after)
  query.set('size', String(PAGE_SIZE))
  return forwardRead(request, `${post}/comments?${query}`)
}

export async function POST(request: NextRequest, ctx: Context): Promise<Response> {
  const post = postApiPath((await ctx.params).slug)
  return forwardWrite(request, post === null ? null : `${post}/comments`, 'POST', { forwardBody: true })
}
