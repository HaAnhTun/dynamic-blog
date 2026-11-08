import type { NextRequest } from 'next/server'
import { commentApiPath, forwardWrite } from '@/lib/bff-route'

/**
 * /api/comments/<id>/like: like and unlike a comment.
 *
 * - PUT: like. DELETE: unlike. Both are idempotent at the backend and return the server `{ liked, count }` —
 *   the comment like button only shows that number and never adds or subtracts on its own.
 * - No GET: the like count and `likedByMe` travel with the comment payload.
 *
 * Auth required, same origin (403/415), the id must be a UUID (400, the backend is not called), session refresh
 * when needed (lib/user-api.ts). Every response is `private, no-store`: `likedByMe` belongs to one person, and no
 * count sits in the cached post page data, so there is no tag to revalidate. The body is dropped: the liker
 * is always the session owner, never taken from the body.
 */

type Context = RouteContext<'/api/comments/[id]/like'>

async function likePath(ctx: Context): Promise<string | null> {
  const comment = commentApiPath((await ctx.params).id)
  return comment === null ? null : `${comment}/like`
}

export async function PUT(request: NextRequest, ctx: Context): Promise<Response> {
  return forwardWrite(request, await likePath(ctx), 'PUT', { forwardBody: false })
}

export async function DELETE(request: NextRequest, ctx: Context): Promise<Response> {
  return forwardWrite(request, await likePath(ctx), 'DELETE', { forwardBody: false })
}
