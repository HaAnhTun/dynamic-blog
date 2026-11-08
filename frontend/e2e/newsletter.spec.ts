import { randomBytes } from 'node:crypto'
import type { Request } from '@playwright/test'
import { expect, test } from './support/fixtures'
import { randomClientAddress } from './support/network'
import { readSeo } from './support/page'
import { msg, localePath } from './support/i18n'

/**
 * Newsletter without needing any real mail: the E2E stack uses a log-only transport, and no step
 * here reads a mailbox. The token is a random string of exactly the shape the backend has never issued, so it always gets the generic sentence.
 * Each test has its own client address (fixtures.ts), so the per-IP quota of the Next route does not link tests together.
 */

/** Exactly the shape of 32 random bytes written as base64url. */
function randomToken(): string {
  return randomBytes(32).toString('base64url')
}

/** An address at example.com (RFC 2606): never a real mailbox. */
function freshAddress(): string {
  return `newsletter-e2e-${Date.now()}-${randomBytes(4).toString('hex')}@example.com`
}

const LINK_INVALID = msg('Site.newsletter.token.linkInvalid')

/** The error code in the `{ error: { code } }` envelope, from an APIResponse or a response the browser sees. */
async function errorCode(response: { json(): Promise<unknown> }): Promise<string | undefined> {
  const body = (await response.json().catch(() => null)) as { error?: { code?: string } } | null
  return body?.error?.code
}

test.describe('Newsletter', () => {
  test('subscribing a new address and then the same address again: the same sentence on the page, the same BFF response', async ({
    page,
  }) => {
    const address = freshAddress()
    await page.goto(localePath('/newsletter'))
    const main = page.getByRole('main')
    await main.getByLabel(msg('Site.newsletter.form.emailLabel')).fill(address)

    const bodies: string[] = []
    const messages: string[] = []
    for (const attempt of ['first attempt', 'second attempt']) {
      const answered = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/newsletter/subscribe')
      await main.getByRole('button', { name: msg('Site.newsletter.form.submit') }).click()
      const response = await answered
      expect(response.status(), attempt).toBe(202)
      const body = await response.text()
      expect(body.toLowerCase(), attempt).not.toContain(address.toLowerCase())
      bodies.push(body)
      const status = main.getByRole('status')
      await expect(status, attempt).toContainText(msg('Site.newsletter.form.accepted').split('.')[0]! + '.')
      messages.push((await status.textContent()) ?? '')
    }

    expect(bodies[1]).toBe(bodies[0])
    expect(messages[1]).toBe(messages[0])
  })

  for (const { path, button, back } of [
    {
      path: '/newsletter/confirm',
      button: msg('Site.newsletter.token.confirm.button'),
      back: msg('Site.newsletter.token.confirm.back'),
    },
    {
      path: '/newsletter/unsubscribe',
      button: msg('Site.newsletter.token.unsubscribe.button'),
      back: msg('Site.newsletter.token.unsubscribe.back'),
    },
  ]) {
    test(`${path}?token=…: noindex, Referrer-Policy no-referrer, GET has only a button; clicking gives the generic sentence for a bad link`, async ({
      page,
    }) => {
      const token = randomToken()
      const requests: Request[] = []
      page.on('request', (request) => requests.push(request))

      const response = await page.goto(localePath(`${path}?token=${token}`))
      expect(response?.status()).toBe(200)
      expect(response?.headers()['referrer-policy']).toBe('no-referrer')
      expect((await readSeo(page)).robots).toBe('noindex, nofollow')
      const main = page.getByRole('main')
      const action = main.getByRole('button', { name: button, exact: true })
      await expect(action).toBeVisible()
      expect(await main.textContent(), 'the token is only in the URL, not printed on the page').not.toContain(token)

      // GET changes nothing: before the click no request goes to the newsletter route, and no request (including the header's
      // /api/session) carries a URL with the token in its Referer.
      await page.waitForLoadState('networkidle')
      const site = new URL(page.url()).origin
      const sameOrigin = requests.filter((request) => new URL(request.url()).origin === site)
      expect(sameOrigin.some((request) => new URL(request.url()).pathname === '/api/session')).toBe(true)
      expect(sameOrigin.filter((request) => new URL(request.url()).pathname.startsWith('/api/newsletter/'))).toEqual([])
      for (const request of sameOrigin) {
        expect((await request.allHeaders())['referer'], request.url()).toBeUndefined()
      }

      const posted = page.waitForResponse(
        (answer) => new URL(answer.url()).pathname === `/api${path}` && answer.request().method() === 'POST',
      )
      await action.click()
      const answer = await posted
      expect(answer.status()).toBe(400)
      expect(await errorCode(answer)).toBe('NEWSLETTER_TOKEN_INVALID')
      expect((await answer.request().allHeaders())['referer']).toBeUndefined()

      await expect(main.getByText(LINK_INVALID)).toBeVisible()
      await expect(main.getByRole('link', { name: back })).toHaveAttribute('href', localePath('/newsletter'))
      await expect(main.getByRole('button')).toHaveCount(0)
    })
  }

  test("POST of a one-click action (RFC 8058) from the mail provider's machine: cross-origin, form body, no cookie; reaches the token check, not 403/415", async ({
    playwright,
  }, testInfo) => {
    const mailProvider = await playwright.request.newContext({
      baseURL: testInfo.project.use.baseURL,
      extraHTTPHeaders: { 'x-forwarded-for': randomClientAddress() },
    })
    try {
      const response = await mailProvider.post(`/api/newsletter/unsubscribe?token=${randomToken()}`, {
        form: { 'List-Unsubscribe': 'One-Click' },
        headers: { origin: 'https://mail.example.com', 'sec-fetch-site': 'cross-site' },
      })
      expect(response.status()).toBe(400)
      expect(await errorCode(response)).toBe('NEWSLETTER_TOKEN_INVALID')
      expect(response.headers()['cache-control']).toBe('private, no-store')
    } finally {
      await mailProvider.dispose()
    }
  })

  test('the admin sees /admin/newsletter: counts by status, no address (even the address just subscribed)', async ({
    adminPage,
    playwright,
  }, testInfo) => {
    const address = freshAddress()
    const reader = await playwright.request.newContext({
      baseURL: testInfo.project.use.baseURL,
      extraHTTPHeaders: { 'x-forwarded-for': randomClientAddress() },
    })
    try {
      expect((await reader.post('/api/newsletter/subscribe', { data: { email: address } })).status()).toBe(202)
    } finally {
      await reader.dispose()
    }

    const response = await adminPage.goto('/admin/newsletter')
    expect(response?.status()).toBe(200)
    const main = adminPage.getByRole('main')
    await expect(main.getByRole('heading', { level: 1, name: 'Newsletter' })).toBeVisible()
    const counts = main.getByRole('region', { name: msg('Admin.newsletter.subscribers.title') })
    await expect(counts.getByRole('term')).toHaveText([
      msg('Admin.newsletter.subscribers.confirmed.label'),
      msg('Admin.newsletter.subscribers.pending.label'),
      msg('Admin.newsletter.subscribers.suppressed.label'),
    ])
    const pending = await counts
      .getByRole('term')
      .filter({ hasText: msg('Admin.newsletter.subscribers.pending.label') })
      .locator('xpath=following-sibling::dd[1]')
      .textContent()
    expect(
      Number((pending ?? '').replace(/\D/g, '')),
      'the address just subscribed is pending confirmation',
    ).toBeGreaterThanOrEqual(1)

    const text = (await main.textContent()) ?? ''
    expect(text).not.toContain(address)
    expect(text, 'nothing on the page looks like an email address').not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/)
  })
})
