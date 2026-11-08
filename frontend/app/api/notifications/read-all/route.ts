import type { NextRequest } from 'next/server'
import { NOTIFICATIONS_API_PATH, forwardWrite, isCommentCursor } from '@/lib/bff-route'

/**
 * /api/notifications/read-all: mark every notification of the logged-in user as read. The static
 * `read-all` segment wins over `[id]` in the neighboring folder.
 *
 * POST (auth required, same origin, no body): the optional `before` is the `headCursor` of the page the reader already
 * loaded — notifications that arrived after it stay unread. It must be a valid keyset cursor (the same shape as the comment
 * cursor), otherwise 400 without calling the backend, and it is the ONLY query parameter forwarded. Without
 * `before` (the loaded list is empty) everything is marked. Returns `{ data: { count } }` after the change.
 *
 * Check order of `forwardWrite`: same origin (403/415) before even the parameter check, then 400, then the body of at most
 * 16 KB (413). Every response is `private, no-store`.
 */

export async function POST(request: NextRequest): Promise<Response> {
  const before = request.nextUrl.searchParams.get('before')
  const base = `${NOTIFICATIONS_API_PATH}/read-all`
  let path: string | null = base
  if (before !== null) path = isCommentCursor(before) ? `${base}?${new URLSearchParams({ before })}` : null
  return forwardWrite(request, path, 'POST', { forwardBody: false })
}
