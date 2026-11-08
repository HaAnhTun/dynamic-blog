import type { Page } from '@playwright/test'
import { deleteFromGallery, loginAsAdmin, uploadToGallery } from './support/admin'
import { expect, test } from './support/fixtures'
import { smallPhoto } from './support/photos'
import { msg, applyLocale } from './support/i18n'
import { setViewport } from './support/reader'

/**
 * The /gallery lightbox and the justified rows. The lightbox needs at least two photos to flip through and the rows need four to
 * have a row to break (the spec never skips for lack of photos: a skipped case measures nothing on exactly the stacks CI uses); the QA stack
 * has them already, while a stack freshly built from the README has no photos — then the missing small photos are temporarily uploaded via
 * /admin/gallery (so the Server Action refreshes the page cache) and exactly those are deleted when done. They are mostly 4:3 landscapes, the
 * most common camera ratio and the one whose rows break at a different place in two neighbouring windows (three photos on a row at 1279px,
 * two at 1280px), and one 3:4 portrait.
 */
let provisioned: string[] = []

/** The photos a stack needs for the rows of /gallery to have something to break. */
const PHOTOS_WANTED = 4
/** Width and height of the temporary photos, in upload order. */
const TEMPORARY_SIZES = [
  [1200, 900],
  [1200, 900],
  [900, 1200],
  [1200, 900],
] as const

test.beforeAll(async ({ browser, backend }, testInfo) => {
  const missing = PHOTOS_WANTED - (await backend.gallery()).length
  if (missing <= 0) return
  // JavaScript explicitly on: a hand-made context still receives the `use` of the running test group, and the
  // no-JavaScript group turns it off — the sign-in form would then submit as a plain GET, the password in the URL, no sign-in.
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL, javaScriptEnabled: true })
  try {
    await applyLocale(context)
    const page = await context.newPage()
    await loginAsAdmin(page)
    const stamp = Date.now()
    const alts = Array.from({ length: missing }, (_, index) => `E2E temporary photo ${stamp}-${index}`)
    const files = await Promise.all(
      alts.map(async (_, index) => ({
        name: `e2e-tam-${index}.jpg`,
        mimeType: 'image/jpeg',
        buffer: await smallPhoto(index % 2 === 0 ? '#4a7ab5' : '#b5654a', ...TEMPORARY_SIZES[index % TEMPORARY_SIZES.length]),
      })),
    )
    await uploadToGallery(
      page,
      files,
      alts.map((altText) => ({ altText, caption: 'E2E temporary photo' })),
    )
    provisioned = alts
  } finally {
    await context.close()
  }
})

test.afterAll(async ({ browser }, testInfo) => {
  if (provisioned.length === 0) return
  // JavaScript explicitly on: a hand-made context still receives the `use` of the running test group, and the
  // no-JavaScript group turns it off — the sign-in form would then submit as a plain GET, the password in the URL, no sign-in.
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL, javaScriptEnabled: true })
  try {
    await applyLocale(context)
    const page = await context.newPage()
    await loginAsAdmin(page)
    for (const altText of provisioned) await deleteFromGallery(page, altText)
    provisioned = []
  } finally {
    await context.close()
  }
})

async function openGallery(page: Page) {
  await page.goto('/gallery')
  const tiles = page.locator('a[data-gallery-index]')
  await expect(tiles.nth(1)).toBeVisible()
  const dialog = page.getByRole('dialog')
  return { tiles, count: await tiles.count(), dialog, counter: dialog.getByText(/^\d+ \/ \d+$/) }
}

