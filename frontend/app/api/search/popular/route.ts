import { NextResponse } from 'next/server'
import { isLocale } from '@/i18n/config'
import { clientIp } from '@/lib/client-ip'
import { rateLimit } from '@/lib/rate-limit'
import { assertSameOriginRequest } from '@/lib/same-origin'
import type { PopularResponse } from '@/lib/search-contract'
import { buildPopular, SEARCH_RATE } from '@/lib/search-suggest'
import { bffError, PRIVATE_NO_STORE } from '@/lib/user-api'

/**
 * The "Most read" of the quick search panel before anything is typed. There is no query here; the data is
 * the popular list cached for 300 s (`getPopularPosts`). It shares the quota with suggest: each time the panel opens
 * counts as one request.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const refused = assertSameOriginRequest(request)
  if (refused) return bffError(refused.status, 'FORBIDDEN', 'Cross-origin request refused')
  if (!rateLimit(SEARCH_RATE.bucket, clientIp(request), SEARCH_RATE.limit, SEARCH_RATE.windowMs)) {
    return bffError(429, 'RATE_LIMITED', 'Too many searches')
  }

  const lang = new URL(request.url).searchParams.get('lang')
  try {
    const body: PopularResponse = { items: await buildPopular(isLocale(lang) ? lang : undefined) }
    return NextResponse.json(body, { headers: { 'cache-control': PRIVATE_NO_STORE } })
  } catch {
    return bffError(502, 'UPSTREAM_UNAVAILABLE', 'Popular posts unavailable')
  }
}
