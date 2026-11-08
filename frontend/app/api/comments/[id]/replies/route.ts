import type { NextRequest } from 'next/server'
import { commentApiPath, forwardWrite } from '@/lib/bff-route'

/**
 * POST /api/comments/<id>/replies: reply to a top-level comment.
 *
 * The JSON body `{ content }` goes verbatim to the backend, which checks depth (only top-level comments can be replied to),
 * the cap of 30 replies per thread, and length. Auth required, same origin, `private, no-store`.
 */

type Context = RouteContext<'/api/comments/[id]/replies'>

export async function POST(request: NextRequest, ctx: Context): Promise<Response> {
  const comment = commentApiPath((await ctx.params).id)
  return forwardWrite(request, comment === null ? null : `${comment}/replies`, 'POST', { forwardBody: true })
}
