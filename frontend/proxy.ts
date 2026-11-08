// frontend/proxy.ts
import createIntlMiddleware from 'next-intl/middleware'
import { NextResponse, type NextRequest } from 'next/server'
import { routing } from '@/i18n/routing'
import {
  accessCookieName,
  clearSessionCookies,
  readSessionTokens,
  refreshCookieName,
  setSessionCookies,
} from '@/lib/auth-cookies'
import { clientIp, clientIpHeaders } from '@/lib/client-ip'
import { isExpiringWithin, roleOf } from '@/lib/jwt'
import { apiBaseUrl } from '@/lib/api-base-url'
import { limitReads, type ReadKind } from '@/lib/read-limit'

const BASE_URL = apiBaseUrl()
const LOGIN_PATH = '/admin/login'
// Must equal LOGIN_ENDPOINT in app/admin/login/LoginForm.tsx.
const LOGIN_SUBMIT_PATH = '/admin/login/submit'
/**
 * The second step of a sign-in: the two pages and the three route handlers they post to. Reached after the first factor and before any
 * session exists (the challenge cookie is the only credential), so, like the login itself, they must stay open. Each string must
 * equal the endpoint of its client component (MFA_ENDPOINT in app/admin/login/mfa/MfaForm.tsx, ENROLL_BEGIN_ENDPOINT and
 * ENROLL_CONFIRM_ENDPOINT in app/admin/login/enroll/EnrollForm.tsx) and the folder of its route.ts; `/admin/login/mfaX` is not one of them.
 */
const SIGN_IN_STEP_PATHS: ReadonlySet<string> = new Set([
  '/admin/login/mfa',
  '/admin/login/mfa/submit',
  '/admin/login/enroll',
  '/admin/login/enroll/begin',
  '/admin/login/enroll/confirm',
])
/** The login page with the "no permission" sentence (app/admin/login/page.tsx reads `reason`). */
const FORBIDDEN_PATH = `${LOGIN_PATH}?reason=forbidden`
/** The only role that could enter the /admin UI before authors were allowed. */
/** The roles allowed into /admin (AUTHOR was added). An admin-only page shows the no-permission state to an AUTHOR itself. */
const ADMIN_ROLES: ReadonlySet<string> = new Set(['ADMIN', 'AUTHOR'])

/**
 * Seconds. A token that passes this check still has to survive the round trip to the
 * API, and a Server Component cannot set a cookie, so a token that expires in flight
 * produces a 401 the page cannot recover from. The margin makes that rare rather than
 * routine; the spec accepts the remaining gap and treats it as a session expiry.
 */
const EXPIRY_MARGIN_SECONDS = 30

function clearSession(response: NextResponse): NextResponse {
  clearSessionCookies(response)
  return response
}

function toLogin(request: NextRequest, clearCookies: boolean): NextResponse {
  const response = NextResponse.redirect(new URL(LOGIN_PATH, request.url))
  return clearCookies ? clearSession(response) : response
}

/**
 * A Server Action call from the client-side router: always a POST carrying the action id in the
 * `next-action` header. The same check Next uses (`isFetchAction`,
 * next/dist/server/lib/server-action-request-meta.js).
 */
function isServerActionCall(request: NextRequest): boolean {
  return request.method === 'POST' && request.headers.has('next-action')
}

/**
 * The three content types an HTML `<form>` can send. A POST of one of them to /admin that is not a Server Action call is a plain
 * form submission: the admin UI never sends one (its forms are driven by the client router, which sets `next-action`; the other
 * admin forms are GET), so the only source is a form an author managed to plant in a page of this origin, or one on another site.
 */
const FORM_CONTENT_TYPE = /^\s*(?:multipart\/form-data|application\/x-www-form-urlencoded|text\/plain)/i

function isPlainFormPost(request: NextRequest): boolean {
  return (
    request.method === 'POST' &&
    !request.headers.has('next-action') &&
    FORM_CONTENT_TYPE.test(request.headers.get('content-type') ?? '')
  )
}

