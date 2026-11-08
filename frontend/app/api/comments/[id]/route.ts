import type { NextRequest } from 'next/server'
import { commentApiPath, forwardWrite } from '@/lib/bff-route'

/**
 * /api/comments/<id>: edit and delete your own comment.
 *
 * - PUT `{ content }`: edit. The body goes verbatim to the backend, which checks permission (author only), status
 *   (VISIBLE only) and length.
 * - DELETE: soft delete, 204. The body (if any) is dropped.
 *
 * Both require auth, same origin, `private, no-store`. Ownership is decided by the backend from the session;
 * this route only rejects ids that are not UUIDs before they become a backend path.
 */

type Context = RouteContext<'/api/comments/[id]'>

export async function PUT(request: NextRequest, ctx: Context): Promise<Response> {
  return forwardWrite(request, commentApiPath((await ctx.params).id), 'PUT', { forwardBody: true })
}

export async function DELETE(request: NextRequest, ctx: Context): Promise<Response> {
  return forwardWrite(request, commentApiPath((await ctx.params).id), 'DELETE', { forwardBody: false })
}