test.describe('Lightbox', () => {
  test('keyboard: Enter opens from a cell, → ← change photo and counter, Esc closes and returns focus to the cell', async ({
    page,
    backend,
  }) => {
    const { tiles, count, dialog, counter } = await openGallery(page)
    const first = tiles.nth(0)

    await first.focus()
    await page.keyboard.press('Enter')
    await expect(dialog).toBeVisible()
    await expect(dialog).toHaveAccessibleName(msg('Site.gallery.dialogLabel', { index: 1, total: count }))
    await expect(dialog.getByRole('button', { name: msg('Site.gallery.close') })).toBeFocused()
    await expect(counter).toHaveText(`1 / ${count}`)
    await expect(dialog.getByRole('img')).toHaveAttribute('alt', (await first.getByRole('img').getAttribute('alt'))!)
    // The page behind does not scroll while the box is open (rule `html:has(dialog[open]:modal)`).
    await expect(page.locator('html')).toHaveCSS('overflow', 'hidden')

    // Caption: caption · capture date, the date formatted in Vietnamese by UTC.
    const photo = (await backend.gallery())[0]
    const caption = dialog.locator('figcaption')
    if (photo.caption) await expect(caption).toContainText(photo.caption)
    if (photo.takenOn) {
      const expected = await page.evaluate(
        (iso) => new Intl.DateTimeFormat('vi-VN', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(iso)),
        photo.takenOn,
      )
      await expect(caption.locator(`time[datetime="${photo.takenOn}"]`)).toHaveText(expected)
    }

    await page.keyboard.press('ArrowRight')
    await expect(counter).toHaveText(`2 / ${count}`)
    await expect(dialog).toHaveAccessibleName(msg('Site.gallery.dialogLabel', { index: 2, total: count }))
    await expect(dialog.getByRole('img')).toHaveAttribute('alt', (await tiles.nth(1).getByRole('img').getAttribute('alt'))!)

    // Wrap-around within the page: from photo 1, one step back is the last photo.
    await page.keyboard.press('ArrowLeft')
    await expect(counter).toHaveText(`1 / ${count}`)
    await page.keyboard.press('ArrowLeft')
    await expect(counter).toHaveText(`${count} / ${count}`)

    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(first).toBeFocused()
    await expect(page.locator('html')).not.toHaveCSS('overflow', 'hidden')
  })

  test('clicking (tapping) a cell opens the lightbox; "Next photo" flips; "Close" returns focus to the cell that was opened', async ({
    page,
    isMobile,
  }) => {
    const { tiles, count, dialog, counter } = await openGallery(page)
    const opener = tiles.nth(1)

    if (isMobile) await opener.tap()
    else await opener.click()
    await expect(dialog).toBeVisible()
    await expect(counter).toHaveText(`2 / ${count}`)
    // Clicking does not navigate: the link stays at /gallery (event delegation prevents the default).
    await expect(page).toHaveURL(/\/gallery$/)

    await dialog.getByRole('button', { name: msg('Site.gallery.next') }).click()
    await expect(counter).toHaveText(`${(2 % count) + 1} / ${count}`)
    await dialog.getByRole('button', { name: msg('Site.gallery.close') }).click()
    await expect(dialog).toBeHidden()
    await expect(opener).toBeFocused()
  })

  test('phone: a swipe left flips to the next photo, a vertical swipe does not flip', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Swiping is a touch gesture, only the mobile project has hasTouch')
    const { tiles, count, dialog, counter } = await openGallery(page)
    await tiles.nth(0).tap()
    await expect(counter).toHaveText(`1 / ${count}`)

    // Playwright has no swipe API: send a touch sequence through CDP, and Chrome generates the 'touch' pointer events itself.
    const cdp = await page.context().newCDPSession(page)
    const box = (await dialog.boundingBox())!
    const y = box.y + box.height / 2
    const swipe = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] })
      for (let step = 1; step <= 5; step += 1) {
        const point = { x: from.x + ((to.x - from.x) * step) / 5, y: from.y + ((to.y - from.y) * step) / 5 }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point] })
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    }

    await swipe({ x: box.x + box.width * 0.8, y }, { x: box.x + box.width * 0.2, y })
    await expect(counter).toHaveText(`2 / ${count}`)
    await expect(dialog).toBeVisible()

    await swipe({ x: box.x + box.width / 2, y: y - 120 }, { x: box.x + box.width / 2 + 20, y: y + 120 })
    await expect(counter).toHaveText(`2 / ${count}`)
    // One more sure step afterwards: if the vertical swipe had flipped the photo (even late), the counter would be off here.
    await page.keyboard.press('ArrowRight')
    await expect(counter).toHaveText(`${(2 % count) + 1} / ${count}`)
  })
})

test.describe('Without JavaScript', () => {
  test.use({ javaScriptEnabled: false })

  test('a photo cell is a real link to the original file', async ({ page }) => {
    await page.goto('/gallery')
    const tile = page.locator('a[data-gallery-index]').first()
    const href = await tile.getAttribute('href')
    expect(href).toMatch(/^\/media\/[0-9a-f-]{36}\.(jpg|png)$/)
    const [response] = await Promise.all([page.waitForResponse((r) => r.url().endsWith(href!)), tile.click()])
    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toMatch(/^image\/(jpeg|png)$/)
  })
})