/**
 * No usable session: a page goes to the login, while a Server Action call is let through.
 *
 * Redirecting an action fails silently. The browser fetch follows the 307 by itself and POSTs the same body
 * again, with the `next-action` header, to /admin/login; that page has no such action so Next returns a 404
 * `x-nextjs-action-not-found`, the client throws UnrecognizedActionError, and every admin screen shows
 * "Could not reach the server, try again later." (measured on the QA stack). The editor never reaches the "session expired"
 * sentence with a login link in a new tab, which exists precisely to keep the post being drafted.
 *
 * A 401 returned straight from here does not help either: the Next client (fetchServerAction in
 * server-action-reducer.js) turns every non-RSC response into a generic `Error`, and the screen
 * again shows "Could not reach the server, try again later.".
 *
 * Letting it through makes the action itself report the expired session, by the path that already exists and is tested: with no
 * access cookie (or an empty cookie because it was just deleted here, which the action cookies() sees through
 * x-middleware-set-cookie) `adminRequest` throws SessionExpiredError without calling the API; the editor
 * receives `{ sessionExpired: true }` and shows its sentence in place, the other screens go through
 * runAdminAction and are sent back to /admin/login. When the API is dead the action reports "cannot connect",
 * and this time that is correct.
 *
 * Nothing more is opened up: the proxy was never the permission gate of an action (it does not check the JWT signature, and
 * the Next docs, proxy.md, say to check permission inside each Server Function). Every admin action only
 * works through the backend with the caller's token, and the backend is where the decision is made.
 */
function withoutSession(request: NextRequest, clearCookies: boolean): NextResponse {
  if (!isServerActionCall(request)) return toLogin(request, clearCookies)
  const response = NextResponse.next()
  return clearCookies ? clearSession(response) : response
}

/**
 * The role gate, run once a usable access token exists (existing, or just rotated): the /admin UI
 * is for ADMIN and AUTHOR. USER, a token
 * with no role or an unknown role all go to /admin/login?reason=forbidden, RSC requests and
 * prefetches included. The cookies are not deleted: a reader refused /admin is still logged in on the public
 * part, and the pair just rotated must reach the browser (the caller sets it on this very response).
 *
 * The claim only decides the NAVIGATION of the UI, never data. Its signature is not checked
 * here (lib/jwt.ts), and need not be: all admin data goes through the backend with the caller's token, and the
 * backend reads the current role from the DB for every ADMIN/AUTHOR claim, so a forged or
 * stale claim only opens an empty shell.
 *
 * A Server Action call always goes on, on purpose: a redirect or 403 here both turn into
 * "Could not reach the server, try again later." (see withoutSession). Letting it through runs the action, the backend returns 403 FORBIDDEN and
 * runAdminAction shows its own "This account is not allowed to do that." sentence.
 */
function admit(request: NextRequest, accessToken: string): NextResponse {
  const role = roleOf(accessToken)
  if ((role !== null && ADMIN_ROLES.has(role)) || isServerActionCall(request)) return NextResponse.next()
  return NextResponse.redirect(new URL(FORBIDDEN_PATH, request.url))
}

/** A refresh refused because the token was revoked (the error code in the backend envelope). */
async function isRevoked(upstream: Response): Promise<boolean> {
  const body = (await upstream.json().catch(() => null)) as { error?: { code?: unknown } } | null
  return body?.error?.code === 'REFRESH_TOKEN_REVOKED'
}

const handleI18n = createIntlMiddleware(routing)

/**
 * The two paths that cannot count themselves, and what each is counted under (lib/read-limit.ts): the image optimizer of Next, whose
 * fetch of `/media` carries no reader address, and the sitemap, a metadata route that cannot answer 429.
 */
const COUNTED_PATHS: Readonly<Record<string, ReadKind>> = { '/_next/image': 'image', '/sitemap.xml': 'sitemap' }

