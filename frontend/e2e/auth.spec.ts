import type { BrowserContext, Locator, Page, Request } from '@playwright/test'
import { ADMIN_EMAIL, MOCK_GITHUB_URL } from './support/env'
import { expect, test } from './support/fixtures'
import {
  GITHUB_CALLBACK_PATH,
  accountButton,
  beginGitHubSignIn,
  clickThrough,
  headerLoginLink,
  loginWithGitHub,
  mockUser,
  newVisitorContext,
  sessionOf,
  setMockUser,
} from './support/github'
import { randomClientAddress } from './support/network'
import { escapeRegExp, submitSecondStep } from './support/admin'
import { E2E_LOCALE, HOME_URL, LOCALE_PREFIX, localePath, msg, rawMsg, type E2ELocale } from './support/i18n'
import { ACCESS_COOKIE, REFRESH_COOKIE, SESSION_COOKIES } from './support/session-cookies'

/**
 * Reader sign-in with GitHub, going through the whole real flow:
 * the site link → the Next start route → the QA backend (Spring `oauth2Login`) → the fake GitHub on
 * 127.0.0.1 → the Next callback. No session cookie is set by hand.
 *
 * Each project has its own reader (`alice-desktop`, `alice-mobile`); five special users
 * (`bigid`, `noemail`, `adminmail`, `bidi`, `owner`) are shared, and the two projects run one after the other
 * (one worker), so nobody steps on anybody.
 */

/** The session cookies (lib/auth-cookies.ts) and the cookie of a half-finished sign-in (production: `__Host-`). */
const FLOW_COOKIE = '__Host-oauth_flow'

type LoginError = 'denied' | 'state' | 'unavailable'

/**
 * The text of the /login page for an error code (app/[locale]/(site)/login/page.tsx), in the locale of the page the redirect
 * lands on: the locale of the return target (lib/return-to.ts, loginErrorPath), the default locale when there is none.
 */
function loginMessage(error: LoginError, locale: E2ELocale = E2E_LOCALE): string {
  return msg(`Site.login.errors.${error}`, undefined, locale)
}

/** The names of the session cookies still on the site; never returns values (the run log is scanned for tokens). */
async function sessionCookieNames(context: BrowserContext): Promise<string[]> {
  return (await context.cookies())
    .filter((cookie) => SESSION_COOKIES.includes(cookie.name) || cookie.name === FLOW_COOKIE)
    .map((cookie) => cookie.name)
    .sort()
}

/** Open the account panel in the header; returns the panel itself (the element the button `aria-controls`). */
async function openAccountPanel(page: Page, displayName: string): Promise<Locator> {
  const button = accountButton(page, displayName)
  await button.click()
  await expect(button).toHaveAttribute('aria-expanded', 'true')
  // The id from useId may contain characters that are invalid in a `#…` selector: select by attribute.
  const panel = page.locator(`[id="${await button.getAttribute('aria-controls')}"]`)
  await expect(panel).toBeVisible()
  return panel
}

/** The error notice of the /login page, inside the site's `<main>`. */
function loginAlert(page: Page): Locator {
  return page.getByRole('main').getByRole('alert')
}

/** `/login?error=<code>&returnTo=<target>` exactly as the route builds it (URLSearchParams also encodes `/`). */
/** Where a failed sign-in lands: the /login page of the locale of `returnTo` (a path built with localePath), else the default one. */
function loginErrorUrl(error: LoginError, returnTo?: string): string {
  const params = new URLSearchParams({ error })
  if (returnTo !== undefined) params.set('returnTo', returnTo)
  return `${returnTo === undefined ? '' : LOCALE_PREFIX}/login?${params}`
}

function pathAndQuery(url: URL): string {
  return `${url.pathname}${url.search}${url.hash}`
}

/**
 * The avatar as the page loads it: exactly that person's GitHub image, requested at the fixed 128 px size that
 * components/site/Avatar.tsx uses everywhere. The fake server's URL always carries `?v=4`
 * (avatarUrlFor in e2e/mock-github/users.mjs), and `v` stays as it is, so `s` comes after it.
 */
function avatarAt128(avatarUrl: string): string {
  return `${avatarUrl}&s=128`
}

/** The value of a cookie in the `Cookie` header of a request that was sent. */
function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

