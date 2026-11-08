import type { NextRequest } from 'next/server'
import { forwardWrite, notificationApiPath } from '@/lib/bff-route'

/**
 * /api/notifications/<id>/read: mark one notification as read, when the reader opens it.
 *
 * POST (auth required, same origin, no body): idempotent at the backend — already read is still 200. Returns
 * `{ data: { count } }` after the change. The id must be a UUID (400, the backend is not called); another user's
 * notification is 404 NOTIFICATION_NOT_FOUND, never 403. The client sends with `keepalive`: the reader is leaving
 * the page for the post. Every response is `private, no-store`.
 */

type Context = RouteContext<'/api/notifications/[id]/read'>

export async function POST(request: NextRequest, ctx: Context): Promise<Response> {
  const notification = notificationApiPath((await ctx.params).id)
  return forwardWrite(request, notification === null ? null : `${notification}/read`, 'POST', { forwardBody: false })
}
