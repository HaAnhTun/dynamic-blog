import type { NextRequest } from 'next/server'
import { NOTIFICATIONS_API_PATH, forwardPrivateRead, invalidParameter, isCommentCursor } from '@/lib/bff-route'

/**
 * /api/notifications: the logged-in user's notification inbox.
 *
 * GET (auth required): one page, newest first. Three parameters, each validated before reaching the backend — an invalid one
 * is a 400 VALIDATION_ERROR and the backend is not called:
 *   - `after`: the keyset cursor of the previous page, same shape as the comment cursor (`^[A-Za-z0-9_-]{1,200}$`);
 *   - `size`: 1–50, one or two digits (the bell asks for 6, the /notifications page asks for 20);
 *   - `unread`: `true` or `false`.
 * The query sent to the backend is rebuilt only from validated values; every other parameter is dropped. No session
 * means 401 without calling the backend.
 *
 * Every response is `private, no-store`: notifications belong to one person, no cache may keep them.
 */

const SIZE = /^\d{1,2}$/
const MAX_SIZE = 50

function isSize(value: string): boolean {
  return SIZE.test(value) && Number(value) >= 1 && Number(value) <= MAX_SIZE
}

export async function GET(request: NextRequest): Promise<Response> {
  const params = request.nextUrl.searchParams
  const after = params.get('after')
  const size = params.get('size')
  const unread = params.get('unread')
  if (
    (after !== null && !isCommentCursor(after)) ||
    (size !== null && !isSize(size)) ||
    (unread !== null && unread !== 'true' && unread !== 'false')
  ) {
    return invalidParameter()
  }

  const query = new URLSearchParams()
  if (after !== null) query.set('after', after)
  // "06" becomes "6": the backend gets the exact number, not the string the caller typed.
  if (size !== null) query.set('size', String(Number(size)))
  if (unread !== null) query.set('unread', unread)
  const search = query.toString()
  return forwardPrivateRead(request, search === '' ? NOTIFICATIONS_API_PATH : `${NOTIFICATIONS_API_PATH}?${search}`)
}
