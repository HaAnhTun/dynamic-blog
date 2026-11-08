/**
 * Blocks cross-site writes for route handlers that use the session cookie.
 *
 * Four independent layers, none enough on its own:
 *   1. `Sec-Fetch-Site`, if present, must be `same-origin`. Missing is allowed: Safari before 16.4
 *      does not send it (same reason as app/api/views/route.ts).
 *   2. `Origin`, if present, must have the same host as `Host`. `Origin: null` (sandboxed iframe, cross
 *      redirect) cannot be parsed as a URL and is rejected.
 *   3. POST and PUT must be `application/json`: a `<form>` from another site can only send
 *      urlencoded, multipart or text/plain; and a cross-origin fetch carrying JSON must go through a
 *      CORS preflight, which the site never answers.
 *   4. Baseline: a `SameSite=Lax` cookie does not travel with a cross-site POST/PUT/DELETE.
 * (A fifth layer, the body size limit, is in lib/read-small-body.ts.)
 *
 * Only /admin/logout uses `requireJson: false` (via lib/logout.ts): the admin sign-out button sends a
 * bare POST from before this check existed, and the consequence if it is forged is only being signed out. The reader's sign-out
 * (/api/auth/logout) still demands JSON like every other write route.
 */

const PRIVATE_NO_STORE = 'private, no-store'

function refuse(status: 403 | 415, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status, headers: { 'cache-control': PRIVATE_NO_STORE } })
}

function originMatchesHost(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (origin === null) return true // a same-origin fetch may not send it
  try {
    return new URL(origin).host === request.headers.get('host')
  } catch {
    return false
  }
}

function isJson(request: Request): boolean {
  const type = request.headers.get('content-type')
  if (type === null) return false
  return type.split(';', 1)[0]!.trim().toLowerCase() === 'application/json'
}

/** Returns the rejection response (403/415), or null when the request may continue. */
export function assertSameOriginRequest(
  request: Request,
  { requireJson = true }: { requireJson?: boolean } = {},
): Response | null {
  const site = request.headers.get('sec-fetch-site')
  if (site !== null && site !== 'same-origin') {
    return refuse(403, 'FORBIDDEN', 'Cross-origin request refused')
  }
  if (!originMatchesHost(request)) {
    return refuse(403, 'FORBIDDEN', 'Cross-origin request refused')
  }
  if (requireJson && (request.method === 'POST' || request.method === 'PUT') && !isJson(request)) {
    return refuse(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json')
  }
  return null
}
