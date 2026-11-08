import type { Page } from '@playwright/test'
import { submitAdminPassword, submitSecondStep } from '../support/admin'
import type { UserApi } from '../support/backend'
import { ADMIN_EMAIL, ADMIN_PASSWORD, API_URL } from '../support/env'
import { expect, test } from '../support/fixtures'
import { beginGitHubSignIn, newVisitorContext } from '../support/github'
import { localePath, msg } from '../support/i18n'
import { freshAdminCode, recoveryCodesLeft } from '../support/mfa-state'
import { stepAt, totpAt } from '../support/totp'
import { ACCESS_COOKIE } from '../support/session-cookies'

/**
 * Two-step verification, through the real pages.
 *
 * The administrator of the stack is enrolled once by scripts/e2e-bootstrap.mjs and its authenticator is shared by the whole suite, so
 * these specs never replace it. What they need to change (enroll, replace, turn off) they change for people who are made for it: a reader
 * of the fake GitHub is promoted to administrator (`erin`) or to author (`frank`), goes through the pages with an authenticator that
 * only this spec knows (its key is read from the page, and the code is computed here with e2e/support/totp.ts), and is demoted
 * to reader at the end, which deletes the enrollment and the recovery codes on the server.
 */

const t = (key: string, args?: Record<string, string | number>) => msg(`Admin.${key}`, args)

/** The error of a form on the page. Next's route announcer is a `role=alert` element too, so the query stays inside `<main>`. */
function inlineAlert(page: Page) {
  return page.getByRole('main').getByRole('alert')
}

/** The key shown on the enrollment step, without the spaces of its groups of four. */
async function shownSecret(page: Page): Promise<string> {
  const group = page.getByRole('group', { name: t('login.enroll.secret') })
  return (await group.locator('code').innerText()).replace(/\s+/g, '')
}

/**
 * The enrollment steps, which the sign-in page and the Security page share: show the key, type the first code, read the ten recovery
 * codes, tick the box, press the button that leaves. Checks what the design promises on the way: the key is a 32 character base32 text
 * with an otpauth link and no image, the codes are shown once behind a checkbox, and the key is gone from the page when they appear.
 */
async function enrollThroughThePage(page: Page, leave: string): Promise<{ secret: string; codes: string[] }> {
  await page.getByRole('button', { name: t('login.enroll.start'), exact: true }).click()
  await expect(page.getByText(t('login.enroll.step2'))).toBeVisible()
  const secret = await shownSecret(page)
  expect(secret).toMatch(/^[A-Z2-7]{32}$/)
  expect(await page.getByRole('link', { name: t('login.enroll.openApp') }).getAttribute('href')).toMatch(
    new RegExp(`^otpauth://totp/[^?]+\\?secret=${secret}&issuer=`),
  )
  await expect(page.locator('main img, main canvas, main svg[role="img"]'), 'the key is text: there is no QR image').toHaveCount(
    0,
  )

  await page.getByLabel(t('login.enroll.firstCode')).fill(totpAt(secret, stepAt(Date.now())))
  await page.getByRole('button', { name: t('login.enroll.confirm'), exact: true }).click()

  const list = page.getByRole('list', { name: t('login.enroll.recoveryList') })
  await expect(list.getByRole('listitem')).toHaveCount(10)
  const codes = (await list.getByRole('listitem').allInnerTexts()).map((code) => code.trim())
  expect(new Set(codes).size, 'ten different codes').toBe(10)
  for (const code of codes) expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){5}$/)
  expect(await page.content(), 'the key must not stay in the page once the codes are shown').not.toContain(secret)
  expect(await page.locator('body').innerText()).not.toContain(`${secret.slice(0, 4)} ${secret.slice(4, 8)}`)

  const done = page.getByRole('button', { name: leave, exact: true })
  await expect(done, 'the codes are shown once: leaving needs the box').toBeDisabled()
  await page.getByRole('checkbox', { name: t('login.enroll.saved') }).check()
  await expect(done).toBeEnabled()
  await done.click()
  return { secret, codes }
}

