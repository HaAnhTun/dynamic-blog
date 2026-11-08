import type { NextRequest } from 'next/server'
import { forwardRead, forwardWrite, postApiPath } from '@/lib/bff-route'

/**
 * /api/posts/<slug>/like: the likes of one post, for the like button.
 *
 * - GET (auth optional): `{ liked, count }`. A guest gets `liked: false`; when logged in, Bearer goes
 *   along and `liked` is this user's own.
 * - PUT / DELETE (auth required): like / unlike. Both are idempotent at the backend and return the server
 *   `{ liked, count }` — the like button only shows that number, never adding or subtracting on its own.
 *
 * Every response is `private, no-store`: a like belongs to one person, no cache may keep it, and the
 * count is not part of any cached post page data, so there is no tag to
 * revalidate. The PUT/DELETE body is dropped: the liker is always the session owner, never taken from the body.
 */

type Context = RouteContext<'/api/posts/[slug]/like'>

async function likePath(ctx: Context): Promise<string | null> {
  const post = postApiPath((await ctx.params).slug)
  return post === null ? null : `${post}/like`
}

export async function GET(request: NextRequest, ctx: Context): Promise<Response> {
  return forwardRead(request, await likePath(ctx))
}

export async function PUT(request: NextRequest, ctx: Context): Promise<Response> {
  return forwardWrite(request, await likePath(ctx), 'PUT', { forwardBody: false })
}

export async function DELETE(request: NextRequest, ctx: Context): Promise<Response> {
  return forwardWrite(request, await likePath(ctx), 'DELETE', { forwardBody: false })
}
