import { signInAsAdminThroughForm, submitAdminPassword, submitSecondStep } from '../support/admin'
import { sessionCookies } from '../support/admin-session'
import { ADMIN_EMAIL, ADMIN_PASSWORD } from '../support/env'
import { expect, test } from '../support/fixtures'
import { recoveryCodesLeft } from '../support/mfa-state'
import { readSeo } from '../support/page'
import { msg } from '../support/i18n'
import { ACCESS_COOKIE, SESSION_COOKIES } from '../support/session-cookies'

/**
 * The administrator's sign-in is two steps: the password, then a code of the authenticator (or a recovery code). These specs drive the
 * real form and the real second-step page. The specs that only need to BE the administrator use the session that the global setup made
 * through this same form (e2e/global-setup.ts), so this is the coverage of the form itself.
 */
test.describe('Admin sign-in', () => {
  test('when not signed in the admin pages redirect to the sign-in page', async ({ page }) => {
    await page.goto('/admin/curated')
    await expect(page).toHaveURL(/\/admin\/login/)
    await expect(page.getByRole('button', { name: msg('Admin.login.title') })).toBeVisible()
  })

  test('a wrong password reports the error in place; the right one asks for a code, and no session exists before it', async ({
    page,
    context,
  }) => {
    await page.goto('/admin/login')
    await page.getByLabel('Email').fill(ADMIN_EMAIL)
    await page.getByLabel(msg('Admin.login.password')).fill('wrong-password-e2e')
    await page.getByRole('button', { name: msg('Admin.login.title') }).click()
    await expect(page.getByRole('alert')).toBeVisible()
    await expect(page).toHaveURL(/\/admin\/login$/)

    await page.getByLabel(msg('Admin.login.password')).fill(ADMIN_PASSWORD)
    await page.getByRole('button', { name: msg('Admin.login.title') }).click()
    await expect(page).toHaveURL(/\/admin\/login\/mfa$/)
    await expect(page.getByRole('heading', { level: 1, name: msg('Admin.login.mfa.title') })).toBeVisible()
    await expect(page.getByLabel(msg('Admin.login.mfa.code'), { exact: true })).toBeFocused()

    // The password alone opens nothing: only the challenge cookie exists (httpOnly, Secure, valid for the sign-in pages only).
    const cookies = await context.cookies()
    expect(cookies.map((cookie) => cookie.name).filter((name) => SESSION_COOKIES.includes(name))).toEqual([])
    const challenge = cookies.find((cookie) => cookie.name === 'mfa_challenge')
    expect(challenge, 'challenge cookie').toBeDefined()
    expect(challenge).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/admin/login' })
    await page.goto('/admin')
    await expect(page, 'the challenge is not a session').toHaveURL(/\/admin\/login$/)
  })

  test('the right code enters "Posts" with an httpOnly + secure session, and the challenge is gone', async ({
    page,
    context,
    isMobile,
  }) => {
    await submitAdminPassword(page)
    await submitSecondStep(page, 'totp')
    await expect(page).toHaveURL(/\/admin$/)
    await expect(page.getByRole('heading', { level: 1, name: msg('Admin.posts.preview.back') })).toBeVisible()

    // Below lg the nav sits behind the "Menu" button (the admin top bar on a phone).
    if (isMobile) await page.getByRole('button', { name: 'Menu' }).click()
    const sections = page.getByRole('list', { name: msg('Admin.shell.sectionsLabel') }).getByRole('link')
    await expect(sections).toHaveText([
      msg('Admin.posts.preview.back'),
      msg('Admin.shell.nav.analytics'),
      msg('Admin.shell.nav.topics'),
      'Series',
      msg('Admin.posts.row.featured'),
      msg('Admin.postImages.altDefault'),
      msg('Admin.editor.commentsHeading'),
      msg('Admin.shell.nav.users'),
      msg('Admin.shell.nav.applications'),
      'Newsletter',
      msg('Admin.shell.nav.contact'),
      msg('Admin.shell.nav.security'),
      msg('Admin.shell.nav.settings'),
    ])
    await expect(sections.first()).toHaveAttribute('aria-current', 'page')
    expect((await readSeo(page)).robots).toBe('noindex, nofollow')

    const cookies = await context.cookies()
    const session = cookies.find((cookie) => cookie.name === ACCESS_COOKIE)
    expect(session, 'session cookie').toBeDefined()
    expect(session!.httpOnly).toBe(true)
    expect(session!.secure).toBe(true)
    expect(
      cookies.some((cookie) => cookie.name === 'mfa_challenge'),
      'the challenge cookie is cleared',
    ).toBe(false)
  })

  test('a recovery code signs in too, burns one, and says how many are left and where to replace the authenticator', async ({
    page,
  }) => {
    await submitAdminPassword(page)
    await submitSecondStep(page, 'recovery')

    // The code left the file when it was taken: what remains is what the page must say.
    await expect(page.getByText(msg('Admin.login.mfa.recoveryUsed'))).toBeVisible()
    await expect(page.getByText(msg('Admin.login.mfa.recoveryLeft', { count: recoveryCodesLeft() }))).toBeVisible()
    await expect(page.getByText(msg('Admin.login.mfa.replaceHint'))).toBeVisible()
    await expect(page.getByRole('link', { name: msg('Admin.login.mfa.openSecurity') })).toHaveAttribute('href', '/admin/security')
    await page.getByRole('button', { name: msg('Admin.login.mfa.continue'), exact: true }).click()
    await expect(page).toHaveURL(/\/admin$/)
  })

  test('the second step needs a sign-in in progress: opened directly it goes back to the sign-in page', async ({ page }) => {
    await page.goto('/admin/login/mfa')
    await expect(page).toHaveURL(/\/admin\/login$/)
    await page.goto('/admin/login/enroll')
    await expect(page).toHaveURL(/\/admin\/login$/)
  })

  test('signing out ends the session: /admin asks for sign-in again', async ({ page, isMobile }) => {
    // Its own session, not the saved one: signing out revokes the refresh token, and the suite shares the saved session.
    await signInAsAdminThroughForm(page, { proof: 'recovery' })
    if (isMobile) await page.getByRole('button', { name: 'Menu' }).click()
    await page.getByRole('button', { name: msg('Admin.shell.logout') }).click()
    await expect(page).toHaveURL(/\/admin\/login$/)
    await page.goto('/admin')
    await expect(page).toHaveURL(/\/admin\/login/)
  })

  test('signing out in one tab deletes the editor draft and stops an editor open in another tab from writing it back', async ({
    page,
    isMobile,
  }) => {
    await signInAsAdminThroughForm(page, { proof: 'recovery' })
    const draftKeys = () =>
      page.evaluate(() => Object.keys(window.localStorage).filter((key) => key.startsWith('bai-viet:nhap:')))

    // First tab: the editor with unsaved text. It has no sidebar, so no Sign out button of its own.
    await page.goto('/admin/posts/new')
    await page.getByLabel(msg('Admin.editor.titleLabel')).fill('Draft kept after signing out E2E')
    // The unsaved copy is written one second after the last keystroke, for the signed-in account.
    await expect.poll(draftKeys).toHaveLength(1)
    expect((await draftKeys())[0]).toMatch(/^bai-viet:nhap:[0-9a-f-]{36}:moi$/)

    // Second tab of the same browser: the dashboard, where Sign out is.
    const dashboard = await page.context().newPage()
    await dashboard.goto('/admin')
    if (isMobile) await dashboard.getByRole('button', { name: 'Menu' }).click()
    await dashboard.getByRole('button', { name: msg('Admin.shell.logout') }).click()
    await expect(dashboard).toHaveURL(/\/admin\/login$/)
    expect(await draftKeys()).toEqual([])

    // The first tab is still open on the editor and the writer keeps typing: the other tab's sign-out told it to stop writing.
    await page.getByLabel(msg('Admin.editor.contentLabel')).fill('Text typed after the other tab signed out')
    await page.waitForTimeout(2_000)
    expect(await draftKeys()).toEqual([])
    await dashboard.close()
  })

  test('a hand-made token with an ADMIN claim opens nothing that is generated in the frontend', async ({ browser, baseURL }) => {
    // An unsigned payload with a role of ADMIN and any refresh cookie: the proxy and the shell only read the claim, the backend refuses it.
    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const forged = `${b64({ alg: 'HS256' })}.${b64({ sub: '11111111-1111-1111-1111-111111111111', role: 'ADMIN', exp: Math.floor(Date.now() / 1000) + 900 })}.not-a-signature`
    const context = await browser.newContext({ baseURL })
    try {
      await context.addCookies(sessionCookies({ accessToken: forged, refreshToken: 'not-a-refresh-token' }))

      const response = await context.request.get('/admin/posts/import/authoring-prompt', { maxRedirects: 0 })

      expect(response.status()).toBe(307)
      expect(new URL(response.headers()['location'] ?? '', baseURL).pathname).toBe('/admin/login')
      expect(response.headers()['content-disposition']).toBeUndefined()
    } finally {
      await context.close()
    }
  })
})
