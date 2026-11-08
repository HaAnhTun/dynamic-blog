import type { Page } from '@playwright/test'
import { expect, test } from './support/fixtures'
import { LANGUAGE_NAMES } from '../components/site/language-names'
import { msg } from './support/i18n'

/**
 * The language switcher of the public header and of the admin. Desktop project only: the header layout at phone widths is
 * measured by overflow.spec.ts, and none of these checks depends on the viewport.
 */
test.beforeEach(() => {
  test.skip(test.info().project.name !== 'desktop', 'the switcher does not depend on the viewport')
})

/** A language is named in itself: the Vietnamese name stays the same in every catalog. */
const VIETNAMESE_NAME = LANGUAGE_NAMES.vi
const SWITCHER_NAME = msg('Admin.language.label')

/** The pill is a native disclosure: click it, then the rows are visible. Returns the header's language navigation. */
async function openSwitcher(page: Page, name: string) {
  const nav = page.getByRole('banner').getByRole('navigation', { name })
  await nav.locator('summary').click()
  return nav
}

test.describe('public language switcher', () => {
  test('the dropdown on /writing leads to /en/writing and back', async ({ page }) => {
    await page.goto('/writing')

    await (await openSwitcher(page, SWITCHER_NAME)).getByRole('link', { name: 'English' }).click()
    await expect(page).toHaveURL(/\/en\/writing$/)
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')

    await (await openSwitcher(page, 'Language')).getByRole('link', { name: VIETNAMESE_NAME }).click()
    await expect(page).toHaveURL(/\/writing$/)
    await expect(page).not.toHaveURL(/\/en\//)
    await expect(page.locator('html')).toHaveAttribute('lang', 'vi')
  })

  test('the current language is marked and is not a link, the other one is', async ({ page }) => {
    await page.goto('/en/start-here')
    const nav = await openSwitcher(page, 'Language')

    await expect(nav.locator('[aria-current="true"]')).toContainText('English')
    await expect(nav.getByRole('link')).toHaveText([VIETNAMESE_NAME])
    await expect(nav.getByRole('link', { name: VIETNAMESE_NAME })).toHaveAttribute('href', '/start-here')
  })

  test('Escape and a press outside close it', async ({ page }) => {
    await page.goto('/writing')
    const nav = await openSwitcher(page, SWITCHER_NAME)
    await expect(nav.getByRole('link', { name: 'English' })).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(nav.getByRole('link', { name: 'English' })).toBeHidden()
    await expect(nav.locator('summary')).toBeFocused()

    await nav.locator('summary').click()
    await expect(nav.getByRole('link', { name: 'English' })).toBeVisible()
    await page.getByRole('main').click({ position: { x: 5, y: 5 } })
    await expect(nav.getByRole('link', { name: 'English' })).toBeHidden()
  })

  test('keyboard: Tab reaches the pill, Enter opens it and Enter on the link follows it', async ({ page }) => {
    await page.goto('/writing')
    const nav = page.getByRole('banner').getByRole('navigation', { name: SWITCHER_NAME })
    const summary = nav.locator('summary')

    for (let step = 0; step < 30; step += 1) {
      await page.keyboard.press('Tab')
      if (await summary.evaluate((element) => element === document.activeElement)) break
    }
    await expect(summary).toBeFocused()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Tab')
    await expect(nav.getByRole('link', { name: 'English' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/en\/writing$/)
  })

  test('/en/start-here shows the English footer and heading', async ({ page }) => {
    await page.goto('/en/start-here')

    await expect(page.getByRole('heading', { level: 1, name: 'Best posts' })).toBeVisible()
    const footer = page.getByRole('contentinfo')
    await expect(footer.getByRole('navigation', { name: 'Footer links' })).toBeVisible()
    await expect(footer.getByRole('link', { name: 'Writing' })).toHaveAttribute('href', '/en/writing')
  })
})

test.describe('public language switcher without JavaScript', () => {
  test.use({ javaScriptEnabled: false })

  test('the pill opens natively and the row is a plain link to the other language of the same page', async ({ page }) => {
    await page.goto('/writing')
    await (await openSwitcher(page, SWITCHER_NAME)).getByRole('link', { name: 'English' }).click()
    await expect(page).toHaveURL(/\/en\/writing$/)

    await (await openSwitcher(page, 'Language')).getByRole('link', { name: VIETNAMESE_NAME }).click()
    await expect(page).toHaveURL(/\/writing$/)
  })
})

test.describe('admin language switcher', () => {
  test('the login page switcher sets the admin_locale cookie and flips the page language', async ({ page, context }) => {
    await page.goto('/admin/login')
    await expect(page.locator('html')).toHaveAttribute('lang', 'vi')

    await page.getByRole('group', { name: SWITCHER_NAME }).getByRole('button', { name: 'English' }).click()

    await expect(page).toHaveURL(/\/admin\/login$/)
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible()
    const cookie = (await context.cookies()).find((item) => item.name === 'admin_locale')
    expect(cookie?.value).toBe('en')

    await page.getByRole('group', { name: 'Language' }).getByRole('button', { name: VIETNAMESE_NAME }).click()
    await expect(page.locator('html')).toHaveAttribute('lang', 'vi')
  })
})
