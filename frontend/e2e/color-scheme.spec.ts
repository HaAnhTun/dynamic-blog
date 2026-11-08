import type { Page } from '@playwright/test'
import { expect, test } from './support/fixtures'
import { msg } from './support/i18n'

/**
 * `color-scheme` and `theme-color`. globals.css sets `color-scheme` on <html> according to data-theme
 * (scrollbars, inputs, checkboxes and canvas draw by it), the admin is always light; app/layout.tsx exports `viewport`
 * with two `theme-color` values per OS. Unit tests (app/globals.test.ts, app/layout.test.ts) keep the rules and
 * exports; here are the computed values in a real browser, changing immediately when the theme button is clicked.
 */

/** The theme button's accessible name starts with the same words as its title; the rest depends on the current theme. */
const THEME_NAME_PREFIX = new RegExp(`^${msg('Site.shell.themeToggle.title', { current: 'light' }).split(':')[0]}:`)

/** The computed `color-scheme` of <html>. */
function rootColorScheme(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)
}

function dataTheme(page: Page): Promise<string | null> {
  return page.evaluate(() => document.documentElement.getAttribute('data-theme'))
}

test.describe('color-scheme follows the site theme', () => {
  test('public pages: follow the choice on the theme button, change immediately on click, do not follow the OS', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto('/')

    // Default "follow the system", dark OS: dark.
    await expect.poll(() => dataTheme(page)).toBe('dark')
    expect(await rootColorScheme(page)).toBe('dark')

    // The button cycle: system → light → dark. "Light" on a dark OS: the page is light, controls are light.
    const toggle = page.getByRole('banner').getByRole('button', { name: THEME_NAME_PREFIX })
    await toggle.click()
    await expect.poll(() => dataTheme(page)).toBe('light')
    expect(await rootColorScheme(page)).toBe('light')

    await toggle.click()
    await expect.poll(() => dataTheme(page)).toBe('dark')
    expect(await rootColorScheme(page)).toBe('dark')
  })

  test('admin pages are always light, even when the saved choice is dark', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto('/admin/login')
    await page.evaluate(() => localStorage.setItem('theme', 'dark'))
    await page.reload()

    // The boot script still writes data-theme for the whole document; the :root:has([data-admin]) rule resets the root to light.
    expect(await dataTheme(page)).toBe('dark')
    await expect(page.locator('[data-admin]').first()).toBeVisible()
    expect(await rootColorScheme(page)).toBe('light')
  })

  test('theme-color: two tags by OS, matching the page background color; no color-scheme meta', async ({ page }) => {
    await page.goto('/')

    const metas = await page
      .locator('meta[name="theme-color"]')
      .evaluateAll((nodes) => nodes.map((node) => [node.getAttribute('media'), node.getAttribute('content')]))
    expect(metas).toEqual([
      ['(prefers-color-scheme: light)', '#ffffff'],
      ['(prefers-color-scheme: dark)', '#0a0a0a'],
    ])
    // A color-scheme meta is read before the CSS and the boot script: it would paint the canvas by the OS for a user who chose the opposite.
    await expect(page.locator('meta[name="color-scheme"]')).toHaveCount(0)

    // Those two colors are the <body> background of each theme: bg-white (#ffffff) and Tailwind 4's neutral-950,
    // oklch(0.145 0 0), i.e. #0a0a0a. Compare through a 2D canvas (8-bit sRGB), not as strings: Chrome prints the computed color
    // in its own color space (Chrome 155: `lab(2.75381 0 0)`), the same color with different text.
    const background = () =>
      page.evaluate(() => {
        const canvas = document.createElement('canvas')
        canvas.width = 1
        canvas.height = 1
        const context = canvas.getContext('2d')!
        context.fillStyle = getComputedStyle(document.body).backgroundColor
        context.fillRect(0, 0, 1, 1)
        return Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3))
      })
    const near = (actual: number[], expected: number[]) =>
      actual.every((channel, index) => Math.abs(channel - expected[index]!) <= 1)
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
    const light = await background()
    expect(near(light, [255, 255, 255]), `light background ${light}`).toBe(true)
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    const dark = await background()
    expect(near(dark, [10, 10, 10]), `dark background ${dark}`).toBe(true)
  })
})