/** The account of a fake GitHub login, or undefined while that person has never signed in. */
async function accountOf(admin: UserApi, login: string) {
  return (await admin.adminUsers({ q: login })).find((candidate) => candidate.githubLogin === login)
}

/**
 * Back to a plain reader, whatever an earlier run left behind: demoting to reader deletes an enrollment and the recovery codes, and ends
 * the person's sessions. A person who never signed in has nothing to reset.
 */
async function resetToReader(admin: UserApi, login: string): Promise<void> {
  const account = await accountOf(admin, login)
  // Only when there is something to undo: a role change is limited to 20 per 10 minutes per administrator.
  if (account && account.role !== 'USER') await admin.setUserRole(account.id, 'USER')
}

/** A reader of the fake GitHub, given a role for the length of a spec; returns the user id. The account exists once the reader signed in. */
async function makeRole(admin: UserApi, login: string, role: 'ADMIN' | 'AUTHOR'): Promise<string> {
  const account = await accountOf(admin, login)
  if (!account) throw new Error(`${login} has not signed in yet`)
  await admin.setUserRole(account.id, role)
  return account.id
}

test.describe('Two-step verification: the sign-in', () => {
  test('a wrong code shows the message and keeps the sign-in; a recovery code then finishes it', async ({ page }) => {
    await submitAdminPassword(page)
    await page.getByLabel(t('login.mfa.code'), { exact: true }).fill('000000')
    await page.getByRole('button', { name: t('login.mfa.submit'), exact: true }).click()

    await expect(inlineAlert(page)).toHaveText(t('login.mfa.invalid'))
    await expect(page).toHaveURL(/\/admin\/login\/mfa$/)
    await expect(page.getByLabel(t('login.mfa.code'), { exact: true })).toBeEnabled()

    // The challenge survived the wrong code: another code is accepted.
    await submitSecondStep(page, 'recovery')
    await expect(page.getByText(t('login.mfa.recoveryUsed'))).toBeVisible()
    await page.getByRole('button', { name: t('login.mfa.continue'), exact: true }).click()
    await expect(page).toHaveURL(/\/admin$/)
  })

  test('a code that was accepted once is refused the second time (replay protection)', async ({ page, playwright }) => {
    const code = await freshAdminCode()
    const http = await playwright.request.newContext({ baseURL: API_URL })
    try {
      const login = await http.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
      const challenge = ((await login.json()) as { data: { challenge: string } }).data.challenge
      const first = await http.post('/api/v1/auth/mfa/verify', { data: { challenge, code } })
      expect(first.status(), 'the first use of the code').toBe(200)
      // The session that this opened is not used: it ends here.
      const tokens = ((await first.json()) as { data: { refreshToken: string } }).data
      await http.post('/api/v1/auth/logout', { data: { refreshToken: tokens.refreshToken } })

      // The same code in the form, with a new challenge.
      await submitAdminPassword(page)
      await page.getByLabel(t('login.mfa.code'), { exact: true }).fill(code)
      await page.getByRole('button', { name: t('login.mfa.submit'), exact: true }).click()
      await expect(inlineAlert(page)).toHaveText(t('login.mfa.invalid'))
      await expect(page).toHaveURL(/\/admin\/login\/mfa$/)
    } finally {
      await http.dispose()
    }
  })

  test('the Security page of the administrator: on, recovery codes counted, no way to turn it off, the password card and Sign out everywhere', async ({
    adminPage: page,
    isMobile,
  }) => {
    if (isMobile) await page.getByRole('button', { name: 'Menu' }).click()
    await page
      .getByRole('list', { name: t('shell.sectionsLabel') })
      .getByRole('link', { name: t('shell.nav.security') })
      .click()
    await expect(page).toHaveURL(/\/admin\/security$/)

    await expect(page.getByRole('heading', { level: 1, name: t('security.title') })).toBeVisible()
    await expect(page.getByText(t('security.status.on'))).toBeVisible()
    const left = page.getByText(new RegExp(`^${t('security.recoveryLeft', { count: 99 }).replace('99', '(\\d+)')}`))
    await expect(left).toBeVisible()
    expect(Number(/(\d+)/.exec(await left.innerText())![1])).toBeGreaterThanOrEqual(recoveryCodesLeft())
    // An administrator cannot turn it off, and the page says why.
    await expect(page.getByRole('button', { name: t('security.turnOff'), exact: true })).toHaveCount(0)
    await expect(page.getByText(t('security.adminRequired'))).toBeVisible()
    await expect(page.getByRole('button', { name: t('security.regenerate'), exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: t('security.replace'), exact: true })).toBeVisible()
    // The account has a password and the server does not set it (the stack runs without ADMIN_PASSWORD): the form is there.
    await expect(page.getByRole('heading', { level: 2, name: t('security.password.title') })).toBeVisible()
    await expect(page.getByLabel(t('security.password.new'), { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: t('security.signOutEverywhere'), exact: true })).toBeVisible()
  })
})

