import {
  expect,
  type APIRequestContext,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test'
import type { SessionUser } from '../../lib/types'
import {
  MOCK_EMAIL_DOMAIN,
  OWNER_GITHUB_ID,
  findUserByLogin,
  readerLogin,
  type MockUser,
  type ReaderName,
} from '../mock-github/users.mjs'
import { MOCK_GITHUB_PORT, MOCK_GITHUB_URL } from './env'
import { hasOwnClientAddress, ownClientAddress, prepareContext } from './network'
import { localePath, msg } from './i18n'
import { ACCESS_COOKIE, REFRESH_COOKIE } from './session-cookies'

/**
 * Reader sign-in through the fake GitHub in E2E.
 *
 * Follows the real flow from start to end: the "Sign in with GitHub" link → the Next start route →
 * the QA backend (Spring `oauth2Login`) → the fake GitHub on 127.0.0.1 (e2e/mock-github/server.mjs) →
 * the Next callback → the page being read. No session cookie is set by hand: going through the very path readers
 * take checks that path too, like loginAsAdmin (admin.ts) with the password form.
 *
 * The fake users are in e2e/mock-github/users.mjs. Each project has its own reader (`alice-desktop`,
 * `alice-mobile`): the two projects run one after the other on the same backend, so likes, rate limits
 * and the suspended state of this project must not leak into the other.
 */

export { MOCK_EMAIL_DOMAIN, OWNER_GITHUB_ID, readerLogin }
export type { MockUser, ReaderName }

/** The site callback that the (fake) GitHub calls back: app/api/auth/github/callback/route.ts. */
export const GITHUB_CALLBACK_PATH = '/api/auth/github/callback'

/** The cookie of a half-finished sign-in (lib/oauth-flow-cookie.ts): `__Host-` in production, like the QA stack. */
const FLOW_COOKIES = ['__Host-oauth_flow', 'oauth_flow']
/** The fake GitHub's cookie: with it the fake agrees by itself for that login, with no account chooser page. */
const MOCK_USER_COOKIE = 'mock_user'
/** Any JWT: the base64url header part of `{"alg"…` always starts with `eyJ`. */
const JWT = /eyJ[\w-]+\.[\w-]+\.[\w-]+/

/** The two session cookies the callback sets: used with `backend.asUser(accessToken)` and `backend.refresh(…)`. */
export type SessionTokens = { accessToken: string; refreshToken: string }

/** The fake user with this login in the original list; a typo in a spec throws at once. */
export function mockUser(login: string): MockUser {
  const user = findUserByLogin(login)
  if (!user) throw new Error(`The fake GitHub has no user "${login}" (e2e/mock-github/users.mjs)`)
  return user
}

// --- Controlling the fake -------------------------------------------------------------------------

/** The fake's `GET /__e2e/health`. */
export type MockGithubHealth = { status: string; clientId: string; callback: string }

/** The part of the `GET /user` profile that tests read (the fake returns the new profile after `updateUser`). */
export type GithubUserJson = {
  id: number
  login: string
  name: string | null
  email: string | null
  avatar_url: string
}

/** The changeable fields of a fake user; the id never changes. */
export type MockUserPatch = { login?: string; name?: string | null; email?: string | null; avatarUrl?: string }

/**
 * A failure installed for a hop: an HTTP 4xx/5xx status; `hang` holds the connection without answering (the backend gives
 * up after a 10 second read); `bad_code` is HTTP 200 with `bad_verification_code`, only for the token hop.
 */
export type MockFailure = number | 'hang' | 'bad_code'

/**
 * Control the fake GitHub from tests (the `/__e2e/*` paths of server.mjs). Used through the `mockGithub` fixture
 * (fixtures.ts): the fake is reset after each test that uses it, so an installed failure or a changed name does not leak
 * sang test sau.
 */
export class MockGithub {
  constructor(private readonly http: APIRequestContext) {}

  private async send(method: 'GET' | 'POST' | 'PATCH', path: string, data?: unknown): Promise<APIResponse> {
    const response = await this.http.fetch(path, { method, ...(data === undefined ? {} : { data }) })
    if (!response.ok()) {
      throw new Error(`Fake GitHub, ${method} ${path}: HTTP ${response.status()} ${(await response.text()).slice(0, 300)}`)
    }
    return response
  }

  async health(): Promise<MockGithubHealth> {
    return (await (await this.send('GET', '/__e2e/health')).json()) as MockGithubHealth
  }

  /**
   * Whether the running fake accepts exactly this callback. `reuseExistingServer` also reuses a whole old fake
   * started with a different E2E_BASE_URL, and then every authorize ends in `redirect_uri_mismatch`.
   */
  async expectCallback(callback: string): Promise<void> {
    let health: MockGithubHealth
    try {
      health = await this.health()
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`The fake GitHub does not answer at ${MOCK_GITHUB_URL} (webServer of playwright.config.ts): ${reason}`)
    }
    if (health.callback !== callback) {
      throw new Error(
        `The fake GitHub on port ${MOCK_GITHUB_PORT} has callback ${health.callback}, this project needs ${callback}. ` +
          'Is an old fake still holding the port? Stop it, or rerun with a matching E2E_BASE_URL.',
      )
    }
  }

  /** Back to the original user list; drops every code, token and installed failure. */
  async reset(): Promise<void> {
    await this.send('POST', '/__e2e/reset')
  }

  /** The next `times` calls of hop `endpoint` fail according to `failure`, then the hop runs normally again. */
  async fail(endpoint: 'token' | 'user', failure: MockFailure, times = 1): Promise<void> {
    const query = new URLSearchParams({ endpoint, status: String(failure), times: String(times) })
    await this.send('POST', `/__e2e/fail?${query}`)
  }

  /**
   * Change a fake user's profile, keeping the id: changing the login on GitHub is still the same blog
   * account. After changing the login, sign in with the NEW login (the `mock_user` cookie chooses by login).
   */
  async updateUser(id: number, patch: MockUserPatch): Promise<GithubUserJson> {
    return (await (await this.send('PATCH', `/__e2e/users/${id}`, patch)).json()) as GithubUserJson
  }
}