test.describe('GitHub sign-in', () => {
  test('signing in from a post returns to that very post; the header has the avatar and the name; signing out revokes the refresh token', async ({
    page,
    context,
    backend,
    reader,
    isMobile,
  }) => {
    const login = reader('alice')
    const user = mockUser(login)
    const post = await backend.prerenderedPost()

    await page.goto(localePath(`/posts/${post.slug}`))
    await expect(headerLoginLink(page)).toHaveAttribute(
      'href',
      `/api/auth/github/start?returnTo=${encodeURIComponent(localePath(`/posts/${post.slug}`))}`,
    )
    // Back to the right post, cookies HttpOnly + Secure + Lax, the flow cookie cleared, no token in JS.
    const tokens = await loginWithGitHub(page, login)

    const account = accountButton(page, user.displayName!)
    await expect(account).toBeVisible()
    await expect(headerLoginLink(page)).toHaveCount(0)
    // The real GitHub avatar (in E2E a fake image at the same address), loadable.
    const avatar = account.locator('img')
    await expect(avatar).toHaveAttribute('src', avatarAt128(user.avatarUrl))
    await expect
      .poll(() => avatar.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0), {
        message: 'the avatar has not finished loading',
      })
      .toBe(true)
    // The name shows beside the avatar from sm (640px); below that only the avatar remains, the name stays in the accessible name and in the panel.
    const name = account.locator('bdi')
    if (isMobile) await expect(name).toBeHidden()
    else await expect(name).toHaveText(user.displayName!)

    const panel = await openAccountPanel(page, user.displayName!)
    await expect(panel).toContainText(user.displayName!)
    await expect(panel).toContainText(`@${login}`)
    await expect(panel.getByRole('link', { name: msg('Site.account.profile') })).toHaveAttribute('href', localePath('/profile'))
    await expect(panel.getByRole('link', { name: msg('Site.account.admin') })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(panel).toBeHidden()
    await expect(account).toBeFocused()

    // What the browser keeps for the person (a recent search, a comment draft kept across a session expiry) leaves with them.
    await page.evaluate(() => {
      window.localStorage.setItem('search.recent.v1', JSON.stringify(['a private topic']))
      window.sessionStorage.setItem('binh-luan:nhap:some-post', JSON.stringify({ owner: 'gh:someone', text: 'half a comment' }))
    })

    // Sign out from the panel: back to the guest UI in place, announced to screen readers, focus returns to the sign-in button.
    await openAccountPanel(page, user.displayName!)
    await page
      .getByRole('banner')
      .getByRole('button', { name: msg('Site.account.signOut') })
      .click()
    await expect(headerLoginLink(page)).toBeFocused()
    await expect(
      page
        .getByRole('banner')
        .getByRole('status')
        .filter({ hasText: msg('Site.account.signedOut') }),
    ).toHaveCount(1)
    await expect(page).toHaveURL(new RegExp(`/posts/${post.slug}$`))
    expect(await sessionCookieNames(context), 'session cookies after signing out').toEqual([])
    expect(await sessionOf(page)).toBeNull()
    expect(
      await page.evaluate(() => [
        window.localStorage.getItem('search.recent.v1'),
        window.sessionStorage.getItem('binh-luan:nhap:some-post'),
      ]),
      'browser storage after signing out',
    ).toEqual([null, null])

    // The old refresh token has been revoked in the backend, not just removed from the browser.
    const refresh = await backend.refresh(tokens.refreshToken)
    expect(refresh.status(), 'old refresh token after signing out').toBe(401)
    expect(((await refresh.json()) as { error: { code: string } }).error.code).toBe('REFRESH_TOKEN_REVOKED')
  })

  test('signing in from the header at /search?q=…: returns to that exact results page, keeping the query', async ({
    page,
    reader,
  }) => {
    const target = localePath(`/search?q=${encodeURIComponent('spring boot')}&page=1`)
    await page.goto(target)
    // The server HTML only knows the path; the link takes the query from `location` right before the click.
    await expect(headerLoginLink(page)).toBeVisible()

    // loginWithGitHub clicks the header's own link and checks that the returned page matches `returnTo` character for character.
    await loginWithGitHub(page, reader('alice'), { returnTo: target })
    expect(new URL(page.url()).searchParams.get('q')).toBe('spring boot')
  })

  test('/profile: a guest is invited to sign in; a reader sees the GitHub profile, signing out goes to the home page', async ({
    page,
    context,
    backend,
    reader,
  }) => {
    const login = reader('alice')
    const user = mockUser(login)
    const main = page.getByRole('main')

    await page.goto(localePath('/profile'))
    await expect(main.getByRole('heading', { level: 1, name: msg('Site.account.profile') })).toBeVisible()
    await expect(main.getByText(msg('Site.profileCard.anonymous'))).toBeVisible()
    const invite = main.getByRole('link', { name: msg('Site.account.signInWithGithub') })
    await expect(invite).toHaveAttribute('href', `/api/auth/github/start?returnTo=${encodeURIComponent(localePath('/profile'))}`)
    await expect(invite).toHaveAttribute('rel', 'nofollow')

    const tokens = await loginWithGitHub(page, login, { via: invite, returnTo: localePath('/profile') })
    const session = await sessionOf(page)
    expect(session).toMatchObject({ displayName: user.displayName, githubLogin: login, role: 'USER', canAccessAdmin: false })

    await expect(main.getByRole('heading', { level: 2, name: user.displayName! })).toBeVisible()
    const github = main.getByRole('link', { name: `@${login}` })
    await expect(github).toHaveAttribute('href', `https://github.com/${login}`)
    await expect(github).toHaveAttribute('rel', 'noopener noreferrer')
    await expect(main.locator('img')).toHaveAttribute('src', avatarAt128(user.avatarUrl))
    const joined = main.locator('time')
    await expect(joined).toHaveAttribute('datetime', session!.joinedAt)
    await expect(
      main.getByText(new RegExp(`^${escapeRegExp(rawMsg('Site.profileCard.joined').split('<time>')[0])}`)),
    ).toBeVisible()
    await expect(main.getByText(msg('Site.profileCard.anonymous'))).toHaveCount(0)

    await main.getByRole('button', { name: msg('Site.account.signOut') }).click()
    await expect(page).toHaveURL(HOME_URL)
    await expect(headerLoginLink(page)).toBeVisible()
    expect(await sessionCookieNames(context)).toEqual([])
    expect((await backend.refresh(tokens.refreshToken)).status(), 'old refresh token after signing out').toBe(401)
  })

  test('"Deny" on GitHub: returns to /login?error=denied, nothing saved, the retry link keeps the return target', async ({
    page,
    context,
    backend,
  }) => {
    const post = await backend.prerenderedPost()
    const returnTo = localePath(`/posts/${post.slug}`)
    await page.goto(returnTo)
    // No `mock_user` cookie: the fake GitHub shows the account chooser, as GitHub asks the user.
    await setMockUser(context, null)
    const chooser = await clickThrough(page, headerLoginLink(page))
    expect(chooser.origin, 'authorization page of the fake GitHub').toBe(MOCK_GITHUB_URL)
    await expect(page.getByRole('heading', { level: 1, name: 'Authorize the application' })).toBeVisible()

    const landed = await clickThrough(page, page.getByRole('button', { name: 'Deny' }))
    expect(pathAndQuery(landed)).toBe(loginErrorUrl('denied', returnTo))
    await expect(loginAlert(page)).toHaveText(loginMessage('denied'))
    await expect(page.getByRole('main').getByRole('link', { name: msg('Site.login.continueWithGithub') })).toHaveAttribute(
      'href',
      `/api/auth/github/start?returnTo=${encodeURIComponent(returnTo)}`,
    )
    expect(await sessionCookieNames(context), 'no session cookie, flow cookie cleared').toEqual([])
    expect(await sessionOf(page)).toBeNull()
  })

  test("a callback carrying someone else's state (login CSRF): returns to /login?error=state, the victim is not signed in", async ({
    page,
    context,
    playwright,
    backend,
    reader,
  }, testInfo) => {
    // The attacker walks THEIR OWN flow with an HTTP client, stopping right before the callback: the (fake) GitHub
    // has agreed and returned the callback URL with their code and state, a code nobody has used.
    const attacker = await playwright.request.newContext({
      baseURL: testInfo.project.use.baseURL,
      extraHTTPHeaders: { 'x-forwarded-for': randomClientAddress() },
    })
    let forged: string
    try {
      const start = await attacker.get('/api/auth/github/start?returnTo=%2F', { maxRedirects: 0 })
      expect(start.status(), 'start by the attacker').toBe(303)
      const consent = await attacker.get(start.headers()['location']!, {
        maxRedirects: 0,
        headers: { cookie: `mock_user=${reader('mallory')}` },
      })
      expect(consent.status(), 'the fake GitHub approves').toBe(302)
      forged = consent.headers()['location']!
    } finally {
      await attacker.dispose()
    }
    const forgedUrl = new URL(forged)
    expect(forgedUrl.pathname).toBe(GITHUB_CALLBACK_PATH)
    expect(forgedUrl.searchParams.get('code')).toBeTruthy()
    expect(forgedUrl.searchParams.get('state')).toBeTruthy()

    // The victim is in the middle of their own sign-in (the flow cookie carries their own state) and opens that link.
    const post = await backend.prerenderedPost()
    const returnTo = localePath(`/posts/${post.slug}`)
    await page.goto(returnTo)
    await setMockUser(context, null)
    await clickThrough(page, headerLoginLink(page))
    expect(
      (await context.cookies()).some((cookie) => cookie.name === FLOW_COOKIE),
      'flow cookie of the victim',
    ).toBe(true)

    await page.goto(forged)
    expect(pathAndQuery(new URL(page.url()))).toBe(loginErrorUrl('state', returnTo))
    await expect(loginAlert(page)).toHaveText(loginMessage('state'))
    expect(await sessionCookieNames(context)).toEqual([])
    expect(await sessionOf(page)).toBeNull()
  })

  test('replaying the callback URL: while signed in goes to the home page with no error; another browser gets error=state; still one account', async ({
    page,
    context,
    browser,
    playwright,
    backend,
    reader,
  }, testInfo) => {
    const login = reader('alice')
    const post = await backend.prerenderedPost()
    const returnTo = localePath(`/posts/${post.slug}`)
    await page.goto(returnTo)

    // Record the callback request (the URL carries code + state, the Cookie header carries the flow cookie). A redirect
    // hop does not go through `route()`, but it still fires the `request` event.
    let callbackRequest: Request | undefined
    const onRequest = (request: Request) => {
      if (new URL(request.url()).pathname === GITHUB_CALLBACK_PATH) callbackRequest = request
    }
    context.on('request', onRequest)
    const tokens = await loginWithGitHub(page, login)
    context.off('request', onRequest)
    expect(callbackRequest, 'request callback').toBeDefined()
    const callback = callbackRequest!.url()
    const flow = cookieValue((await callbackRequest!.allHeaders())['cookie'], FLOW_COOKIE)
    expect(flow, 'flow cookie sent with the callback').toBeTruthy()

    // 1. Back to the callback after signing in: no backend call, goes to the home page, no message.
    await page.goto(callback)
    expect(pathAndQuery(new URL(page.url()))).toBe('/')
    await expect(loginAlert(page)).toHaveCount(0)
    expect((await sessionOf(page))?.githubLogin).toBe(login)
    const refresh = (await context.cookies()).find((cookie) => cookie.name === REFRESH_COOKIE)
    expect(refresh?.value === tokens.refreshToken, 'the session keeps its refresh token').toBe(true)

    // 2. Another browser, no cookies: error=state, no session.
    const other = await newVisitorContext(browser, testInfo)
    try {
      const otherPage = await other.newPage()
      await otherPage.goto(callback)
      expect(pathAndQuery(new URL(otherPage.url())), 'replay in another browser').toBe(loginErrorUrl('state'))
      // No flow cookie, so no return target: the default locale's sign-in page.
      await expect(loginAlert(otherPage)).toHaveText(loginMessage('state', 'vi'))
      expect(await sessionCookieNames(other)).toEqual([])
    } finally {
      await other.close()
    }

    // 3. Someone with BOTH the URL and the original flow cookie, sent by hand like curl (Chrome does not allow installing a `__Host-` cookie
    // via addCookies): the blob still has a valid signature and is unexpired, but the state has been consumed (ConsumedStateRegistry)
    // and the code has been used. Still error=state, no session cookie is set.
    const thief = await playwright.request.newContext({
      baseURL: testInfo.project.use.baseURL,
      extraHTTPHeaders: { 'x-forwarded-for': randomClientAddress() },
    })
    try {
      const replay = await thief.get(callback, { maxRedirects: 0, headers: { cookie: `${FLOW_COOKIE}=${flow}` } })
      expect(replay.status(), 'replay with the original flow cookie').toBe(303)
      expect(replay.headers()['location']).toBe(loginErrorUrl('state', returnTo))
      const set = replay
        .headersArray()
        .filter((header) => header.name.toLowerCase() === 'set-cookie')
        .map((header) => header.value.slice(0, header.value.indexOf('=')))
      expect(set, 'cookies set on replay').toEqual([FLOW_COOKIE])
    } finally {
      await thief.dispose()
    }

    // No second account is created by the replays.
    const rows = await (await backend.asAdmin()).adminUsers({ q: login })
    expect(rows.map((row) => row.githubLogin)).toEqual([login])
  })

  test('a malicious returnTo (/..//evil.com and relatives): after signing in still stays on the site, goes to the home page', async ({
    page,
    context,
    reader,
  }) => {
    const login = reader('alice')
    const vectors = ['/..//evil.com', '//evil.com', '/\\evil.com', 'https://evil.com/', '/%2e%2e//evil.com', '/%2F%2Fevil.com']
    const offsite: string[] = []
    await context.route(
      (url) => /(^|\.)evil\.com$/i.test(url.hostname),
      async (route) => {
        offsite.push(route.request().url())
        await route.abort()
      },
    )

    await page.goto(localePath('/'))
    const site = new URL(page.url()).origin
    await setMockUser(context, login)
    for (const vector of vectors) {
      await page.goto(`/api/auth/github/start?returnTo=${encodeURIComponent(vector)}`)
      const landed = new URL(page.url())
      expect(landed.origin, `returnTo=${vector}`).toBe(site)
      expect(pathAndQuery(landed), `returnTo=${vector}`).toBe('/')
    }
    expect((await sessionOf(page))?.githubLogin, 'the sign-ins still succeed').toBe(login)
    expect(offsite, 'requests to evil.com').toEqual([])
  })

  test('GitHub returns 500 at the token-exchange hop: goes to /login?error=unavailable; retrying gets in and returns to the right post', async ({
    page,
    context,
    backend,
    mockGithub,
    reader,
  }) => {
    const login = reader('alice')
    const post = await backend.prerenderedPost()
    const returnTo = localePath(`/posts/${post.slug}`)
    await mockGithub.fail('token', 500)

    await page.goto(returnTo)
    await setMockUser(context, login)
    const landed = await clickThrough(page, headerLoginLink(page))
    expect(pathAndQuery(landed)).toBe(loginErrorUrl('unavailable', returnTo))
    await expect(loginAlert(page)).toHaveText(loginMessage('unavailable'))
    expect(await sessionCookieNames(context)).toEqual([])

    // The error is installed for one call only: the error page's "Continue with GitHub" carries the old return target.
    await loginWithGitHub(page, login, {
      via: page.getByRole('main').getByRole('link', { name: msg('Site.login.continueWithGithub') }),
      returnTo,
    })
  })

  test('changing the login on GitHub is still the same blog account', async ({ backend, mockGithub, userContext }, testInfo) => {
    const original = mockUser('noemail')
    const renamed = `noemail-renamed-${testInfo.project.name}`
    const renamedName = `Renamed Person (${testInfo.project.name})`
    const admin = await backend.asAdmin()
    try {
      const first = await userContext(original.login)
      const before = await backend.asUser(first.tokens.accessToken).me()
      expect(before).toMatchObject({ githubLogin: original.login, displayName: original.displayName, role: 'USER', email: null })

      // Same GitHub id, new login and name: sign in with the NEW login.
      await mockGithub.updateUser(original.id, { login: renamed, name: renamedName })
      const second = await userContext(renamed)
      const after = await backend.asUser(second.tokens.accessToken).me()
      expect(after.id, 'the same users row').toBe(before.id)
      expect(after).toMatchObject({ githubLogin: renamed, displayName: renamedName, createdAt: before.createdAt })
      await expect(accountButton(second.page, renamedName)).toBeVisible()

      expect((await admin.adminUsers({ q: renamed })).map((row) => row.id)).toEqual([before.id])
      // The new login still contains "noemail": searching by the old login also finds exactly that one row, no second row.
      expect((await admin.adminUsers({ q: original.login })).map((row) => row.id)).toEqual([before.id])
    } finally {
      // Restore the users row to the original login and name for the next run (and the next project).
      await mockGithub.reset()
      const restored = await userContext(original.login)
      expect((await backend.asUser(restored.tokens.accessToken).me()).githubLogin).toBe(original.login)
    }
  })

  test('an email equal to the admin email is still a separate reader: no "Admin", /admin rejects', async ({ page, backend }) => {
    const user = mockUser('adminmail')
    await page.goto(localePath('/'))
    const tokens = await loginWithGitHub(page, user.login)

    const me = await backend.asUser(tokens.accessToken).me()
    const adminMe = await (await backend.asAdmin()).me()
    // The blog does not read or store the GitHub email, and never links accounts by email.
    expect(me).toMatchObject({ role: 'USER', email: null, githubLogin: user.login, displayName: user.displayName })
    expect(me.id).not.toBe(adminMe.id)
    expect(adminMe).toMatchObject({ role: 'ADMIN', email: ADMIN_EMAIL })
    expect(await sessionOf(page)).toMatchObject({ role: 'USER', canAccessAdmin: false })

    const panel = await openAccountPanel(page, user.displayName!)
    await expect(panel.getByRole('link', { name: msg('Site.account.profile') })).toBeVisible()
    await expect(panel.getByRole('link', { name: msg('Site.account.admin') })).toHaveCount(0)
    await page.goto('/admin')
    await expect(page).toHaveURL(/\/admin\/login\?reason=forbidden$/)
  })

  test('the site owner (ADMIN_GITHUB_ID) signing in with GitHub is the admin account: GitHub alone opens nothing, the code does', async ({
    page,
    context,
    backend,
  }) => {
    const user = mockUser('owner')
    await page.goto(localePath('/'))
    // GitHub is a second way to become the administrator, so it goes through the same gate as the password: the callback hands out a
    // challenge, not a session, and the browser lands on the code page of the admin area (not on the reader's /login).
    const { landed } = await beginGitHubSignIn(page, user.login)
    expect(landed.pathname).toBe('/admin/login/mfa')
    expect(await sessionCookieNames(context), 'no session before the second step').toEqual([])
    expect(await sessionOf(page)).toBeNull()
    await page.goto('/admin')
    await expect(page, 'the challenge is not a session').toHaveURL(/\/admin\/login$/)

    // The same challenge is still good (five minutes): the code finishes the sign-in.
    await page.goto('/admin/login/mfa')
    await expect(page.getByRole('heading', { level: 1, name: msg('Admin.login.mfa.title') })).toBeVisible()
    await submitSecondStep(page, 'totp')
    await expect(page).toHaveURL(/\/admin$/)
    await expect(page.getByRole('heading', { level: 1, name: msg('Site.about.readNextLinks.writing') })).toBeVisible()

    const accessToken = (await context.cookies()).find((cookie) => cookie.name === ACCESS_COOKIE)?.value
    expect(accessToken, 'the session exists after the second step').toBeTruthy()
    const me = await backend.asUser(accessToken!).me()
    const adminMe = await (await backend.asAdmin()).me()
    expect(me.id, 'the blog owner GitHub hits the admin row').toBe(adminMe.id)
    expect(me).toMatchObject({ role: 'ADMIN', email: ADMIN_EMAIL })
    // A CMS-managed name stays as it is, not overwritten by the GitHub name.
    expect(me.displayName).toBe(adminMe.displayName)
    expect(me.displayName).not.toBe(user.name)
    expect(await sessionOf(page)).toMatchObject({ role: 'ADMIN', canAccessAdmin: true })

    await page.goto(localePath('/'))
    const panel = await openAccountPanel(page, me.displayName)
    const admin = panel.getByRole('link', { name: msg('Site.account.admin') })
    await expect(admin).toHaveAttribute('href', '/admin')
    await admin.click()
    await expect(page).toHaveURL(/\/admin$/)
    await expect(page.getByRole('heading', { level: 1, name: msg('Site.about.readNextLinks.writing') })).toBeVisible()
  })

  test('a GitHub id above 2^31 can still sign in', async ({ page, backend }) => {
    const user = mockUser('bigid')
    expect(user.id).toBeGreaterThan(2 ** 31)
    await page.goto(localePath('/'))
    const tokens = await loginWithGitHub(page, user.login)
    expect(await backend.asUser(tokens.accessToken).me()).toMatchObject({
      githubLogin: user.login,
      displayName: user.displayName,
      role: 'USER',
      email: null,
    })
    await expect(accountButton(page, user.displayName!)).toBeVisible()
  })
})
