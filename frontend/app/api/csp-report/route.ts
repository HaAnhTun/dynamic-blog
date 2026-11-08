import { clientIp } from '@/lib/client-ip'
import { isReportContentType, readViolations } from '@/lib/csp-report'
import { rateLimit } from '@/lib/rate-limit'
import { payloadTooLarge, readSmallBody } from '@/lib/read-small-body'

/**
 * POST /api/csp-report: where a browser sends the report of a Content-Security-Policy violation (`report-uri` and `report-to` of
 * the policy in csp-policy.mjs, next.config.ts). It writes one log line per violation and nothing else: the answer is a bare 204.
 *
 * An anonymous endpoint that writes to a log is a place to flood the log, so it is narrow on purpose:
 * - only the two report media types are accepted (`application/csp-report`, `application/reports+json`). Neither is one a
 *   cross-site `<form>` can send, and a cross-site `fetch` with them needs a preflight the site never answers;
 * - the body is at most 8 KiB (a report is a few hundred bytes), read with a limit, not trusted from Content-Length;
 * - 100 requests per 10 minutes per address (lib/rate-limit.ts, like the other anonymous routes), counted before the body is read;
 * - at most 10 violations are read from one batch (lib/csp-report.ts).
 *
 * What is logged is the directive and the origin of what was blocked (`[csp] violation img-src blocked=https://host`). The address
 * of the page, its query string, the referrer, the source file and the script sample are never read: a page address can hold a
 * search query or a token (docs/SECURITY.md, "Content Security Policy").
 *
 * No same-origin check, on purpose: browsers send reports without the cookies and headers such a check expects, and the route
 * changes no state. No session, no backend call. `proxy.ts` leaves `/api` alone, and robots.ts already keeps crawlers out of it.
 */

const BODY_LIMIT = 8 * 1024
const BUCKET = 'csp-report'
const LIMIT = 100
const WINDOW_MS = 10 * 60_000

function answer(status: number): Response {
  return new Response(null, { status, headers: { 'cache-control': 'no-store' } })
}

export async function POST(request: Request): Promise<Response> {
  if (!isReportContentType(request.headers.get('content-type'))) return answer(415)
  if (!rateLimit(BUCKET, clientIp(request), LIMIT, WINDOW_MS)) return answer(429)

  const raw = await readSmallBody(request, BODY_LIMIT)
  if (raw === null) return payloadTooLarge()
  const violations = readViolations(request.headers.get('content-type'), raw)
  if (violations === null) return answer(400)

  for (const { directive, blocked } of violations) console.warn(`[csp] violation ${directive} blocked=${blocked}`)
  return answer(204)
}
