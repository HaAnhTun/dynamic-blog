/**
 * The destination to return to after sign-in, and the path to the /login page when
 * sign-in fails.
 *
 * `safeReturnTo` is a pure function, running in four places: the `start` route, the `callback` route (the value read back
 * from the cookie, which is unsigned), the /login page and the sign-in button in the header. No server-side imports,
 * so client components can use it.
 *
 * Any doubt returns "/", never throws: the reader can still sign in, just not return to the exact
 * page. An attacker never gets a redirect to another host.
 */

import { DEFAULT_LOCALE, isLocale } from '@/i18n/config'

const MAX_LENGTH = 512

/** Never return here: the sign-in page (a loop) or an API endpoint. */
const EXCLUDED_PREFIXES = ['/api', '/login', '/admin/login']

/**
 * Percent-encodings of `.`, `/`, `\` and of `%` itself (blocking double encoding). No real path
 * on the site needs them, and decoding at some layer (proxy, browser) could turn
 * `%2e%2e/` into `../`.
 */
const ENCODED_SEPARATOR = /%(2e|2f|5c|25)/i

/** C0 control characters, DEL or `\`: the browser drops tab and newline and reads `\` as `/`. */
function hasForbiddenChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f || code === 0x5c) return true
  }
  return false
}

function startsLikeProtocolRelative(value: string): boolean {
  return value.startsWith('//') || value.startsWith('/\\')
}

