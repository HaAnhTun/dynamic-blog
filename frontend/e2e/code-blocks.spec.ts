import type { Backend } from './support/backend'
import { expect, test } from './support/fixtures'
import { localePath, msg } from './support/i18n'

/**
 * The copy-code button on each code block of a post: components/site/CodeBlock.tsx wraps every <pre>
 * that lib/markdown.tsx builds, and CopyCodeButton.tsx reads the <pre>'s `textContent` when clicked.
 *
 * Unit tests keep the logic (what is copied, what is announced, clipboard errors); here is the part only a real browser can
 * answer: the button sits in the strip reserved at the top of the block so it does not cover the first code line, its size at each
 * viewport, reachable with Tab and activated with Enter, and what lands on the clipboard is exactly the text of the block.
 *
 * The post comes from the stack's data (the first published post that has a code block with a language), not from a
 * hand-copied slug; if no post has one the test is skipped, with a reason.
 */

/** The slug of the first published post that has a code block with a language (Shiki colors it), or null. */
async function postWithCode(backend: Backend): Promise<string | null> {
  for (const summary of await backend.publishedPosts()) {
    const post = await backend.post(summary.slug)
    if (/^```[a-z]+/m.test(post.content)) return post.slug
  }
  return null
}

test.describe('Code block: copy button', () => {
  test('copies the exact text of the block by keyboard, announces through status then reverts; the button does not cover the first code line', async ({
    page,
    context,
    backend,
    baseURL,
  }, testInfo) => {
    const slug = await postWithCode(backend)
    test.skip(slug === null, 'no published post has a code block with a language')
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL })
    await page.goto(localePath(`/posts/${slug}`))

    const block = page
      .locator('[data-code-block]')
      .filter({ has: page.locator('pre.shiki') })
      .first()
    const pre = block.locator(':scope > pre')
    const button = block.getByRole('button', { name: msg('Site.code.copy'), exact: true })
    await expect(button).toBeVisible()

    // Size by viewport: 44px on a phone (the whole height of the strip above the code), 32px from 640px.
    const box = (await button.boundingBox())!
    const side = testInfo.project.name === 'mobile' ? 44 : 32
    expect(Math.round(box.width)).toBe(side)
    expect(Math.round(box.height)).toBe(side)
    // Inside the strip at the top of the block (the <pre> padding-top, globals.css): the button's bottom is above the first code line,
    // so a long line scrolling horizontally never slides underneath it.
    const firstLine = (await pre.locator('code > .line').first().boundingBox())!
    expect(box.y + box.height).toBeLessThanOrEqual(firstLine.y)
    // And within the right edge of the block: does not push the page into horizontal overflow.
    const frame = (await block.boundingBox())!
    expect(box.x + box.width).toBeLessThanOrEqual(frame.x + frame.width + 0.5)

    // Keyboard: Shiki's <pre> receives Tab (to scroll horizontally), the button comes right after it.
    await pre.focus()
    await page.keyboard.press('Tab')
    await expect(button).toBeFocused()
    await page.keyboard.press('Enter')

    const status = block.getByRole('status')
    await expect(status).toHaveText(msg('Site.code.copied'))
    await expect(button).toHaveAttribute('data-state', 'copied')
    const expected = await pre.evaluate((node) => node.textContent)
    expect(expected?.length, 'the code block has text').toBeGreaterThan(0)
    // The Windows clipboard returns CRLF when read back even though the button wrote LF: compare after normalizing to LF.
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    expect(copied.replace(/\r\n/g, '\n')).toBe(expected)

    // The check mark stays about two seconds, then the button returns to the copy icon, and status returns to empty.
    await expect(button).toHaveAttribute('data-state', 'idle', { timeout: 5_000 })
    await expect(status).toHaveText('')
    // The name does not change across states.
    await expect(button).toHaveAccessibleName(msg('Site.code.copy'))
  })
})

/**
 * Printing a post: the site frame and everything clickable are not printed; code blocks wrap instead of
 * scrolling, and the strip reserved for the copy button (which is not printed) returns to normal padding. Light theme when printing: ThemeToggle switches
 * data-theme at `beforeprint` and restores it at `afterprint`. `emulateMedia` does not fire those two events (only Ctrl+P
 * and window.print() do), so the test fires them by hand — exactly what the browser does before and after the print dialog.
 */
test.describe('Print', () => {
  test('only the post remains; code blocks wrap, the copy button strip is gone; a dark page prints light then reverts', async ({
    page,
    backend,
    isMobile,
  }) => {
    const slug = await postWithCode(backend)
    test.skip(slug === null, 'no published post has a code block with a language')
    await page.addInitScript(() => window.localStorage.setItem('theme', 'dark'))
    await page.goto(localePath(`/posts/${slug}`))
    const root = page.locator('html')
    await expect(root).toHaveAttribute('data-theme', 'dark')

    // On screen both rails, the hero's action group (Copy link, Share, Next) and its Subscribe link exist, and the frame draws its side
    // borders (the print assertions below would otherwise pass for things that were never there).
    const hero = page.locator('[data-reader-hero]')
    const heroActions = hero.getByRole('group', { name: msg('Site.reader.actionsLabel') })
    const subscribe = hero.getByRole('link', { name: msg('Site.reader.subscribe') })
    await expect(page.getByRole('complementary', { name: msg('Site.reader.leftLabel') })).toBeVisible()
    await expect(page.getByRole('complementary', { name: msg('Site.reader.railLabel') })).toBeVisible()
    await expect(heroActions).toBeVisible()
    // Subscribe is drawn from `sm`: the author row of a phone is the name alone (`max-sm:hidden`), so there it is not on screen to begin
    // with. The print loop below asserts it hidden at every width.
    if (isMobile) await expect(subscribe).toBeHidden()
    else await expect(subscribe).toBeVisible()
    // The side borders exist from a 1424px window (`--breakpoint-frame`); the phone project has none to lose.
    const bordered = await page.evaluate(() => window.innerWidth >= 1424)
    await expect(page.locator('#main-content')).toHaveCSS('border-left-width', bordered ? '1px' : '0px')
    await expect(page.locator('#main-content')).toHaveCSS('border-right-width', bordered ? '1px' : '0px')

    await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')))
    await expect(root).toHaveAttribute('data-theme', 'light')
    await page.emulateMedia({ media: 'print' })

    // The printed post is complete: title and body.
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.locator('article .prose')).toBeVisible()
    // The hero (title, meta, author name) prints; its buttons do not, and the 1400px frame loses its side borders.
    await expect(hero).toBeVisible()
    await expect(page.locator('#main-content')).toHaveCSS('border-left-width', '0px')
    await expect(page.locator('#main-content')).toHaveCSS('border-right-width', '0px')
    // The site frame and everything clickable are not.
    for (const hidden of [
      page.getByRole('banner'),
      page.getByRole('contentinfo'),
      page.getByRole('list', { name: msg('Site.share.label') }),
      page.locator('#luot-thich'),
      page.locator('#luu-bai'),
      page.locator('#binh-luan'),
      page.locator('nav[aria-labelledby="muc-luc"]'),
      // The three-column reader: both rails (the left navigation, the reading tools with the table of contents) and the
      // reading progress bar are screen furniture. The bar is aria-hidden and has no name, so it is found by its classes.
      page.getByRole('complementary', { name: msg('Site.reader.leftLabel') }),
      page.getByRole('complementary', { name: msg('Site.reader.railLabel') }),
      // The hero's action group (Copy link, Share, Next) and its Subscribe link are controls, not text.
      heroActions,
      subscribe,
      page.locator('div[aria-hidden="true"][class*="fixed"][class*="origin-left"]'),
    ]) {
      await expect(hidden).toBeHidden()
    }
    // The author box is part of the printed post, not furniture.
    await expect(page.locator('aside[aria-labelledby="tac-gia"]')).toBeVisible()
    // The back-to-top button: at the top of the page it is already hidden (visibility), so check exactly what print:hidden puts
    // on its fixed frame.
    const backToTop = page.getByRole('button', { name: msg('Site.shell.backToTop'), includeHidden: true })
    await expect(backToTop.locator('..')).toHaveCSS('display', 'none')

    const block = page
      .locator('[data-code-block]')
      .filter({ has: page.locator('pre.shiki') })
      .first()
    const pre = block.locator(':scope > pre')
    await expect(pre).toHaveCSS('white-space', 'pre-wrap')
    await expect(pre).toHaveCSS('padding-top', '16px')
    await expect(block.getByRole('button', { name: msg('Site.code.copy'), includeHidden: true })).toBeHidden()
    // No line is cut off at the edge of the block: text wraps, the block needs no scrolling.
    expect(await pre.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1)

    await page.emulateMedia({ media: 'screen' })
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')))
    await expect(root).toHaveAttribute('data-theme', 'dark')
    await expect(page.getByRole('banner')).toBeVisible()
    await expect(backToTop.locator('..')).not.toHaveCSS('display', 'none')
  })
})
