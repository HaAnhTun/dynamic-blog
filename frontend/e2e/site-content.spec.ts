import type { Page } from '@playwright/test'
import { expect, test } from './support/fixtures'
import { msg } from './support/i18n'
import enProfile from '../content/defaults/en/profile.json'
import viProfile from '../content/defaults/vi/profile.json'
import { API_URL } from './support/env'

/**
 * The owner's content is data: editing the profile in the admin changes the public page in each language at once, with no rebuild
 * (the save is a server action that clears the `site-content` cache tag). The greeting is restored at the end, so the shared
 * database ends with content equal to the packaged defaults. Desktop only: nothing here depends on the viewport.
 */
test.beforeEach(() => {
  test.skip(test.info().project.name !== 'desktop', 'the journey does not depend on the viewport')
})

const DEFAULT_GREETING = { vi: viProfile.hero.greeting, en: enProfile.hero.greeting } as const

async function setGreeting(page: Page, locale: 'vi' | 'en', greeting: string): Promise<void> {
  await page.goto(`/admin/settings/profile?locale=${locale}`)
  const field = page.getByLabel(msg('Admin.settings.profile.greeting'), { exact: true })
  await field.fill(greeting)
  await page.getByRole('button', { name: msg('Admin.settings.save'), exact: true }).click()
  await expect(page.getByText(msg('Admin.settings.saved'), { exact: true })).toBeVisible()
}

test('editing the profile in the admin changes the public page in both languages without a rebuild', async ({
  adminPage: page,
}) => {
  test.setTimeout(180_000)
  const marker = String(Date.now())
  const viGreeting = `Greeting vi ${marker}`
  const enGreeting = `Greeting en ${marker}`
  try {
    await setGreeting(page, 'vi', viGreeting)
    await setGreeting(page, 'en', enGreeting)

    await page.goto('/')
    await expect(page.getByText(viGreeting, { exact: true })).toBeVisible()
    await page.goto('/en')
    await expect(page.getByText(enGreeting, { exact: true })).toBeVisible()
    // Each language shows its own row: the Vietnamese greeting is not on the English page.
    await expect(page.getByText(viGreeting, { exact: true })).toHaveCount(0)
  } finally {
    await setGreeting(page, 'vi', DEFAULT_GREETING.vi)
    await setGreeting(page, 'en', DEFAULT_GREETING.en)
  }
  await page.goto('/')
  await expect(page.getByText(viGreeting, { exact: true })).toHaveCount(0)
})

test('the settings page lists every content section', async ({ adminPage: page }) => {
  await page.goto('/admin/settings')
  await expect(page.getByRole('heading', { level: 1, name: msg('Admin.settings.title') })).toBeVisible()
  await expect(page.getByRole('list', { name: msg('Admin.settings.listLabel') })).toBeVisible()
})

test('the first-run setup page is closed on an instance that is already set up', async ({ request }) => {
  const page = await request.get('/setup', { maxRedirects: 0 })
  expect(page.status()).toBe(404)
  const status = await request.get(`${API_URL}/api/v1/setup/status`)
  expect(status.status()).toBe(200)
  expect(((await status.json()) as { data: { setupRequired: boolean } }).data.setupRequired).toBe(false)
  // A claim attempt is answered the same whether the code is right or not: there is nothing to claim.
  const claim = await request.post(`${API_URL}/api/v1/setup`, {
    data: {
      setupCode: 'e2e-not-a-code-e2e-not-a-code',
      email: 'nobody@example.test',
      password: 'not-a-password-123',
      displayName: 'Nobody',
    },
  })
  expect(claim.status()).toBe(404)
})