test.describe('Two-step verification: a new administrator', () => {
  test('enrolls through the GitHub sign-in, then manages it in Security and signs out everywhere', async ({
    browser,
    backend,
    userContext,
    reader,
  }, testInfo) => {
    test.setTimeout(150_000)
    const login = reader('erin')
    const admin = await backend.asAdmin()
    await resetToReader(admin, login)
    await userContext(login)
    const id = await makeRole(admin, login, 'ADMIN')
    const context = await newVisitorContext(browser, testInfo)
    const other = await newVisitorContext(browser, testInfo)
    try {
      const page = await context.newPage()
      await page.goto(localePath('/'))

      // GitHub is the first factor; an administrator without an authenticator is sent to set one up. The stack's enrollment window is
      // open (a throw-away stack that opts in to development defaults), so no enrollment code is asked.
      const { landed } = await beginGitHubSignIn(page, login)
      expect(landed.pathname).toBe('/admin/login/enroll')
      expect(landed.search, 'no enrollment code is asked on this stack').toBe('')
      await expect(page.getByRole('heading', { level: 1, name: t('login.enroll.title') })).toBeVisible()
      expect(
        (await context.cookies()).some((cookie) => cookie.name === ACCESS_COOKIE),
        'no session before the first code',
      ).toBe(false)

      const { codes } = await enrollThroughThePage(page, t('login.enroll.continue'))
      await expect(page).toHaveURL(/\/admin$/)
      expect(
        (await context.cookies()).some((cookie) => cookie.name === 'mfa_challenge'),
        'the challenge is gone',
      ).toBe(false)

      // Security: on, ten codes, no Turn off, and no password card (a GitHub account has no password).
      await page.goto('/admin/security')
      await expect(page.getByText(t('security.status.on'))).toBeVisible()
      await expect(page.getByText(t('security.recoveryLeft', { count: 10 }))).toBeVisible()
      await expect(page.getByRole('button', { name: t('security.turnOff'), exact: true })).toHaveCount(0)
      await expect(page.getByRole('heading', { level: 2, name: t('security.password.title') })).toHaveCount(0)

      // New recovery codes, asked with a recovery code (the person who lost the phone has nothing else): the old ones stop working.
      await page.getByRole('button', { name: t('security.regenerate'), exact: true }).click()
      await page.getByLabel(t('security.currentCode')).fill(codes[0]!)
      await page.getByRole('button', { name: t('security.regenerate'), exact: true }).click()
      const list = page.getByRole('list', { name: t('login.enroll.recoveryList') })
      await expect(list.getByRole('listitem')).toHaveCount(10)
      const fresh = (await list.getByRole('listitem').allInnerTexts()).map((code) => code.trim())
      expect(
        fresh.filter((code) => codes.includes(code)),
        'all ten codes are new',
      ).toEqual([])
      await page.getByRole('checkbox', { name: t('login.enroll.saved') }).check()
      await page.getByRole('button', { name: t('security.done'), exact: true }).click()
      await expect(page.getByRole('status').filter({ hasText: t('security.notice.regenerated') })).toBeVisible()
      await expect(page.getByText(t('security.recoveryLeft', { count: 10 }))).toBeVisible()

      // Sign out everywhere: another browser holding the same session loses it as well.
      await other.addCookies(await context.cookies())
      const otherPage = await other.newPage()
      await otherPage.goto('/admin')
      await expect(otherPage).toHaveURL(/\/admin$/)
      await page.getByRole('button', { name: t('security.signOutEverywhere'), exact: true }).click()
      await page
        .getByRole('group', { name: t('security.signOutConfirm') })
        .getByRole('button', { name: t('security.signOutEverywhere'), exact: true })
        .click()
      await expect(page).toHaveURL(/\/admin\/login$/)
      await otherPage.reload()
      await expect(otherPage).toHaveURL(/\/admin\/login/)
    } finally {
      await other.close()
      await context.close()
      // Demoting deletes the enrollment and the recovery codes: the next run starts from a plain reader.
      await admin.setUserRole(id, 'USER')
    }
  })
})

