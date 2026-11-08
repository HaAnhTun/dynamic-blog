import type { NextRequest } from 'next/server'
import { forwardPrivateRead, invalidParameter } from '@/lib/bff-route'

/**
 * /api/me/bookmarks: one page of the caller's own bookmarked posts, most recently saved first. `page` and `size` (1–50)
 * are validated then rebuilt, every other parameter is dropped; invalid is 400, no session is 401, and neither calls the backend.
 */

const API_PATH = '/api/v1/me/bookmarks'
// Six digits: page × size (≤ 50) never overflows an int at the backend.
const PAGE = /^\d{1,6}$/
const SIZE = /^\d{1,2}$/
const MAX_SIZE = 50

function isSize(value: string): boolean {
  return SIZE.test(value) && Number(value) >= 1 && Number(value) <= MAX_SIZE
}

export async function GET(request: NextRequest): Promise<Response> {
  const params = request.nextUrl.searchParams
  const page = params.get('page')
  const size = params.get('size')
  if ((page !== null && !PAGE.test(page)) || (size !== null && !isSize(size))) return invalidParameter()

  const query = new URLSearchParams()
  if (page !== null) query.set('page', String(Number(page)))
  if (size !== null) query.set('size', String(Number(size)))
  const search = query.toString()
  return forwardPrivateRead(request, search === '' ? API_PATH : `${API_PATH}?${search}`)
}