/**
 * `/admin` keeps its own auth logic below and has no locale in the URL. Every other path that reaches this function goes
 * through next-intl (the matcher keeps `/api`, `/media`, `/random`, files and Next internals out): it rewrites the default
 * locale to its internal `/<locale>` route, redirects `/<default>/...` to the canonical unprefixed URL, and leaves the rest.
 *
 * The runtime check on the path below is not redundant with the matcher: the matcher is build-time static analysis of a
 * literal, this is the failure it prevents if the matcher is ever widened, the whole site bouncing to the login page. It
 * reproduces the matcher's measured behavior exactly: /admin and /admin/anything are admin, /administrator is not.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl
  const counted = COUNTED_PATHS[pathname]
  if (counted !== undefined) return countedProxy(request, counted)
  if (pathname === '/admin' || pathname.startsWith('/admin/')) return adminProxy(request)
  // The first-run /setup page has no locale in its URL and no session; like the matcher, this keeps it out of next-intl.
  if (pathname === '/setup' || pathname.startsWith('/setup/')) return NextResponse.next()
  return handleI18n(request)
}

/**
 * The per-address allowance of a path that cannot count itself. `/_next/image` decodes, resizes and encodes a picture for every size of
 * every picture it has not optimized yet; its own fetch of `/media/<id>` does not come through here (the matcher lists only this path)
 * and the route does not count it either (`isOptimizerFetch`), so the reader is counted once, here, with the address the proxy wrote in
 * `x-forwarded-for`. The sitemap reads every published post from the backend. Nothing else is done to the request.
 */
function countedProxy(request: NextRequest, kind: ReadKind): NextResponse {
  const limited = limitReads(request, kind)
  if (limited === null) return NextResponse.next()
  return new NextResponse(null, { status: limited.status, headers: limited.headers })
}