test.describe('Two-step verification: an author', () => {
  test('turns it on and off in Security; a reader of the site never sees it', async ({
    browser,
    backend,
    userContext,
    reader,
  }, testInfo) => {
    test.setTimeout(150_000)
    const login = reader('frank')
    const admin = await backend.asAdmin()
    await resetToReader(admin, login)
    await userContext(login)
    const id = await makeRole(admin, login, 'AUTHOR')
    const context = await newVisitorContext(browser, testInfo)
    try {
      const page = await context.newPage()
      await page.goto(localePath('/'))
      // An author without an authenticator signs in with GitHub alone: no second step yet.
      const { landed } = await beginGitHubSignIn(page, login)
      expect(landed.pathname).toBe(new URL(localePath('/'), landed.origin).pathname)

      await page.goto('/admin/security')
      await expect(page.getByText(t('security.status.off'))).toBeVisible()
      await expect(page.getByText(t('security.offHint'))).toBeVisible()
      await expect(
        page.getByRole('heading', { level: 2, name: t('security.password.title') }),
        'an author has no password',
      ).toHaveCount(0)

      // Turn on: the same setup as the forced enrollment, with no enrollment code (the author is signed in).
      await page.getByRole('button', { name: t('security.turnOn'), exact: true }).click()
      const { codes } = await enrollThroughThePage(page, t('security.done'))
      await expect(page.getByRole('status').filter({ hasText: t('security.notice.turnedOn') })).toBeVisible()
      await expect(page.getByText(t('security.status.on'))).toBeVisible()
      await expect(page.getByText(t('security.recoveryLeft', { count: 10 }))).toBeVisible()

      // Turn off: a code is needed (a recovery code does), and the consequences are said before.
      await page.getByRole('button', { name: t('security.turnOff'), exact: true }).click()
      await expect(page.getByText(t('security.turnOffLead'))).toBeVisible()
      await page.getByLabel(t('security.currentCode')).fill(codes[0]!)
      await page.getByRole('button', { name: t('security.turnOffConfirm'), exact: true }).click()
      await expect(page.getByRole('status').filter({ hasText: t('security.notice.turnedOff') })).toBeVisible()
      await expect(page.getByText(t('security.status.off'))).toBeVisible()
      await expect(page.getByRole('button', { name: t('security.turnOn'), exact: true })).toBeVisible()
    } finally {
      await context.close()
      await admin.setUserRole(id, 'USER')
    }
  })
})
