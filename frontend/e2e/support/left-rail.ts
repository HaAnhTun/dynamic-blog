import { expect, type Locator, type Page } from '@playwright/test'
import { msg } from './i18n'

/**
 * Open the left sidebar where it is a closed card, and return its `aside`.
 *
 * Below `lg` the sidebar is ONE `<details data-rail-phone>` card, and Playwright's role queries do not see inside a closed one, so its
 * summary is pressed first. The card's direct `<summary>` is the only `<summary>` that carries the hook, so the lookup is
 * `[data-rail-phone] > summary`: a bare `locator('summary')` or `locator('details')` of the aside would match the series and category
 * groups of the desktop copy as well and throw a strict-mode violation at every width. From `lg` the card is `display:none`, its
 * summary is not visible and nothing is clicked.
 */
export async function openLeftRail(page: Page): Promise<Locator> {
  const rail = page.getByRole('complementary', { name: msg('Site.reader.leftLabel') })
  const summary = rail.locator('[data-rail-phone] > summary')
  if (await summary.isVisible()) {
    const card = rail.locator('details[data-rail-phone]')
    if (!(await card.evaluate((node) => (node as HTMLDetailsElement).open))) await summary.click()
  }
  return rail
}

/**
 * The `<nav>` landmark of the series group: named after the series, OUTSIDE the group's `<details>`, so it stays a landmark while the
 * group is collapsed. Catalog text is read when the helper is called, never at import time.
 */
export async function seriesLandmark(page: Page, title: string): Promise<Locator> {
  const rail = await openLeftRail(page)
  const nav = rail.getByRole('navigation', { name: title })
  await expect(nav).toBeVisible()
  return nav
}

/**
 * The series group of a post page: the eyebrow "Series · Part n/m" AND the `<nav>` named after the series, which sit side by side in
 * one wrapper (the eyebrow is not inside the nav). It is the parent of the landmark, so a spec can read both the part counter and the
 * list from one locator; use `seriesLandmark` for the landmark itself. Below `lg` the card is opened first (`openLeftRail`).
 */
export async function seriesNav(page: Page, title: string): Promise<Locator> {
  const nav = await seriesLandmark(page, title)
  return nav.locator('xpath=..')
}