// --- Sign-in ---------------------------------------------------------------------------------------

/**
 * The fake GitHub's `mock_user` cookie, on host 127.0.0.1 (cookies ignore the port). With it the fake agrees by itself
 * for that login, like GitHub with an already authorized app; null clears it, and the next authorize
 * shows the account chooser page ("Continue with <login>", "Deny").
 */
export async function setMockUser(context: BrowserContext, login: string | null): Promise<void> {
  await context.clearCookies({ name: MOCK_USER_COOKIE })
  if (login === null) return
  await context.addCookies([{ name: MOCK_USER_COOKIE, value: encodeURIComponent(login), url: MOCK_GITHUB_URL, sameSite: 'Lax' }])
}

/**
 * Click `link` then wait for the FIRST document loaded after the click, and return its URL. Every middle hop of
 * the sign-in (start, the fake GitHub, callback) is a redirect, so that is the final destination: the page returned to,
 * /login?error=…, or the fake's account chooser page. Do not use waitForURL: the destination often equals
 * the page already open, and waitForURL returns at once when the URL already matches.
 */
export async function clickThrough(page: Page, link: Locator): Promise<URL> {
  await page.waitForLoadState('load')
  const loaded = page.waitForEvent('load', { timeout: 30_000 })
  // Someone is waiting below; this line only keeps a failed click from leaving a rejected promise that
  // nobody catches.
  loaded.catch(() => {})
  await link.click()
  await loaded
  return new URL(page.url())
}

export type GitHubLoginOptions = {
  /** The sign-in start link; by default the header's "Sign in with GitHub" link. */
  via?: Locator
  /**
   * The page to return to: a path inside the site, possibly with a query and `#`. The default is the path currently open,
   * exactly what the header link sends. The comment invitation returns to `…#binh-luan`; from /login it goes to `/`.
   */
  returnTo?: string
}