/** The prefix of a non-default locale (`/en/posts/a` gives `/en`), empty for a path of the default locale. */
function localePrefix(path: string): string {
  const first = path.split(/[/?#]/, 2)[1] ?? ''
  return isLocale(first) && first !== DEFAULT_LOCALE ? `/${first}` : ''
}

/**
 * A public path without a locale (`/posts/a?x#y`, as `usePathname` from i18n/navigation and `postPath` give it) in `locale`:
 * `/en/posts/a?x#y` for a non-default locale, unchanged for the default one. `/admin` has no locale in its URLs.
 */
export function localizedPath(path: string, locale: string): string {
  if (!isLocale(locale) || locale === DEFAULT_LOCALE || !path.startsWith('/') || /^\/admin([/?#]|$)/.test(path)) return path
  return path === '/' || /^\/[?#]/.test(path) ? `/${locale}${path.slice(1)}` : `/${locale}${path}`
}

/** `/api`, `/api/…` are excluded; `/apiary` is not. `/en/login` is the sign-in page too. */
function isExcluded(pathname: string): boolean {
  const unprefixed = pathname.slice(localePrefix(pathname).length) || '/'
  return [pathname, unprefixed].some((path) =>
    EXCLUDED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)),
  )
}

/**
 * The pathname Next will really route, only for comparing against the exclusion list — it never goes into
 * Location. Next collapses consecutive `/` (308 `/admin//login` to `/admin/login`) and percent-decodes
 * before choosing the route (`/%61pi/x` reaches route `/api/x`), so comparing on the raw string lets it through.
 *
 * Decoding here is safe: `%2e`, `%2f`, `%5c` and `%25` were already rejected at step 4, so the decoded string
 * cannot produce another separator, dot segment or one more layer of encoding. Broken percent-encoding
 * (`%E0%A4%A`, a lone `%`) gives null: no browser produces it, and when in doubt go to "/".
 */
function routedPathname(pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  return decoded.replace(/\/{2,}/g, '/')
}

export function safeReturnTo(raw: string | null | undefined): string {
  // 1–3: raw shape.
  if (!raw || raw.length > MAX_LENGTH) return '/'
  if (!raw.startsWith('/') || startsLikeProtocolRelative(raw)) return '/'
  if (hasForbiddenChar(raw)) return '/'
  // 4: percent-encoding of separators.
  if (ENCODED_SEPARATOR.test(raw)) return '/'
  // 5: dot segments in the path part. The URL parser collapses `/.//evil.com` into `//evil.com`, so
  // a path with `.` or `..` is rejected before it reaches the parser.
  const path = raw.split(/[?#]/, 1)[0] ?? ''
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) return '/'

  // 6: the browser's parser must agree that this is still the same origin.
  const base = 'http://internal.invalid'
  let url: URL
  try {
    url = new URL(raw, base)
  } catch {
    return '/'
  }
  if (url.origin !== base) return '/'

  // 7: check the OUTPUT too, because the output is what goes into Location.
  const out = `${url.pathname}${url.search}${url.hash}`
  if (startsLikeProtocolRelative(out) || hasForbiddenChar(out)) return '/'
  // 8: do not return to the sign-in page or an API, compared on the pathname Next will route to.
  const routed = routedPathname(url.pathname)
  if (routed === null || isExcluded(routed)) return '/'
  return out
}

const ADMIN_HOME = '/admin'
const ADMIN_PATH = /^\/admin(?:[/?#]|$)/

/**
 * Where the admin sign-in goes after the last step (`?next=` of `/admin/login` and of its two-step pages): `safeReturnTo` first, and
 * then only a path of the admin area is kept, because nothing else is reached through an admin sign-in. Everything else, including
 * `/admin/login...` itself (a loop), gives `/admin`. A reader's public `returnTo` (a GitHub sign-in from a post) is therefore not
 * carried through the second step.
 */
export function safeAdminNext(raw: string | null | undefined): string {
  const target = safeReturnTo(raw)
  return ADMIN_PATH.test(target) ? target : ADMIN_HOME
}

/**
 * `next=<path>` for a query string. The slashes stay as they are (`next=/admin/security`): the admin language switch comes back to
 * the page through its own query string, and it refuses any encoded separator (`%2F`), so an encoded `next` would lose the step.
 * Everything else that could end the value (`?`, `&`, `#`, `%`) is encoded.
 */
function nextParam(target: string): string {
  return `next=${encodeURIComponent(target).replace(/%2F/gi, '/')}`
}

/** `/admin/login`, with `?next=` when the destination is not the admin home. */
export function adminLoginPath(next?: string | null): string {
  const target = safeAdminNext(next)
  return target === ADMIN_HOME ? '/admin/login' : `/admin/login?${nextParam(target)}`
}

/**
 * The page of the second step: `/admin/login/mfa` (type a code) or `/admin/login/enroll` (set up an authenticator). `codeRequired`
 * is the hint of the backend's challenge that the operator's enrollment code is asked first (`?code=1`); it only chooses which step
 * to draw, the backend decides.
 */
export function mfaStepPath(step: 'mfa' | 'enroll', options: { next?: string | null; codeRequired?: boolean } = {}): string {
  const parts: string[] = []
  const target = safeAdminNext(options.next)
  if (target !== ADMIN_HOME) parts.push(nextParam(target))
  if (step === 'enroll' && options.codeRequired === true) parts.push('code=1')
  return `/admin/login/${step}${parts.length === 0 ? '' : `?${parts.join('&')}`}`
}

/**
 * `/login` (with `?returnTo=` unless it is the home page), without an error: where a sign-in start that was refused sends the
 * browser (app/api/auth/github/start/route.ts). The page offers the button again.
 */
export function loginPath(returnTo?: string | null): string {
  const target = safeReturnTo(returnTo)
  const params = target === '/' ? '' : `?${new URLSearchParams({ returnTo: target })}`
  return `${localePrefix(target)}/login${params}`
}

/** The error codes the /login page can speak. The route and the page share this set. */
export const LOGIN_ERRORS = ['denied', 'state', 'unavailable', 'suspended', 'disabled', 'rate', 'failed'] as const
export type LoginError = (typeof LOGIN_ERRORS)[number]

/**
 * `/login?error=<code>&returnTo=<target>`: the relative Location of every failed sign-in. returnTo
 * is sanitized again here, and dropped entirely when it is the home page (the default of the /login page).
 * A reader who started on an English page (`/en/...`) lands on the English sign-in page.
 */
export function loginErrorPath(error: LoginError, returnTo?: string | null): string {
  const target = safeReturnTo(returnTo)
  const params = new URLSearchParams({ error })
  if (target !== '/') params.set('returnTo', target)
  return `${localePrefix(target)}/login?${params}`
}
