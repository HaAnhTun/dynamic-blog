import type { NextRequest } from 'next/server'
import { NOTIFICATIONS_API_PATH, forwardPrivateRead } from '@/lib/bff-route'

/**
 * /api/notifications/unread-count: the unread notification count of the logged-in user,
 * what the bell asks for on page load, when returning to the tab, and every 60 seconds (lib/notifications-client.ts).
 *
 * GET (auth required): `{ data: { count } }`, capped by the server at 100. No session means 401 without calling the
 * backend; the backend status and envelope (403 USER_SUSPENDED, the 403 `denyAll` of an older backend not yet
 * restarted) pass through intact. Every response is `private, no-store`.
 */

export async function GET(request: NextRequest): Promise<Response> {
  return forwardPrivateRead(request, `${NOTIFICATIONS_API_PATH}/unread-count`)
}