/**
 * The first half of a GitHub sign-in: from the page currently open, through the page's real link, to the fake GitHub, back to the
 * site's callback, and the first document after it. Returns where the browser landed. A person who needs a second step (an
 * administrator, an author who turned two-step verification on) lands on /admin/login/mfa or /admin/login/enroll with no session yet;
 * everybody else lands on the page they came from, signed in. Fails with a clear message when the fake GitHub or the site's
 * login page reports an error instead.
 */
export async function beginGitHubSignIn(
  page: Page,
  login: string,
  options: GitHubLoginOptions = {},
): Promise<{ start: URL; landed: URL }> {
  const start = new URL(page.url())
  if (start.protocol !== 'http:' && start.protocol !== 'https:') {
    throw new Error('loginWithGitHub: open a page of the site first (page.goto), then sign in')
  }
  const context = page.context()
  // A hand-made context (browser.newContext) has not gone through prepareContext: it still needs its own OAuth quota.
  if (!hasOwnClientAddress(context)) await ownClientAddress(context)
  await setMockUser(context, login)

  const landed = await clickThrough(page, options.via ?? headerLoginLink(page))
  if (landed.origin === MOCK_GITHUB_URL) {
    throw new Error(
      `The fake GitHub shows the account chooser instead of approving "${login}" on its own: this login is not in ` +
        'e2e/mock-github/users.mjs, or that person was renamed (mockGithub.updateUser).',
    )
  }
  if (landed.origin === start.origin && landed.pathname === '/login' && landed.searchParams.has('error')) {
    throw new Error(
      `GitHub sign-in of "${login}" failed: ${landed.pathname}${landed.search}. Does the QA backend point its provider ` +
        `at ${MOCK_GITHUB_URL} with the same client id, secret and SITE_URL as the fake?`,
    )
  }
  return { start, landed }
}

/**
 * Sign in to the fake GitHub as `login` from the page currently open, through the page's real link, then check what the
 * design promises about the new session:
 * - back to the right page (returnTo), not /login?error=…;
 * - `/api/session` is that person's;
 * - `__Host-access_token` and `__Host-refresh_token` on the site host: HttpOnly, Secure, SameSite=Lax, Path=/;
 * - the `oauth_flow` cookie of the sign-in has been cleared;
 * - no token leaks into the page's JavaScript: localStorage, sessionStorage, document.cookie.
 *
 * The page must be on a page of the site and not yet signed in (the header still has the sign-in link). Returns the two tokens
 * so a test can call the backend as that person (`backend.asUser(tokens.accessToken)`). Never prints a token,
 * even in an error message: the log of a run is scanned for them.
 */
export async function loginWithGitHub(page: Page, login: string, options: GitHubLoginOptions = {}): Promise<SessionTokens> {
  const { start, landed } = await beginGitHubSignIn(page, login, options)
  const context = page.context()
  const expected = new URL(options.returnTo ?? start.pathname, start.origin)
  expect(landed.href, `"${login}" must land on the right page after signing in`).toBe(expected.href)

  // The session is that exact person's: the fake picks the person by cookie, the backend finds the account by GitHub id.
  const user = await sessionOf(page)
  expect(user?.githubLogin?.toLowerCase(), 'the new session must belong to the right fake user').toBe(login.toLowerCase())

  const cookies = await context.cookies(landed.origin)
  const tokenCookie = (name: string): string => {
    const cookie = cookies.find((candidate) => candidate.name === name)
    expect(cookie, `cookie ${name} after sign-in`).toBeDefined()
    const { domain, path, httpOnly, secure, sameSite } = cookie!
    expect({ domain, path, httpOnly, secure, sameSite }, `attributes of cookie ${name}`).toEqual({
      domain: landed.hostname,
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    })
    return cookie!.value
  }
  const tokens = { accessToken: tokenCookie(ACCESS_COOKIE), refreshToken: tokenCookie(REFRESH_COOKIE) }

  const flow = (await context.cookies()).filter((cookie) => FLOW_COOKIES.includes(cookie.name)).map((cookie) => cookie.name)
  expect(flow, 'the cookie of the unfinished sign-in must be cleared at the callback').toEqual([])

  const exposed = await page.evaluate(() => {
    const texts = [document.cookie]
    for (const storage of [window.localStorage, window.sessionStorage]) {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index) ?? ''
        texts.push(key, storage.getItem(key) ?? '')
      }
    }
    return texts.join('\n')
  })
  // Compare as a boolean: a failure must not print the token itself into the report.
  const leaked = exposed.includes(tokens.accessToken) || exposed.includes(tokens.refreshToken) || JWT.test(exposed)
  expect(leaked, 'token leaked to page JavaScript (localStorage, sessionStorage or document.cookie)').toBe(false)
  return tokens
}

