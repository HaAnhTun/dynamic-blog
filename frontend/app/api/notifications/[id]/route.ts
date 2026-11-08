import type { NextRequest } from 'next/server'
import { forwardWrite, notificationApiPath } from '@/lib/bff-route'

/**
 * /api/notifications/<id>: permanently delete one of your own notifications.
 *
 * DELETE (auth required, same origin, no body): 200 `{ data: { count } }`, not 204 — the /notifications page
 * updates the bell with that number. The id must be a UUID (400, the backend is not called); a notification
 * that does not exist, was deleted, or belongs to someone else is 404 NOTIFICATION_NOT_FOUND. DELETE only: any other method
 * here is a Next 405. Every response is `private, no-store`.
 */

type Context = RouteContext<'/api/notifications/[id]'>

export async function DELETE(request: NextRequest, ctx: Context): Promise<Response> {
  return forwardWrite(request, notificationApiPath((await ctx.params).id), 'DELETE', { forwardBody: false })
}