async function adminProxy(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl

  // The login page, the login POST target and the logout handler must all stay
  // reachable without a session. Without this, logging in requires already being
  // logged in — and the POST target is the easy one to forget, because the page it
  // belongs to is listed right next to it and looks like it covers both.
  //
  // LOGIN_SUBMIT_PATH is a sibling segment of the login page rather than the page's own
  // path: a segment cannot serve both a `page` and a `route`, and when both exist the
  // page silently shadows the handler at runtime while `next build` refuses outright.
  if (
    pathname === LOGIN_PATH ||
    pathname === LOGIN_SUBMIT_PATH ||
    SIGN_IN_STEP_PATHS.has(pathname) ||
    pathname === '/admin/logout'
  ) {
    return NextResponse.next()
  }

  // Defense in depth against a form planted in a page of this origin (an Origin versus Host comparison is the only other CSRF check
  // of a Server Action): refused before any session logic, with no body to read.
  if (isPlainFormPost(request)) return new NextResponse(null, { status: 403 })

  const refreshToken = request.cookies.get(refreshCookieName())?.value
  if (!refreshToken) {
    return withoutSession(request, false)
  }

  const accessToken = request.cookies.get(accessCookieName())?.value
  if (accessToken && !isExpiringWithin(accessToken, EXPIRY_MARGIN_SECONDS)) {
    return admit(request, accessToken)
  }

  let upstream: Response
  try {
    upstream = await fetch(`${BASE_URL}/api/v1/auth/refresh`, {
      method: 'POST',
      // The visitor's address for the backend's per-address refresh limit (lib/client-ip.ts).
      headers: { 'content-type': 'application/json', ...clientIpHeaders(clientIp(request)) },
      body: JSON.stringify({ refreshToken }),
      cache: 'no-store',
    })
  } catch {
    // The API is down. Redirecting is a worse experience than an error page but a much
    // better failure: an error page on /admin with a live session looks like data loss.
    return withoutSession(request, false)
  }

  if (!upstream.ok) {
    // The session may well be alive: the backend limits refreshes per client address (it can answer 429 when many readers share an
    // address, or when junk refresh cookies flood the limiter), and 408 or 5xx mean "try again later". Clearing the cookies here would
    // sign the admin out and leave a valid refresh token that nobody holds. The same rule as callRefresh in lib/session-refresh.ts.
    if (upstream.status === 429 || upstream.status === 408 || upstream.status >= 500) {
      await upstream.body?.cancel()
      return withoutSession(request, false)
    }
    // REFRESH_TOKEN_REVOKED is almost certainly a lost rotation race, and now not only against
    // another /admin tab but against /api/session of every public page (lib/session-refresh.ts),
    // on the same cookie pair. The winner is setting the new pair: deleting here, with this response
    // arriving later, overwrites that pair, logs the admin out in every tab and leaves behind a refresh
    // token that lives 30 days with nobody holding it. So the cookies are not touched, like lib/user-api.ts.
    if (await isRevoked(upstream)) return withoutSession(request, false)
    // Expired, invalid, suspended, or unknown. Clear the cookies so the next request does
    // not spend another doomed refresh before redirecting.
    return withoutSession(request, true)
  }

  const payload = (await upstream.json().catch(() => null)) as { data?: unknown } | null
  const rotated = readSessionTokens(payload?.data)
  if (rotated === null) {
    return withoutSession(request, true)
  }

  // Plain `NextResponse.next()` — NOT `next({ request: { headers } })`. The plan left
  // this as an open question: it feared that the page rendered in this same pass would
  // read the OLD cookie, because the cookie is set on the response while the request
  // still carries the stale one, and proposed rewriting the forwarded `cookie` header
  // as the fix. Measured against Next 16.3.7 instead of reasoned about, and the fear
  // does not hold here; the rewrite would be dead weight:
  //
  //   1. `response.cookies.set` writes `Set-Cookie` AND the internal
  //      `x-middleware-set-cookie` header
  //      (server/web/spec-extension/response.js, the `cookies` Proxy).
  //   2. The server copies that header onto the DOWNSTREAM request rather than the
  //      response — `if (key === 'x-middleware-set-cookie') { req.headers[key] = value }`
  //      (server/lib/router-utils/resolve-routes.js).
  //   3. `cookies()` merges it into the jar it returns, so the render sees the FRESH
  //      token (server/async-storage/request-store.js, `mergeMiddlewareCookies`).
  //
  // middleware.test.ts drives steps 1 and 3 for real, with a control proving the merge
  // is what makes the difference. Caveat recorded there: Next's own TODO notes the
  // merge only fires when the render's headers are Node `IncomingHttpHeaders`, which
  // is the `next dev` / `next start` path we deploy.
  //
  // The role is read from the token JUST received, not the old token, and the new pair is set on exactly the response
  // the role gate returns — even when that is a redirect to the "no permission" notice.
  const response = admit(request, rotated.accessToken)
  // 4a rotates on every refresh and revokes the token it was given, so storing the new
  // refresh token is not an optimisation — keeping the old one breaks the NEXT refresh.
  setSessionCookies(response, rotated)
  return response
}

// Public paths go through next-intl, and so does /admin (its own branch above). Left out: the API, media, /random, /setup, the site
// OG image, Next internals, robots.txt, sitemap.xml and any file with an extension except feeds (feed.xml must be
// locale-routed). `/_next/image` and `/sitemap.xml` are listed on purpose: the proxy only counts them (`countedProxy`).
//
// `/admin` and everything under it are matched explicitly, whatever the last segment looks like: a dynamic admin route such as
// `/admin/settings/[key]` accepts `about.x`, which the extension exclusion would otherwise take for a file and skip, along with the
// plain-form-post gate and the session redirect.
export const config = {
  matcher: [
    '/admin',
    '/admin/:path*',
    '/_next/image',
    '/sitemap.xml',
    '/((?!api(?:/|$)|media(?:/|$)|setup(?:/|$)|random$|opengraph-image$|_next(?:/|$)|robots\\.txt$|sitemap\\.xml$|(?:.*/)?(?!feed\\.xml$)[^/]*\\.[A-Za-z0-9]+$).*)',
  ],
}