/** A person signed in inside their own context. */
export type UserSession = { context: BrowserContext; page: Page; tokens: SessionTokens }

/**
 * `/api/session` as this page's browser sees it (the same cookie jar as the page): null is a guest. Cookies
 * that the route sets or clears (refresh, a dead session) also go back into the context's jar. The page must have a
 * page of the site open: the route's address is taken from its origin.
 */
export async function sessionOf(page: Page): Promise<SessionUser | null> {
  const response = await page.request.get(new URL('/api/session', page.url()).href)
  expect(response.status(), 'GET /api/session').toBe(200)
  return ((await response.json()) as { data: SessionUser | null }).data
}

/** The header's "Sign in with GitHub" link (guest). */
export function headerLoginLink(page: Page): Locator {
  return page.getByRole('banner').getByRole('link', { name: msg('Site.account.signInWithGithub'), exact: true })
}

/** The header's account button (signed in): accessible name "Account: <display name>". */
export function accountButton(page: Page, displayName: string): Locator {
  return page
    .getByRole('banner')
    .getByRole('button', { name: msg('Site.account.accountLabel', { name: displayName }), exact: true })
}

/**
 * A new context NOT signed in: a completely different browser (no cookies), with the same viewport, language
 * and time zone as the running project (a hand-made context does not pick up the config's `use`), the same network
 * blocking as the default context (prepareContext). For a test's second person: someone replaying
 * a callback URL, an anonymous guest. The caller closes it (try/finally).
 */
export async function newVisitorContext(browser: Browser, testInfo: TestInfo): Promise<BrowserContext> {
  const { baseURL, viewport, deviceScaleFactor, isMobile, hasTouch, locale, timezoneId } = testInfo.project.use
  const context = await browser.newContext({
    baseURL,
    viewport,
    deviceScaleFactor,
    isMobile,
    hasTouch,
    locale,
    timezoneId,
  })
  try {
    await prepareContext(context)
  } catch (error) {
    await context.close()
    throw error
  }
  return context
}

/**
 * A new context for one person: a test's second person (A edits B's comment), or a reader
 * in `beforeAll`. A newVisitorContext (the project's viewport, prepareContext: view beacon,
 * real GitHub and avatar, its own client address), then sign in to the fake GitHub from `path` (without a locale: the page
 * opens in the locale of the run).
 *
 * The caller closes `context` (try/finally); the `userContext` fixture (fixtures.ts) closes itself at the end of the test.
 */
export async function newUserContext(
  browser: Browser,
  login: string,
  testInfo: TestInfo,
  { path = '/' }: { path?: string } = {},
): Promise<UserSession> {
  const context = await newVisitorContext(browser, testInfo)
  try {
    const page = await context.newPage()
    await page.goto(localePath(path))
    const tokens = await loginWithGitHub(page, login)
    return { context, page, tokens }
  } catch (error) {
    await context.close()
    throw error
  }
}
