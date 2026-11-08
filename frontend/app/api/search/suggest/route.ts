import { NextResponse } from 'next/server'
import { isLocale } from '@/i18n/config'
import { clientIp } from '@/lib/client-ip'
import { retryAfterSeconds } from '@/lib/rate-limit'
import { assertSameOriginRequest } from '@/lib/same-origin'
import { cleanQuery, isSearchScope, SEARCH_LIMITS, type SuggestResponse } from '@/lib/search-contract'
import { allowSearch, buildSuggest, SEARCH_RATE, SearchUnavailableError, SUGGEST_TIMEOUT_MS } from '@/lib/search-suggest'
import { bffError, PRIVATE_NO_STORE } from '@/lib/user-api'

/**
 * The quick search panel (the source is the backend). Do not set `fetchCache`: the only fetch carrying `q`
 * (`searchContent`) is already `no-store`.
 */
/** The route never logs or returns `q` in an error: a backend error becomes just a code. */
export async function GET(request: Request): Promise<NextResponse> {
  const refused = assertSameOriginRequest(request)
  if (refused) return bffError(refused.status, 'FORBIDDEN', 'Cross-origin request refused')

  const params = new URL(request.url).searchParams
  const raw = params.get('q') ?? ''
  const scope = params.get('type') ?? 'all'
  if (!isSearchScope(scope)) return bffError(400, 'VALIDATION_ERROR', 'Unknown type')
  // As the backend: longer than 200 is 400. The panel input has maxLength 200, so only a hand-built request gets here.
  if (raw.trim().length > SEARCH_LIMITS.query) return bffError(400, 'VALIDATION_ERROR', 'Query too long')

  // An unknown language is ignored (all languages), like a missing one.
  const lang = params.get('lang')
  const language = isLocale(lang) ? lang : undefined
  const query = cleanQuery(raw)
  if (query.length < SEARCH_LIMITS.minChars) return reply({ query, groups: [], degraded: false })

  const ip = clientIp(request)
  if (!allowSearch(ip)) {
    const response = bffError(429, 'RATE_LIMITED', 'Too many searches')
    response.headers.set('retry-after', String(retryAfterSeconds(SEARCH_RATE.bucket, ip)))
    return response
  }

  try {
    return reply(await buildSuggest(query, scope, AbortSignal.timeout(SUGGEST_TIMEOUT_MS), language, ip))
  } catch (error) {
    switch (error instanceof SearchUnavailableError ? error.failure : 'unavailable') {
      case 'timeout':
        return bffError(504, 'UPSTREAM_TIMEOUT', 'Search timed out')
      // The backend's own cap (per address or the shared ceiling, no Retry-After): same code as the route quota.
      case 'rate-limited':
        return bffError(429, 'RATE_LIMITED', 'Too many searches')
      case 'invalid':
        return bffError(400, 'VALIDATION_ERROR', 'Invalid search')
      default:
        return bffError(502, 'UPSTREAM_UNAVAILABLE', 'Search unavailable')
    }
  }
}

function reply(body: SuggestResponse): NextResponse {
  return NextResponse.json(body, { headers: { 'cache-control': PRIVATE_NO_STORE } })
}