test.describe('Justified rows inside the frame', () => {
  /**
   * /gallery flows its photos in rows of equal height that keep each photo's own ratio (GalleryGrid, `layout="justified"`: wrapping flex,
   * no JavaScript), so the number of cells in a row is not fixed any more: it depends on the ratios and on the width of the column. What is
   * fixed is the geometry of every row, read here from the page, and the rule that breaks the rows: a row takes photos until the next one
   * would not fit. The number of photos on the first row is NOT compared between two windows: a wider window can have a narrower column
   * (the BROWSE grid and its padding grow at 1280px), and with it fewer photos on the first row.
   */
  type Cell = {
    index: number
    top: number
    left: number
    right: number
    width: number
    height: number
    /** The flex basis of the cell (ratio times the row height), resolved by the browser to pixels. */
    basis: number
    capped: boolean
  }
  async function rowsOf(page: Page): Promise<{ grid: { left: number; right: number; gap: number }; rows: Cell[][] }> {
    return page.locator('a[data-gallery-index]').evaluateAll((links) => {
      const list = links[0].closest('ul')!
      const grid = list.getBoundingClientRect()
      const cells = links.map((link) => {
        const item = link.closest('li')!
        const box = item.getBoundingClientRect()
        const frame = (link.firstElementChild as HTMLElement).getBoundingClientRect()
        const style = getComputedStyle(item)
        return {
          index: Number(link.getAttribute('data-gallery-index')),
          top: box.top,
          left: box.left,
          right: box.right,
          width: frame.width,
          height: frame.height,
          basis: parseFloat(style.flexBasis),
          // A cell stops growing at its max-width (a portrait, or a landscape from sm): its row may then end short of the column edge.
          capped: Math.abs(box.width - parseFloat(style.maxWidth)) < 1,
        }
      })
      const rows: (typeof cells)[] = []
      for (const cell of cells) {
        const row = rows.find((candidate) => Math.abs(candidate[0].top - cell.top) <= 2)
        if (row) row.push(cell)
        else rows.push([cell])
      }
      return { grid: { left: grid.left, right: grid.right, gap: parseFloat(getComputedStyle(list).columnGap) }, rows }
    })
  }

  test('every row has one height and fills the column, each cell keeps its photo ratio, and no row left room for the next photo', async ({
    page,
    isMobile,
    backend,
  }) => {
    await page.goto('/gallery')
    const tiles = page.locator('a[data-gallery-index]')
    await expect(tiles.first()).toBeVisible()
    expect(await tiles.count(), 'four photos at least: the rows have something to break').toBeGreaterThanOrEqual(PHOTOS_WANTED)
    // The ratio the grid gives a photo (GalleryGrid `layoutRatio`: clamped to 0.5 to 2.5, 1 for an unknown size), by the position of the photo
    // in the API order, which is the order of the page (`data-gallery-index`): two photos with the same or an empty description do not mix.
    const ratios = (await backend.gallery()).map(({ image }) =>
      image.width > 0 && image.height > 0 ? Math.min(Math.max(image.width / image.height, 0.5), 2.5) : 1,
    )

    // The phone project is one window of 390px; the desktop project walks the windows around the 1280px step of the site frame.
    for (const width of isMobile ? [390] : [1100, 1279, 1280, 1440, 1920]) {
      if (!isMobile) await setViewport(page, width, 900)
      // Rows are laid out after the fonts and the first images (the frames hold their ratio from the HTML, so the layout does not wait for them).
      await expect.poll(async () => (await rowsOf(page)).rows.length, { message: `rows at ${width}px` }).toBeGreaterThan(0)
      const { grid, rows } = await rowsOf(page)
      const label = `${width}px`
      const column = grid.right - grid.left
      for (const [index, row] of rows.entries()) {
        const heights = row.map((cell) => cell.height)
        expect(
          Math.max(...heights) - Math.min(...heights),
          `${label}, row ${index}: the cells share one height (${heights.join(', ')})`,
        ).toBeLessThanOrEqual(2)
        for (const cell of row) {
          expect(cell.left, `${label}, row ${index}: a cell starts inside the column`).toBeGreaterThanOrEqual(grid.left - 1)
          expect(cell.right, `${label}, row ${index}: a cell ends inside the column`).toBeLessThanOrEqual(grid.right + 1)
          const ratio = ratios[cell.index]
          if (ratio !== undefined)
            expect(cell.width / cell.height, `${label}, row ${index}: photo ${cell.index} keeps its ratio`).toBeCloseTo(ratio, 1)
        }
        // Every row but the last is justified: it spans the column from edge to edge, unless a cell has hit its own max-width.
        if (index < rows.length - 1 && !row.some((cell) => cell.capped)) {
          expect(row[0].left, `${label}, row ${index}: starts at the left edge of the column`).toBeCloseTo(grid.left, 0)
          expect(row.at(-1)!.right, `${label}, row ${index}: ends at the right edge of the column`).toBeCloseTo(grid.right, 0)
        }
        // The rule that breaks a row, for every row but the last: the first photo of the next row would not have fitted. The bases of the
        // row, a gap after each of them (the last one is the gap before the next photo) and the basis of that photo add up to more than
        // the column. Read from the browser (the flex basis of each cell and the gap of the list), so it holds at any width and for any ratios.
        if (index < rows.length - 1) {
          const next = rows[index + 1][0]
          expect(Number.isFinite(next.basis), `${label}, row ${index + 1}: the flex basis of the first photo was read`).toBe(true)
          const needed = row.reduce((sum, cell) => sum + cell.basis + grid.gap, 0) + next.basis
          expect(
            needed,
            `${label}, row ${index}: photo ${next.index} would have fitted (${Math.round(needed)}px of ${Math.round(column)}px), so it belongs on this row`,
          ).toBeGreaterThan(column - 0.5)
        }
      }
    }
  })
})
