import type { NextRequest, NextResponse } from 'next/server'
import { isAuthRequestBlob, oauthRedirect, setOauthFlowCookie } from '@/lib/oauth-flow-cookie'
import { allowOAuthAttempt } from '@/lib/rate-limit'
import { loginErrorPath, loginPath, safeReturnTo } from '@/lib/return-to'
import { apiBaseUrl } from '@/lib/api-base-url'

/**
 * GET /api/auth/github/start?returnTo=…: begins the GitHub login.
 *
 * The browser only talks to the site origin. Next asks the backend (Spring `oauth2Login`, on a
 * path only Next calls) for the GitHub authorize URL — already carrying state, PKCE and redirect_uri —
 * together with the signed `oauth2_auth_request` blob, then sends the reader to GitHub and keeps the
 * blob in the site's own `oauth_flow` cookie.
 *
 * The link to here is a plain `<a href rel="nofollow">`, never a `<Link>`: the Next router
 * prefetches links, which would start an OAuth round by itself. robots.ts already blocks /api. A
 * route handler GET is never cached.
 *
 * Only a person's own navigation starts a round (audit 037, {@link isPersonNavigation}). Every start spends one of the 20 attempts
 * per 10 minutes of the visitor's address and costs a backend call, and a start is a GET that any page can trigger: a third-party
 * page with 21 `<img src="/api/auth/github/start">` would lock the sign-in of everybody behind that address (a whole office, a
 * mobile carrier) for 10 minutes, and a cross-site navigation here, with a GitHub session in the browser, ends in the callback
 * replacing the visitor's session. The check comes before the rate limit and before any call, so a refused request costs nothing.
 */

const AUTH_REQUEST_COOKIE = 'oauth2_auth_request'
const TIMEOUT_MS = 10_000

/** Read at call time, not at module load: changing the env needs no rebuild, and tests can change it. */
function apiBase(): string {
  return apiBaseUrl()
}

/**
 * The `oauth2_auth_request` value in the backend Set-Cookie headers, if it has the signed blob
 * shape. Take the LAST one with that name, as a browser does: a later deleting Set-Cookie leaves no blob.
 */
function authRequestBlob(res: Response): string | null {
  let value: string | null = null
  for (const header of res.headers.getSetCookie()) {
    const pair = header.split(';', 1)[0] ?? ''
    const eq = pair.indexOf('=')
    if (eq !== -1 && pair.slice(0, eq).trim() === AUTH_REQUEST_COOKIE) value = pair.slice(eq + 1).trim()
  }
  return value !== null && isAuthRequestBlob(value) ? value : null
}

/** The GitHub Location (or the E2E GitHub mock on loopback): http(s) only. */
function providerLocation(res: Response): string | null {
  const location = res.headers.get('location')
  if (!location) return null
  try {
    const { protocol } = new URL(location)
    return protocol === 'https:' || protocol === 'http:' ? location : null
  } catch {
    return null
  }
}

/**
 * Whether this GET is the top-level navigation of a person on this site: a click on the sign-in button (`same-origin`), or an
 * address typed or bookmarked (`none`). Read from Fetch Metadata, which the browser sets and a page cannot forge:
 *   - `Sec-Fetch-Mode` must be `navigate` and `Sec-Fetch-Dest` `document` when sent, which refuses `<img>`, `<script>`, `fetch`,
 *     `<iframe>` and the like whatever the origin;
 *   - `Sec-Fetch-Site` must be `same-origin` or `none`: a link from another site (`cross-site`) or from a sibling host
 *     (`same-site`) is refused. Nothing needs those: the sign-in button is on this site.
 * A browser that sends no Fetch Metadata at all (an old one, a script) keeps today's behavior: it is let through.
 */
function isPersonNavigation(request: NextRequest): boolean {
  const site = request.headers.get('sec-fetch-site')
  const mode = request.headers.get('sec-fetch-mode')
  const dest = request.headers.get('sec-fetch-dest')
  if (site === null && mode === null && dest === null) return true
  if (mode !== null && mode !== 'navigate') return false
  if (dest !== null && dest !== 'document') return false
  return site === null || site === 'same-origin' || site === 'none'
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const returnTo = safeReturnTo(request.nextUrl.searchParams.get('returnTo'))
  // Before the rate limit and before any call: a request a person did not make spends nothing and reaches nothing.
  if (!isPersonNavigation(request)) return oauthRedirect(loginPath(returnTo))
  if (!allowOAuthAttempt(request)) return oauthRedirect(loginErrorPath('rate', returnTo))

  let res: Response
  try {
    res = await fetch(`${apiBase()}/api/v1/auth/oauth2/authorization/github`, {
      // The backend answer IS a redirect to GitHub: read it, do not follow it.
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    // Only the error name (TypeError, TimeoutError): nothing about the reader is here to leak.
    console.warn(`[oauth] start: backend did not answer (${error instanceof Error ? error.name : 'unknown error'}).`)
    return oauthRedirect(loginErrorPath('unavailable', returnTo))
  }
  await res.body?.cancel()

  // The backend has OAuth disabled (GITHUB_CLIENT_ID/SECRET missing): the chain still exists, the request
  // falls through to DispatcherServlet and gets a 404 ENDPOINT_NOT_FOUND.
  if (res.status === 404) return oauthRedirect(loginErrorPath('disabled', returnTo))

  const location = res.status === 302 ? providerLocation(res) : null
  const blob = location === null ? null : authRequestBlob(res)
  if (location === null || blob === null) return oauthRedirect(loginErrorPath('unavailable', returnTo))

  const response = oauthRedirect(location)
  setOauthFlowCookie(response, returnTo, blob)
  return response
}
