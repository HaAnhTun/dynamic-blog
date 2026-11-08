import type { Page } from '@playwright/test'
import { createTemporaryPost, removeTemporaryPost, type TemporaryPost } from './support/admin'
import type { Backend } from './support/backend'
import { expect, test } from './support/fixtures'
import { localePath, msg } from './support/i18n'
import { openLeftRail, seriesLandmark, seriesNav } from './support/left-rail'
import {
  centreOf,
  createPublishedPost,
  edgesOf,
  expectNoPageOverflow,
  FRAME_BORDER_FROM,
  findPostWithHeadings,
  focusIsFirstIn,
  frameGeometry,
  headerHeight,
  longPostContent,
  openPost,
  outlineAndScroller,
  READER_FRAME_MAX,
  reader,
  readProgress,
  scrollYForProgress,
  setViewport,
  settle,
  tabTo,
  unionOf,
  visibleHeaderHeight,
  walkTabStops,
  widthOf,
  type Edges,
  type FrameGeometry,
} from './support/reader'

/**
 * The reading layout of a post (the post page design spec, round 2, section 9.4): one bordered 1400px frame that holds the header
 * bar, the page and the footer; inside it a full-height left sidebar (260px), the article column and the right column (230px), with
 * the hero block spanning the article and the right column. Cases (a) to (s) carry the letters of the spec.
 *
 * Every width is a function of `C = document.documentElement.clientWidth` (a classic scrollbar takes about 15px, headless Chromium may
 * take none): the frame is `min(1400, C)`, the body column is the frame minus its borders minus the two rails. A literal such as 908 is
 * only the example at a 1440 window with a 1400px frame, never an assertion.
 *
 * Projects. `desktop` (1440x900) resizes its window with `setViewportSize` for every width of 500px and more; `mobile` (390x844,
 * isMobile emulation) runs only the 390 cases: a headless Chrome window cannot be narrower than 500px, so a phone is always emulated.
 * A case that has no meaning in a project says so with `test.skip` and a reason.
 *
 * The measured elements are the hooks of the page (e2e/support/reader.ts): `#main-content` (the frame), `[data-reader-grid]`,
 * `[data-reader-hero]`, `[data-reader-body]`, `[data-post-body]`, `aside[aria-label]`, `[data-rail-sticky]`, `[data-rail-phone]`, and the
 * `div` child of the banner and of the contentinfo landmark (the Containers of the site header and footer).
 * Text comes from the catalogs (`msg`), so the spec runs with `E2E_LOCALE=vi` and `en`.
 */

/** The longest post of the sample data (a table of contents, more than four screens): the same one the other specs use. */
const LONG_POST = '/posts/khi-nao-nen-them-mot-queue'

/** The sample series: at least three parts, so there is a middle part with a previous and a next part. */
const SERIES_SLUG = 'xay-blog-nay'

/** The two project names of playwright.config.ts. */
const isMobile = (project: string) => project === 'mobile'

/** The widths a project can run: the phone only at 390 (emulated), the desktop project at every width of 500px and more. */
function widthsFor(project: string, desktop: number[]): number[] {
  return isMobile(project) ? [390] : desktop
}

/** Move to a width: the desktop project resizes its window, the mobile project is already 390 wide. */
async function atWidth(page: Page, project: string, width: number, height?: number): Promise<void> {
  if (isMobile(project)) {
    expect(width, 'the mobile project only runs the phone width').toBe(390)
    await settle(page)
    return
  }
  await setViewport(page, width, height)
}

/** `actual` is within `tolerance` of `expected`; the message prints both numbers. */
function expectNear(actual: number, expected: number, tolerance: number, what: string): void {
  expect(Math.abs(actual - expected), `${what}: ${actual} against ${expected} (tolerance ${tolerance})`).toBeLessThanOrEqual(
    tolerance,
  )
}

/**
 * The like, save and share controls as one box: the "actions toolbar" below the right-rail breakpoint, the lower part of the rail above it.
 * The share control is the icon list from `sm` and the Share menu (a closed `<details>`, the one that follows the save button) below it.
 */
async function toolbarEdges(page: Page, phone: boolean): Promise<Edges> {
  const parts = [
    page.locator('#luot-thich').first(),
    page.locator('#luu-bai').first(),
    phone ? page.locator('#luu-bai ~ div details').first() : page.locator('ul[aria-labelledby="chia-se"]').first(),
  ]
  for (const part of parts) await expect(part).toBeVisible()
  return unionOf(await Promise.all(parts.map((part) => edgesOf(part))))
}

/** The middle part of the sample series, or null (the case then skips with a reason). */
async function seriesMiddle(backend: Backend) {
  const series = await backend.series(SERIES_SLUG)
  if (!series || series.posts.length < 3) return null
  return { series, parts: series.posts, current: series.posts[1] }
}

/**
 * Frame, header Container and footer Container line up: the frame is `min(1400, C)` wide and centred on the client axis; the header and
 * footer Containers have the same OUTER left and right edges (+-1); from the `frame:` breakpoint (1424px window) all three have a 1px
 * side border, below it none. Returns the frame width and whether the borders are drawn, for the column arithmetic.
 */
function expectFrameAligned(g: FrameGeometry, label: string): { width: number; borders: number } {
  const width = Math.min(READER_FRAME_MAX, g.clientWidth)
  const borders = g.innerWidth >= FRAME_BORDER_FROM ? 1 : 0
  const frame = g.frame.edges
  expectNear(widthOf(frame), width, 1, `${label}: frame width`)
  expectNear(centreOf(frame), g.clientWidth / 2, 1, `${label}: frame centre against the client axis`)
  for (const [name, box] of [
    ['header', g.header],
    ['footer', g.footer],
  ] as const) {
    expectNear(box.edges.left, frame.left, 1, `${label}: ${name} Container left edge against the frame`)
    expectNear(box.edges.right, frame.right, 1, `${label}: ${name} Container right edge against the frame`)
  }
  for (const [name, box] of [
    ['frame', g.frame],
    ['header', g.header],
    ['footer', g.footer],
  ] as const) {
    expect(box.borderLeft, `${label}: ${name} left border`).toBe(borders)
    expect(box.borderRight, `${label}: ${name} right border`).toBe(borders)
  }
  return { width, borders }
}

type Tracks = { left: number; right: number | null }

/**
 * The columns of the reader grid inside the frame: the left sidebar, the body column and the right column, and the hero over the last
 * two. `right: null` is the two-column layout (no right column: the article takes the rest and the toolbar sits under the body).
 */
async function expectColumns(page: Page, tracks: Tracks, tolerance: number, label: string): Promise<void> {
  const g = await frameGeometry(page)
  const { left, article, hero, column, rail } = reader(page)
  const inner = widthOf(g.frame.edges) - g.frame.borderLeft - g.frame.borderRight
  const frameRight = g.frame.edges.right - g.frame.borderRight
  const leftBox = await edgesOf(left)
  const articleBox = await edgesOf(article)
  expectNear(widthOf(leftBox), tracks.left, tolerance, `${label}: left sidebar width`)
  expectNear(leftBox.left, g.frame.edges.left + g.frame.borderLeft, 1, `${label}: left sidebar starts at the frame's inner edge`)
  if (tracks.right === null) {
    expectNear(widthOf(articleBox), inner - tracks.left, tolerance, `${label}: article width`)
    expectNear(articleBox.right, frameRight, 1, `${label}: article ends at the frame edge (no centring)`)
    return
  }
  const [railBox, columnBox, heroBox] = [await edgesOf(rail), await edgesOf(column), await edgesOf(hero)]
  expectNear(widthOf(railBox), tracks.right, tolerance, `${label}: right column width`)
  expectNear(widthOf(columnBox), inner - tracks.left - tracks.right, tolerance, `${label}: body column width`)
  expectNear(widthOf(heroBox), widthOf(columnBox) + widthOf(railBox), tolerance, `${label}: hero spans body + right column`)
  expectNear(heroBox.left, columnBox.left, 1, `${label}: hero left edge against the body column`)
  expectNear(heroBox.right, railBox.right, 1, `${label}: hero right edge against the right column`)
  expectNear(railBox.right, frameRight, 1, `${label}: right column ends at the frame edge`)
  expect(leftBox.right, `${label}: sidebar ends before the body`).toBeLessThanOrEqual(columnBox.left + 0.5)
  expect(columnBox.right, `${label}: body ends before the right column`).toBeLessThanOrEqual(railBox.left + 0.5)
}

/** The widest paragraph of the post text and the width of the body it sits in, in CSS px: the text fills its column. */
async function paragraphAndBody(page: Page): Promise<{ widest: number; body: number }> {
  return page.evaluate(() => {
    const body = document.querySelector('[data-post-body]')
    return {
      widest: Math.max(
        0,
        ...[...document.querySelectorAll('[data-post-body] > p')].map((node) => node.getBoundingClientRect().width),
      ),
      body: body === null ? 0 : body.getBoundingClientRect().width,
    }
  })
}

test.describe('Post layout: frame, columns and order', () => {
  test('(a) 1440 and 1920: one 1400px frame, header and footer on its edges, columns 260 / fluid / 230, hero over the last two', async ({
    page,
  }, testInfo) => {
    test.skip(isMobile(testInfo.project.name), 'three columns exist only on a desktop window')
    await openPost(page, localePath(LONG_POST))
    for (const width of [1440, 1920]) {
      await setViewport(page, width)
      const label = `${width}px`
      const { left, leftSticky, railSticky, article, end } = reader(page)
      await expect(leftSticky, label).toBeVisible()
      await expect(railSticky, label).toBeVisible()
      await expect(article, label).toBeVisible()
      // The phone-sized copy of the sidebar (the closed card) is not displayed from the `lg` breakpoint.
      await expect(left.locator('details[data-rail-phone]'), label).toBeHidden()

      const g = await frameGeometry(page)
      const { width: frameWidth, borders } = expectFrameAligned(g, label)
      expect(frameWidth, `${label}: the frame is at its 1400px cap`).toBe(READER_FRAME_MAX)
      expect(borders, `${label}: the frame draws its side borders`).toBe(1)
      await expectColumns(page, { left: 260, right: 230 }, 1, label)

      // The sidebar is a full-height column: it starts where the hero starts, it runs to the bottom of the end blocks, and its inner
      // edge carries a 1px hairline.
      const [leftBox, heroBox, endBox] = [await edgesOf(left), await edgesOf(reader(page).hero), await edgesOf(end)]
      expectNear(leftBox.top, heroBox.top, 1, `${label}: sidebar top against hero top`)
      expect(leftBox.bottom, `${label}: sidebar runs to the bottom of the end blocks`).toBeGreaterThanOrEqual(endBox.bottom - 1)
      await expect(left, `${label}: sidebar inner hairline`).toHaveCSS('border-inline-end-width', '1px')
      await expect(reader(page).rail, `${label}: right column inner hairline`).toHaveCSS('border-inline-start-width', '1px')

      // Space under the end blocks: at least 40px before the discovery band (when the post has one) or the frame's bottom, and no
      // gap between the frame and the footer, so the side hairlines run unbroken into the footer.
      const discovery = reader(page).discovery
      const nextTop = (await discovery.count()) > 0 ? (await edgesOf(discovery)).top : g.frame.edges.bottom
      // The end slot's own box includes its bottom padding, so the gap is measured from the last CHILD that has a box.
      const lastBlockBottom = await end.evaluate((node) =>
        Math.max(
          ...[...node.children]
            .map((child) => child.getBoundingClientRect())
            .filter((box) => box.height > 0)
            .map((box) => box.bottom),
        ),
      )
      expect(nextTop - lastBlockBottom, `${label}: space under the last end block`).toBeGreaterThanOrEqual(40 - 1)
      expectNear(g.footer.edges.top, g.frame.edges.bottom, 1, `${label}: footer starts where the frame ends`)
      await expectNoPageOverflow(page, label)
    }
  })

  test('(a) 1280 and 1100: the frame is the window, columns 260 / C-490 / 230 and 224 / C-432 / 208, no side borders', async ({
    page,
  }, testInfo) => {
    test.skip(isMobile(testInfo.project.name), 'three columns exist only on a desktop window')
    await openPost(page, localePath(LONG_POST))
    for (const [width, tracks] of [
      [1280, { left: 260, right: 230 }],
      [1100, { left: 224, right: 208 }],
    ] as const) {
      await setViewport(page, width)
      const label = `${width}px`
      const g = await frameGeometry(page)
      const aligned = expectFrameAligned(g, label)
      expect(aligned.borders, `${label}: no side borders under the frame breakpoint`).toBe(0)
      expectNear(aligned.width, g.clientWidth, 0, `${label}: the frame is the client width`)
      await expectColumns(page, tracks, 2, label)
      await expectNoPageOverflow(page, label)
    }
  })

  test('(b) 1024: sidebar 224 and the article beside it, no right column, the frame has the header edges', async ({
    page,
  }, testInfo) => {
    test.skip(isMobile(testInfo.project.name), 'a 1024px window cannot be emulated by the phone project')
    await openPost(page, localePath(LONG_POST))
    await setViewport(page, 1024)
    const { left, rail, leftSticky, article, column, hero } = reader(page)

    await expect(leftSticky).toBeVisible()
    const g = await frameGeometry(page)
    expectFrameAligned(g, '1024px')
    await expectColumns(page, { left: 224, right: null }, 1, '1024px')

    const [leftBox, articleBox, railBox, columnBox, heroBox] = await Promise.all(
      [left, article, rail, column, hero].map((locator) => edgesOf(locator)),
    )
    expect(leftBox.right, 'sidebar beside the article').toBeLessThanOrEqual(articleBox.left + 0.5)
    expectNear(leftBox.top, heroBox.top, 1, 'sidebar starts at the top of the article row')
    // No right column: the hero and the body column are one column wide, and the toolbar (the right aside) sits under the body.
    expectNear(widthOf(heroBox), widthOf(columnBox), 1, 'hero as wide as the body column')
    expect(railBox.top, 'toolbar under the body column').toBeGreaterThanOrEqual(columnBox.bottom - 0.5)
    const inlineToc = column.getByRole('navigation', { name: msg('Site.article.toc') })
    await expect(inlineToc.locator('details')).toBeVisible()
    await expect(inlineToc.locator('details')).not.toHaveAttribute('open')
    await expect(rail.getByRole('navigation', { name: msg('Site.article.toc') })).toHaveCount(0)
    await expectNoPageOverflow(page, '1024')
  })

  test('(c) 768 and 390: one column, frame, header and footer equal the window, the sidebar card, hero and body start at the frame edge', async ({
    page,
  }, testInfo) => {
    const project = testInfo.project.name
    await openPost(page, localePath(LONG_POST))
    for (const width of widthsFor(project, [768])) {
      await atWidth(page, project, width)
      const { left, rail, hero, column } = reader(page)
      const label = `${width}px`
      const g = await frameGeometry(page)
      const aligned = expectFrameAligned(g, label)
      expect(aligned.borders, `${label}: no side borders`).toBe(0)
      expectNear(aligned.width, g.clientWidth, 0, `${label}: the frame is the client width`)

      const frame = g.frame.edges
      const [leftBox, heroBox, columnBox, railBox] = await Promise.all(
        [left, hero, column, rail].map((locator) => edgesOf(locator)),
      )
      expectNear(leftBox.left, frame.left, 1, `${label}: sidebar card at the frame edge`)
      expectNear(heroBox.left, frame.left, 1, `${label}: hero at the frame edge`)
      expectNear(columnBox.left, frame.left, 1, `${label}: body at the frame edge`)
      expectNear(widthOf(heroBox), widthOf(frame), 1, `${label}: hero as wide as the frame`)
      const text = await paragraphAndBody(page)
      expect(text.body, `${label}: the post body is laid out`).toBeGreaterThan(0)
      expectNear(text.widest, text.body, 1, `${label}: paragraphs fill the body column`)
      // One column: the closed sidebar card, then the hero, then the body, then the toolbar.
      expect(leftBox.bottom, `${label}: sidebar card above the hero`).toBeLessThanOrEqual(heroBox.top + 0.5)
      expect(heroBox.bottom, `${label}: hero above the body`).toBeLessThanOrEqual(columnBox.top + 0.5)
      expect(railBox.top, `${label}: toolbar below the body`).toBeGreaterThanOrEqual(columnBox.bottom - 0.5)
      await expectNoPageOverflow(page, label)
    }
  })

  test('(d) sticky: the sidebar sticks at the visible header height, the right column 24px lower, with the header shown and hidden', async ({
    page,
  }, testInfo) => {
    test.skip(isMobile(testInfo.project.name), 'the rails stick only on a desktop window')
    await openPost(page, localePath(LONG_POST))
    for (const width of [1440, 1100]) {
      await setViewport(page, width)
      const { leftSticky, railSticky } = reader(page)
      const stuck = async (label: string, visible: number) => {
        for (const [name, sticky, offset] of [
          ['sidebar', leftSticky, 0],
          ['right column', railSticky, 24],
        ] as const) {
          await expect(sticky, `${width}px ${label} ${name}`).toBeVisible()
          // The polled value is the distance of the top from the expected one, so a failure prints the real offset.
          await expect
            .poll(async () => Math.abs((await edgesOf(sticky)).top - (visible + offset)), {
              message: `${width}px ${label} ${name}: distance of the top from ${visible + offset}`,
            })
            .toBeLessThanOrEqual(1)
          expect((await edgesOf(sticky)).bottom, `${width}px ${label} ${name} inside the window`).toBeLessThanOrEqual(900 + 0.5)
        }
      }

      // Header SHOWN: scroll down, then up by a few px (the header comes back at once). The sticky tops equal the measured header height.
      await page.evaluate(() => window.scrollTo(0, 1500))
      await settle(page)
      await page.evaluate(() => window.scrollTo(0, 1400))
      await settle(page)
      const shown = await headerHeight(page)
      await expect.poll(() => visibleHeaderHeight(page), { message: 'the visible header height while shown' }).toBe(shown)
      await stuck('header shown:', shown)

      // Header HIDDEN: scroll down. `--site-header-visible-h` is 0px, the sidebar sticks at the window top, the right column at 24px,
      // and the first sidebar row is not clipped by the scroller.
      await page.evaluate(() => window.scrollTo(0, 3000))
      await settle(page)
      await expect.poll(() => visibleHeaderHeight(page), { message: 'the visible header height while hidden' }).toBe(0)
      await stuck('header hidden:', 0)
      const firstRow = await edgesOf(leftSticky.locator('a:visible').first())
      expect(firstRow.top, `${width}px: the first sidebar row is below the scroller's top edge`).toBeGreaterThanOrEqual(
        (await edgesOf(leftSticky)).top - 0.5,
      )
    }
  })

  test('(e) series post: numbered parts in order, the current part is not a link and has its own background, PostNav links the neighbours', async ({
    page,
    backend,
  }) => {
    const data = await seriesMiddle(backend)
    test.skip(data === null, `the sample series "${SERIES_SLUG}" with at least 3 published parts is not on this stack`)
    const { series, parts, current } = data!
    await openPost(page, localePath(`/posts/${current.slug}`))
    // At every width: on a phone the closed card is opened first (`[data-rail-phone] > summary`), from `lg` nothing is clicked.
    const landmark = await seriesLandmark(page, series.title)
    const group = await seriesNav(page, series.title)
    await expect(group).toContainText(msg('Site.seriesBlock.partOf', { current: 2, total: parts.length }))

    // The list is an <ol> of numbers 1..n in reading order (a windowed series of 8+ parts has "..." rows, so only its order is asserted).
    const list = landmark.locator('ol')
    const numbers = (await list.locator('[data-part-number]').allTextContents()).map((text) => Number(text.trim()))
    expect(numbers[0], 'the list starts at part 1').toBe(1)
    expect(numbers, 'numbers rise').toEqual([...numbers].sort((a, b) => a - b))
    if (numbers.length === parts.length) expect(numbers).toEqual(parts.map((_, index) => index + 1))

    const reading = list.locator('li[aria-current="true"]')
    await expect(reading).toHaveCount(1)
    await expect(reading).toContainText(current.title)
    await expect(reading.locator('[data-part-number]')).toHaveText('2')
    await expect(reading.getByRole('link')).toHaveCount(0)
    // The current row has the grey fill: its background differs from transparent and from a sibling link's.
    const fillOf = (row: typeof reading) =>
      row
        .locator(':scope > *')
        .first()
        .evaluate((node) => getComputedStyle(node).backgroundColor)
    const currentFill = await fillOf(reading)
    expect(currentFill, 'the current row has a background').not.toBe('rgba(0, 0, 0, 0)')
    expect(
      await fillOf(list.locator('li:not([aria-current]):not([aria-hidden])').first()),
      'a sibling row has a different background',
    ).not.toBe(currentFill)

    // The other parts are links, in reading order; the Overview row leads to the series page.
    await expect(landmark.getByRole('link', { name: parts[0].title })).toHaveAttribute(
      'href',
      localePath(`/posts/${parts[0].slug}`),
    )
    await expect(landmark.getByRole('link', { name: msg('Site.reader.seriesOverview') })).toHaveAttribute(
      'href',
      localePath(`/series/${series.slug}`),
    )

    const nav = page.getByRole('navigation', { name: msg('Site.postNav.navLabel') })
    await expect(
      nav.getByRole('link', { name: `${msg('Site.postNav.previousPart', { title: series.title })} ${parts[0].title}` }),
    ).toHaveAttribute('href', localePath(`/posts/${parts[0].slug}`))
    await expect(
      nav.getByRole('link', { name: `${msg('Site.postNav.nextPart', { title: series.title })} ${parts[2].title}` }),
    ).toHaveAttribute('href', localePath(`/posts/${parts[2].slug}`))
  })

  test('(f) progress: at 50% of the post body the bar scaleX or the meter text reads 40-60%', async ({ page }, testInfo) => {
    const project = testInfo.project.name
    await openPost(page, localePath(LONG_POST))
    for (const width of widthsFor(project, [1440, 1024])) {
      await atWidth(page, project, width)
      const { rail } = reader(page)
      await page.evaluate((top) => window.scrollTo(0, top), await scrollYForProgress(page, 0.5))
      // The polled value is the distance from 50%, so a failure prints how far the reading is (NaN when nothing could be read).
      await expect
        .poll(async () => Math.abs((await readProgress(rail)) - 0.5), {
          message: `${width}px: progress distance from 0.5 (bar below rail:, meter text from rail:)`,
        })
        .toBeLessThanOrEqual(0.1 + 1e-9)
    }
  })

  test('(g) keyboard: the Tab stops go skip links, sidebar, hero, article, right column, end blocks; like, save and share are reachable', async ({
    page,
  }, testInfo) => {
    const project = testInfo.project.name
    for (const width of widthsFor(project, [1440, 1024])) {
      await openPost(page, localePath(LONG_POST))
      await atWidth(page, project, width)
      const stops = await walkTabStops(page, 'end')
      const label = `${width}px`

      // The regions in the order focus visits them. The site header comes first and is filtered out; the hero is a `<header>` inside the
      // article and has its own region; the right column is an `aside` inside the article and has its own region.
      const order = stops.map((stop) => stop.region).filter((region, index, all) => index === 0 || region !== all[index - 1])
      expect(
        order.filter((region) => region !== 'header'),
        `${label}: ${stops.map((s) => `${s.region}:${s.label}`).join(' > ')}`,
      ).toEqual(['skip', 'left', 'hero', 'article', 'rail', 'end'])

      // Both skip links are Tab stops before the sidebar (the first two stops after the site's own).
      expect(stops.filter((stop) => stop.region === 'skip').length, `${label}: two post skip links`).toBe(2)
      // The hero holds the breadcrumb, the author row (Subscribe), the actions; every one comes after the sidebar and before the text.
      // Subscribe is drawn from `sm`: on a phone the author row is the name alone (`max-sm:hidden`, a7ae8e6c) and the stop must not exist.
      const heroStops = stops.filter((stop) => stop.region === 'hero')
      expect(
        heroStops.some((stop) => stop.label.includes(msg('Site.reader.subscribe').slice(0, 20))),
        `${label}: Subscribe is ${isMobile(project) ? 'not ' : ''}a hero stop (${heroStops.map((s) => s.label).join(' | ')})`,
      ).toBe(!isMobile(project))
      // What every width has: the Copy link button and the Share control are hero stops.
      for (const name of [msg('Site.share.copyLink'), msg('Site.share.label')]) {
        expect(
          heroStops.some((stop) => stop.label.includes(name)),
          `${label}: "${name}" is a hero stop (${heroStops.map((s) => s.label).join(' | ')})`,
        ).toBe(true)
      }

      // And that is the visual order: left of the article, then the article, then the rail (right of it, or below it under 1088px).
      const first = (region: string) => stops.find((stop) => stop.region === region)!
      if (width >= 1024) {
        expect(first('left').left, `${label}: sidebar stop is left of the article stop`).toBeLessThan(first('article').left)
        expect(first('left').left, `${label}: sidebar stop is left of the hero stop`).toBeLessThan(first('hero').left)
      }
      if (width >= 1100)
        expect(first('article').left, `${label}: article stop is left of the rail stop`).toBeLessThan(first('rail').left)
      else expect(first('rail').top, `${label}: toolbar stop is below the article stop`).toBeGreaterThan(first('article').top)

      expect(
        stops.some((stop) => stop.like),
        `${label}: like reachable by Tab`,
      ).toBe(true)
      expect(
        stops.some((stop) => stop.save),
        `${label}: save reachable by Tab`,
      ).toBe(true)
      // The share list is drawn from `sm`; on a phone the toolbar holds the Share menu in its place.
      expect(
        stops.some((stop) => (isMobile(project) ? stop.shareMenu : stop.share)),
        `${label}: share reachable by Tab`,
      ).toBe(true)
    }
  })

  /** Both skip links appear fixed without moving anything on the page. */
  const pageGeometry = (page: Page) =>
    page.evaluate(() =>
      [...document.querySelectorAll('[data-rail-sticky], [data-reader-hero], [data-reader-body]')].map((node) => {
        const box = node.getBoundingClientRect()
        return { top: box.top, left: box.left, width: box.width, height: box.height }
      }),
    )

  test('(h) skip link 1: it appears fixed without moving the layout; activating it sets #post-article and the next Tab enters the article', async ({
    page,
  }) => {
    await openPost(page, localePath(LONG_POST))
    const { article } = reader(page)
    const skip = page.getByRole('link', { name: msg('Site.reader.skipToArticle') })
    await expect(skip).toHaveCount(1)

    const before = await pageGeometry(page)
    expect(before.length, 'the hero, the body column and at least one visible rail container').toBeGreaterThanOrEqual(3)

    await tabTo(page, skip)
    await expect(skip).toBeFocused()
    await expect(skip).toBeInViewport()
    await expect(skip).toHaveCSS('position', 'fixed')
    expect((await edgesOf(skip)).top, 'the skip link is on screen').toBeGreaterThanOrEqual(0)
    expect(await pageGeometry(page), 'focusing the skip link moves nothing').toEqual(before)

    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/#post-article$/)
    await expect(article).toBeInViewport()
    // The link does not move focus by itself: the NEXT Tab starts from the target, the first focusable element inside the article (the hero).
    await page.keyboard.press('Tab')
    const landed = await focusIsFirstIn(page, '#post-article')
    expect(landed.inScope, `focus landed on "${landed.active}", not in the article`).toBe(true)
    expect(landed.isFirst, `focus landed on "${landed.active}", the first focusable of the article is "${landed.first}"`).toBe(
      true,
    )
  })

  test('(h) skip link 2: it leads to the text; focus lands on #post-body and the next Tab is the first focusable of the body', async ({
    page,
  }) => {
    await openPost(page, localePath(LONG_POST))
    const skip = page.getByRole('link', { name: msg('Site.reader.skipToBody') })
    await expect(skip).toHaveCount(1)
    await expect(skip).toHaveAttribute('href', '#post-body')

    const before = await pageGeometry(page)
    await tabTo(page, skip)
    await expect(skip).toBeFocused()
    await expect(skip).toBeInViewport()
    await expect(skip).toHaveCSS('position', 'fixed')
    expect(await pageGeometry(page), 'focusing the second skip link moves nothing').toEqual(before)

    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/#post-body$/)
    // The body column has tabindex -1, so the browser moves focus to it itself.
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.id), { message: 'the focused element after the link' })
      .toBe('post-body')
    // The next Tab is the inline table of contents summary (below the right-column breakpoint) or the first focusable of the text.
    await page.keyboard.press('Tab')
    const landed = await focusIsFirstIn(page, '#post-body')
    expect(landed.inScope, `focus landed on "${landed.active}", not in the body column`).toBe(true)
    expect(landed.isFirst, `focus landed on "${landed.active}", the first focusable of the body is "${landed.first}"`).toBe(true)
  })

  test('(i) below 1088px the body comes first, then the actions toolbar, then PostNav; from 1024 the sidebar starts with the hero', async ({
    page,
    backend,
  }, testInfo) => {
    const project = testInfo.project.name
    const data = await seriesMiddle(backend)
    test.skip(data === null, `the sample series "${SERIES_SLUG}" is missing: no post with a PostNav on both sides is known`)
    await openPost(page, localePath(`/posts/${data!.current.slug}`))
    for (const width of widthsFor(project, [768, 1024, 1080])) {
      await atWidth(page, project, width)
      const { left, hero, column } = reader(page)
      const [leftBox, heroBox, columnBox] = await Promise.all([left, hero, column].map((locator) => edgesOf(locator)))
      const toolbar = await toolbarEdges(page, isMobile(project))
      const postNav = await edgesOf(page.getByRole('navigation', { name: msg('Site.postNav.navLabel') }))
      const label = `${width}px`
      expect(heroBox.bottom, `${label}: hero ends before the body`).toBeLessThanOrEqual(columnBox.top + 0.5)
      expect(columnBox.bottom, `${label}: body ends before the toolbar`).toBeLessThanOrEqual(toolbar.top + 0.5)
      expect(toolbar.bottom, `${label}: toolbar ends before PostNav`).toBeLessThanOrEqual(postNav.top + 0.5)
      if (width >= 1024) expectNear(leftBox.top, heroBox.top, 1, `${label}: the sidebar starts with the hero`)
      else expect(leftBox.bottom, `${label}: the sidebar card is above the hero`).toBeLessThanOrEqual(heroBox.top + 0.5)
    }
  })

  test('(j) seams: at 1100, 1180 and 1279 the right column ends at the frame edge; at 1024 and 1060 there is no right column and the article ends there', async ({
    page,
  }, testInfo) => {
    test.skip(isMobile(testInfo.project.name), 'the seam widths cannot be emulated by the phone project')
    await openPost(page, localePath(LONG_POST))
    for (const width of [1100, 1180, 1279]) {
      await setViewport(page, width)
      const { railSticky } = reader(page)
      await expect(railSticky, `${width}px: right column visible`).toBeVisible()
      // `expectColumns` asserts the right column ends at the frame edge and the three columns do not overlap.
      await expectColumns(page, { left: 224, right: 208 }, 2, `${width}px`)
      expect(expectFrameAligned(await frameGeometry(page), `${width}px`).borders).toBe(0)
      await expectNoPageOverflow(page, `${width}px`)
    }
    for (const width of [1024, 1060]) {
      await setViewport(page, width)
      await expect(reader(page).leftSticky, `${width}px: sidebar visible`).toBeVisible()
      await expectColumns(page, { left: 224, right: null }, 1, `${width}px`)
      await expectNoPageOverflow(page, `${width}px`)
    }
  })

  test('(k) text fills the column: the widest paragraph is as wide as the body at 1440, 1280 and 1100', async ({
    page,
  }, testInfo) => {
    test.skip(isMobile(testInfo.project.name), 'the three-column body is a desktop layout')
    await openPost(page, localePath(LONG_POST))
    for (const width of [1440, 1280, 1100]) {
      await setViewport(page, width)
      await page.evaluate(() => document.fonts.ready.then(() => true))
      const text = await paragraphAndBody(page)
      expect(text.body, `${width}px: the post body is laid out`).toBeGreaterThan(0)
      expectNear(text.widest, text.body, 1, `${width}px: paragraphs fill the body column`)
    }
  })
})

test.describe('Post layout: a long table of contents', () => {
  /** A post with at least 15 headings: a sample post when there is one, else one created and published for this spec. */
  let longPath: string | null = null
  let created: TemporaryPost | null = null

  test.beforeAll(async ({ browser, backend }, testInfo) => {
    if (isMobile(testInfo.project.name)) return
    const seeded = await findPostWithHeadings(backend, 15)
    if (seeded !== null) {
      longPath = localePath(`/posts/${seeded}`)
      return
    }
    created = await createPublishedPost(browser, backend, testInfo, { purpose: 'post-layout', content: longPostContent(18) })
    longPath = localePath(`/posts/${created.slug}`)
  })

  test.afterAll(async ({ browser, backend }, testInfo) => {
    if (created !== null) await removeTemporaryPost(browser, backend, testInfo, created)
    created = null
  })

  test('(l) 1440x720: like is in view without scrolling the rail, the TOC list is the only scroller, the active entry stays in view', async ({
    page,
  }, testInfo) => {
    test.skip(isMobile(testInfo.project.name), 'the sticky right rail exists only on a desktop window')
    expect(longPath, 'a post with 15 headings was found or created').not.toBeNull()
    await openPost(page, longPath!)
    await setViewport(page, 1440, 720)
    const { rail, railSticky } = reader(page)
    await page.evaluate(() => window.scrollTo(0, 900))
    await settle(page)

    // The actions are always inside the viewport, however long the table of contents is.
    const like = rail.locator('#luot-thich')
    await expect(like).toBeInViewport({ ratio: 1 })
    const box = await edgesOf(like)
    expect(box.bottom, 'like button above the bottom of the window').toBeLessThanOrEqual(720)
    expect((await edgesOf(railSticky)).bottom, 'the sticky container fits the window').toBeLessThanOrEqual(720 + 0.5)
    // While the article is long enough below the window the rail stays pinned 24px below the visible part of the header.
    await expect
      .poll(async () => Math.abs((await edgesOf(railSticky)).top - ((await visibleHeaderHeight(page)) + 24)), {
        message: 'distance of the right column top from the visible header height + 24',
      })
      .toBeLessThanOrEqual(1)

    // Only the TOC list scrolls: the sticky container and every other element of the rail keep overflow visible.
    const list = rail.locator('ul[data-toc-list]')
    await expect(list).toBeVisible()
    const scrollers = await rail.evaluate((aside) =>
      [aside, ...aside.querySelectorAll('*')]
        .filter((node) => /(auto|scroll)/.test(getComputedStyle(node).overflowY))
        .map(
          (node) =>
            `${node.tagName.toLowerCase()}${node.hasAttribute('data-toc-list') ? '[data-toc-list]' : ''}${node.hasAttribute('data-rail-sticky') ? '[data-rail-sticky]' : ''}`,
        ),
    )
    expect(scrollers, 'elements of the right rail with overflow auto or scroll').toEqual(['ul[data-toc-list]'])
    const overflowing = await list.evaluate((node) => node.scrollHeight > node.clientHeight + 1)
    expect(overflowing, 'the list is longer than its box (it scrolls, the rail does not)').toBe(true)

    // At the last heading the active link is inside the list's visible range (TocSpy scrolls the list, not the page).
    await page
      .locator('[data-post-body] :is(h2, h3, h4)')
      .last()
      .evaluate((node) => node.scrollIntoView())
    const active = rail.locator('nav[data-toc] a[aria-current]')
    await expect(active).toHaveCount(1)
    await expect
      .poll(
        async () => {
          const [link, scroller] = [await edgesOf(active), await edgesOf(list)]
          return link.top >= scroller.top - 1 && link.bottom <= scroller.bottom + 1
        },
        { message: 'the active TOC link is inside the visible range of the list' },
      )
      .toBe(true)
    // At the last heading the article is about to end: the sticky container is released at the bottom of the body row (the rail
    // is not pinned any more, by design), but it never leaves that row: its bottom stays inside the body column's bottom edge.
    expect((await edgesOf(railSticky)).bottom, 'the rail stays inside the body row').toBeLessThanOrEqual(
      (await edgesOf(reader(page).column)).bottom + 1,
    )
  })
})

test.describe('Post layout: focus ring, back to top and the sidebar states', () => {
  test('(m) the focus outline of the first and the last sidebar link, the first summary and the TOC links stays inside the scroll container', async ({
    page,
  }, testInfo) => {
    test.skip(isMobile(testInfo.project.name), 'the rail scrollers exist only on a desktop window')
    await openPost(page, localePath(LONG_POST))
    const { leftSticky, rail } = reader(page)
    await expect(leftSticky).toBeVisible()
    const tocLinks = rail.locator('ul[data-toc-list] a')
    expect(await tocLinks.count(), 'the post has a table of contents').toBeGreaterThanOrEqual(3)
    // Visible links only: a link inside a closed group (the category group of a series post) is not a Tab stop.
    const leftLinks = leftSticky.locator('a:visible')
    // In DOM order, so one Tab walk from the top reaches the stops one after the other: sidebar, then the right column.
    const targets = [
      ['first sidebar link', leftLinks.first()],
      ['first sidebar summary', leftSticky.locator('summary:visible').first()],
      ['last sidebar link', leftLinks.last()],
      ['first table of contents link', tocLinks.first()],
      ['last table of contents link', tocLinks.last()],
    ] as const
    for (const [name, link] of targets) {
      if ((await link.count()) === 0) continue
      await tabTo(page, link)
      await expect(link).toBeFocused()
      const { style, ring, scroller, scrollerTag } = await outlineAndScroller(link)
      expect(style, `${name}: a visible outline`).not.toBe('none')
      const where = `${name} in ${scrollerTag}`
      expect(ring.left, `${where}: ring left`).toBeGreaterThanOrEqual(scroller.left - 0.5)
      expect(ring.right, `${where}: ring right`).toBeLessThanOrEqual(scroller.right + 0.5)
      expect(ring.top, `${where}: ring top`).toBeGreaterThanOrEqual(scroller.top - 0.5)
      expect(ring.bottom, `${where}: ring bottom`).toBeLessThanOrEqual(scroller.bottom + 0.5)
    }
  })

  test('(n) after three screens of scroll the Back to top button does not cover the rail actions', async ({ page }, testInfo) => {
    test.skip(isMobile(testInfo.project.name), 'the narrow rail band is a desktop window case')
    await openPost(page, localePath(LONG_POST))
    for (const width of [1100, 1200]) {
      await setViewport(page, width)
      await page.evaluate(() => window.scrollTo(0, 3 * window.innerHeight))
      const backToTop = page.getByRole('button', { name: msg('Site.shell.backToTop') })
      await expect(backToTop, `${width}px: the button shows after 3 screens`).toBeVisible()
      const button = await edgesOf(backToTop)
      const { rail } = reader(page)
      // The actions: every link and button of the right rail except the table of contents (like, save, share icons, native share).
      const actions = await rail.locator('a, button').evaluateAll((nodes) =>
        nodes
          .filter((node) => !node.closest('nav[data-toc]'))
          .map((node) => node.getBoundingClientRect())
          .filter((box) => box.width > 0 && box.height > 0)
          .map((box) => ({ left: box.left, right: box.right, top: box.top, bottom: box.bottom })),
      )
      expect(actions.length, `${width}px: like, save and share controls found in the rail`).toBeGreaterThanOrEqual(3)
      for (const action of actions) {
        const apart =
          action.right <= button.left || action.left >= button.right || action.bottom <= button.top || action.top >= button.bottom
        expect(apart, `${width}px: action ${JSON.stringify(action)} against Back to top ${JSON.stringify(button)}`).toBe(true)
      }
    }
  })

  test('(o) a post with a category shows the category group (open) and no series nav; Explore has five icon links; a post with neither shows Explore alone', async ({
    page,
    backend,
    browser,
  }, testInfo) => {
    test.skip(isMobile(testInfo.project.name), 'the three states are compared on the desktop column')
    const posts = await backend.publishedPosts()
    const inCategory = (post: (typeof posts)[number]) =>
      post.category !== null && posts.some((other) => other.id !== post.id && other.category?.id === post.category!.id)
    const withCategory = posts.find((post) => !post.series && inCategory(post))
    const bare = posts.find((post) => !post.series && post.category === null)

    /** Explore is always there: its list is named by the eyebrow, holds the four sections and Best posts, each with a 16px icon. */
    const expectExplore = async () => {
      const { leftSticky } = reader(page)
      const explore = leftSticky.getByRole('list', { name: msg('Site.reader.exploreTitle') })
      await expect(leftSticky.getByText(msg('Site.reader.exploreTitle'), { exact: true })).toBeVisible()
      await expect(explore.getByRole('link')).toHaveCount(5)
      await expect(explore.locator('a > svg')).toHaveCount(5)
    }

    let temporary: TemporaryPost | null = null
    try {
      let target = withCategory?.slug
      if (target === undefined) {
        // No standalone post has a category mate: publish one next to a standalone categorised post.
        const lone = posts.find((post) => !post.series && post.category !== null)
        test.skip(lone === undefined, 'no standalone post with a category exists on this stack to build the category state from')
        temporary = await createPublishedPost(browser, backend, testInfo, {
          purpose: 'post-layout-category',
          content: longPostContent(3),
          categoryId: lone!.category!.id,
        })
        target = temporary.slug
      }
      const category = (await backend.post(target)).category!
      await openPost(page, localePath(`/posts/${target}`))
      // The sidebar holds two copies of its groups (the closed card for phones, the desktop column): read the visible one.
      const { left, leftSticky } = reader(page)
      await expectExplore()
      // The category group is a <details>, open for a post whose primary group is its category; its summary is the plain-text title.
      const group = leftSticky.locator('details').filter({
        has: page.locator('summary', { hasText: msg('Site.reader.categoryTitle', { category: category.name }) }),
      })
      await expect(group).toHaveCount(1)
      await expect(group).toHaveAttribute('open', '')
      await expect(group.locator('summary')).toHaveText(msg('Site.reader.categoryTitle', { category: category.name }))
      expect(await group.locator('ul a').count(), 'the category group lists posts').toBeGreaterThan(0)
      // The series group is the only navigation landmark of the sidebar: a post outside any series has none.
      await expect(left.getByRole('navigation')).toHaveCount(0)
    } finally {
      if (temporary !== null) await removeTemporaryPost(browser, backend, testInfo, temporary)
    }

    // A published post needs a category (the editor refuses to publish without one), so the "neither" state exists only when the
    // sample data has such a post; it is not created through the admin API.
    if (bare === undefined) {
      test
        .info()
        .annotations.push({ type: 'skipped part', description: 'no published post without category and series on this stack' })
      return
    }
    await openPost(page, localePath(`/posts/${bare.slug}`))
    const { left, leftSticky } = reader(page)
    await expect(leftSticky.getByText(msg('Site.reader.exploreTitle'), { exact: true })).toBeVisible()
    await expect(left.getByRole('navigation')).toHaveCount(0)
    await expect(leftSticky.locator('details')).toHaveCount(0)
    await expect(leftSticky.getByText(new RegExp(`^${msg('Site.reader.categoryTitle', { category: '' }).trim()}`))).toHaveCount(0)
  })
})

test.describe('Post layout: the hero block', () => {
  test('(p) hero over the body and the right column: series badge, author row, one Copy link, Share with the same links, Next', async ({
    page,
    backend,
  }, testInfo) => {
    const desktop = !isMobile(testInfo.project.name)
    const data = await seriesMiddle(backend)
    test.skip(data === null, `the sample series "${SERIES_SLUG}" with at least 3 published parts is not on this stack`)
    const { series, parts, current } = data!
    await openPost(page, localePath(`/posts/${current.slug}`))
    const { hero, column, rail } = reader(page)
    await expect(hero).toHaveCount(1)

    if (desktop) {
      // The hero spans the body column and the right column (the exact numbers are case (a)).
      await setViewport(page, 1440)
      const [heroBox, columnBox, railBox] = await Promise.all([hero, column, rail].map((locator) => edgesOf(locator)))
      expectNear(heroBox.left, columnBox.left, 1, 'hero left edge against the body column')
      expectNear(heroBox.right, railBox.right, 1, 'hero right edge against the right column')
      expect(heroBox.bottom, 'the hero is above the body').toBeLessThanOrEqual(columnBox.top + 0.5)
    }

    // The badge "NN / NN" (aria-hidden) with its text twin, then the series title as a link to the series page. Below `lg` they are not on
    // the meta row (the series card above the hero names the series), so a phone sees neither, and the card holds the series link.
    const pad = (value: number) => String(value).padStart(2, '0')
    if (desktop) {
      await expect(hero.locator('span[aria-hidden="true"]', { hasText: `${pad(2)} / ${pad(parts.length)}` })).toHaveCount(1)
      await expect(hero.getByText(msg('Site.reader.partBadge', { current: 2, total: parts.length }))).toHaveCount(1)
      await expect(hero.getByRole('link', { name: series.title })).toHaveAttribute('href', localePath(`/series/${series.slug}`))
    } else {
      await expect(hero.getByRole('link', { name: series.title })).toHaveCount(0)
      await expect(hero.getByText(msg('Site.reader.partBadge', { current: 2, total: parts.length }))).toBeHidden()
    }
    await expect(hero.getByRole('heading', { level: 1 })).toHaveCount(1)

    // The author row: Subscribe leads to the newsletter; the name links to the profile when the author has one; the avatar is 32px.
    // The row is found from the author's name (the hero's only `<bdi>`), not from Subscribe: from `sm` Subscribe is a sibling in the row,
    // on a phone it is not drawn (`max-sm:hidden`), the row is the name alone, and the same lookup finds it in both projects.
    const subscribe = hero.getByRole('link', { name: msg('Site.reader.subscribe') })
    const authorName = hero.locator('bdi')
    await expect(authorName, 'the author name is one <bdi> of the hero').toHaveCount(1)
    const row = authorName.locator('xpath=ancestor::div[1]')
    if (desktop)
      await expect(row.getByRole('link', { name: msg('Site.reader.subscribe') })).toHaveAttribute(
        'href',
        localePath('/newsletter'),
      )
    else await expect(subscribe).toHaveCount(0)
    // The profile the name leads to: /about for the site owner (or an old backend that sends no author), /u/<slug> for another author, and
    // no link for an author without a slug (the name stays plain text).
    const author = (await backend.post(current.slug)).author
    const profile = !author || author.siteOwner ? '/about' : author.profileSlug ? `/u/${author.profileSlug}` : null
    const nameLink = row.getByRole('link').filter({ has: page.locator('bdi') })
    await expect(nameLink, `the author name ${profile ? 'is a link' : 'is plain text'}`).toHaveCount(profile ? 1 : 0)
    if (profile) await expect(nameLink).toHaveAttribute('href', localePath(profile))
    const avatar = row.locator('img')
    if ((await avatar.count()) > 0) {
      const size = await edgesOf(avatar.first())
      expectNear(widthOf(size), 32, 1, 'author avatar width')
    }

    // Exactly one Copy link on the page, and it is in the hero (the right column keeps only the share icons).
    const copy = page.getByRole('button', { name: msg('Site.share.copyLink') })
    await expect(copy).toHaveCount(1)
    await expect(hero.getByRole('button', { name: msg('Site.share.copyLink') })).toHaveCount(1)
    await expect(hero.getByRole('group', { name: msg('Site.reader.actionsLabel') })).toBeVisible()

    // Share opens a panel whose three links have exactly the hrefs of the right column's icon row. That row is drawn from `sm`; on a phone
    // the toolbar after the article holds a Share menu of its own (the same component as the hero's), and its links are the reference.
    const names = ['Facebook', 'LinkedIn', 'X'].map((target) => msg('Site.share.shareOn', { target }))
    let railHrefs: (string | null)[]
    if (desktop) {
      const railLinks = rail.getByRole('list', { name: msg('Site.share.label') })
      railHrefs = await Promise.all(names.map((name) => railLinks.getByRole('link', { name }).getAttribute('href')))
    } else {
      const toolbarMenu = page.locator('#luu-bai ~ div details')
      await expect(toolbarMenu).toHaveCount(1)
      await toolbarMenu.locator('summary').click()
      await expect(toolbarMenu).toHaveAttribute('open', '')
      railHrefs = await Promise.all(names.map((name) => toolbarMenu.getByRole('link', { name }).getAttribute('href')))
      await page.keyboard.press('Escape')
      await expect(toolbarMenu).not.toHaveAttribute('open')
    }
    const menu = hero.locator('details')
    await expect(menu).toHaveCount(1)
    await expect(menu).not.toHaveAttribute('open')
    await menu.locator('summary').click()
    await expect(menu).toHaveAttribute('open', '')
    const menuHrefs = await Promise.all(names.map((name) => menu.getByRole('link', { name }).getAttribute('href')))
    expect(menuHrefs, 'the hero Share links are the right column links').toEqual(railHrefs)
    await page.keyboard.press('Escape')
    await expect(menu).not.toHaveAttribute('open')

    // Next: the next part of the series; absent at the last part (a series is not continued by date).
    const nextPart = hero.getByRole('link', { name: msg('Site.reader.nextPart') })
    await expect(nextPart).toHaveAttribute('href', localePath(`/posts/${parts[2].slug}`))
    await page.goto(localePath(`/posts/${parts.at(-1)!.slug}`))
    await expect(reader(page).hero).toBeVisible()
    await expect(reader(page).hero.getByRole('link', { name: msg('Site.reader.nextPart') })).toHaveCount(0)
    await expect(reader(page).hero.getByRole('link', { name: msg('Site.postNav.next'), exact: false })).toHaveCount(0)
    await expect(
      reader(page).hero.locator('span[aria-hidden="true"]', { hasText: `${pad(parts.length)} / ${pad(parts.length)}` }),
    ).toHaveCount(1)
  })
})

test.describe('Post layout: the tooltip on truncated sidebar rows', () => {
  /** A title that cannot fit a 260px sidebar on one line, with spaces, so only the ellipsis (not a long word) cuts it. */
  const TITLE = `E2E tooltip ${'a title much longer than the sidebar '.repeat(3)}end`
  let temporary: TemporaryPost | null = null
  /** A standalone post of the category of the temporary post: its sidebar lists the temporary post. */
  let neighbour: string | null = null

  test.beforeAll(async ({ browser, backend }, testInfo) => {
    const [category] = await backend.adminCategories()
    temporary = await createPublishedPost(browser, backend, testInfo, {
      purpose: 'tooltip',
      title: TITLE,
      content: longPostContent(2),
      categoryId: category.id,
    })
    // As in overflow.spec.ts: a standalone post of the category, never the one right after the temporary post in time (its PostNav
    // card would print the title too, outside the sidebar).
    const published = (await backend.publishedPosts()).filter((item) => item.slug !== temporary!.slug)
    const others = published.filter((item, index) => index > 0 && item.category?.id === category.id)
    neighbour = others.find((item) => !item.series)?.slug ?? null
  })

  test.afterAll(async ({ browser, backend }, testInfo) => {
    if (temporary !== null) await removeTemporaryPost(browser, backend, testInfo, temporary)
    temporary = null
  })

  /** The sidebar row (the link) of the long-title post, scrolled into view in the sidebar's own scroller. */
  async function longRow(page: Page, phone: boolean) {
    const scope = phone ? await openLeftRail(page) : reader(page).leftSticky
    const row = scope.locator('a[data-tip]').filter({ hasText: TITLE }).first()
    await expect(row, 'the long-title post is listed in the sidebar of its neighbour').toBeVisible()
    await row.scrollIntoViewIfNeeded()
    return row
  }

  test('(q) pointer: the tooltip shows over the row after a short delay, starts at its edge, passes the sidebar, ignores the pointer, Escape hides it', async ({
    page,
    context,
  }, testInfo) => {
    test.skip(isMobile(testInfo.project.name), 'hover is a desktop pointer case; the phone case is below')
    test.skip(neighbour === null, 'no standalone post shares the category of the temporary post on this stack')
    await openPost(page, localePath(`/posts/${neighbour}`))
    await setViewport(page, 1440)
    const { left } = reader(page)
    const row = await longRow(page, false)
    const tip = page.locator('[data-rail-tip]')
    await expect(tip, 'no tooltip before the pointer arrives').toBeHidden()

    await row.hover()
    await expect(tip).toBeVisible()
    await expect(tip).toHaveText(TITLE)
    await expect(tip, 'decorative: the row already has the full name').toHaveAttribute('aria-hidden', 'true')
    await expect(tip, 'it never takes the pointer').toHaveCSS('pointer-events', 'none')
    const [tipBox, rowBox, leftBox] = await Promise.all([tip, row, left].map((locator) => edgesOf(locator)))
    expectNear(tipBox.left, rowBox.left, 1, 'tooltip starts at the row edge')
    expect(tipBox.right, 'the tooltip is wider than the sidebar').toBeGreaterThan(leftBox.right)
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
    expect(tipBox.right, 'inside the window (right)').toBeLessThanOrEqual(viewport.width)
    expect(tipBox.bottom, 'inside the window (bottom)').toBeLessThanOrEqual(viewport.height)
    // The pointer is still on the row, not on the tooltip.
    const pointerOnRow = await row.evaluate((node) => {
      const box = node.getBoundingClientRect()
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      return hit !== null && node.contains(hit)
    })
    expect(pointerOnRow, 'elementFromPoint at the pointer is still the row').toBe(true)

    // Escape hides it.
    await page.keyboard.press('Escape')
    await expect(tip).toBeHidden()

    // Leaving and coming back shows it again; a modifier-click still opens the link in a new tab (the tooltip does not intercept it).
    await page.mouse.move(700, 300)
    await row.hover()
    await expect(tip).toBeVisible()
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
    const [popup] = await Promise.all([context.waitForEvent('page'), row.click({ modifiers: [modifier] })])
    await popup.close()
    await expect(page, 'the modifier-click left this page where it was').toHaveURL(new RegExp(`/posts/${neighbour}$`))
  })

  test('(q) keyboard: focus shows the tooltip below or above the row, never over it; the focus ring stays visible; leaving the row hides it', async ({
    page,
  }, testInfo) => {
    test.skip(isMobile(testInfo.project.name), 'keyboard focus order is checked on the desktop column')
    test.skip(neighbour === null, 'no standalone post shares the category of the temporary post on this stack')
    await openPost(page, localePath(`/posts/${neighbour}`))
    await setViewport(page, 1440)
    // The pointer is parked away from the sidebar, so only the keyboard can open the tooltip.
    await page.mouse.move(700, 300)
    const row = await longRow(page, false)
    const tip = page.locator('[data-rail-tip]')
    await tabTo(page, row)
    await expect(row).toBeFocused()
    await expect(tip).toBeVisible()
    await expect(tip).toHaveText(TITLE)
    const [tipBox, rowBox] = await Promise.all([tip, row].map((locator) => edgesOf(locator)))
    const apart = tipBox.top >= rowBox.bottom - 0.5 || tipBox.bottom <= rowBox.top + 0.5
    expect(apart, `tooltip ${JSON.stringify(tipBox)} does not intersect the focused row ${JSON.stringify(rowBox)}`).toBe(true)
    expect(await row.evaluate((node) => getComputedStyle(node).outlineStyle), 'the focused row keeps its focus outline').not.toBe(
      'none',
    )
    const rowOnTop = await row.evaluate((node) => {
      const box = node.getBoundingClientRect()
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      return hit !== null && node.contains(hit)
    })
    expect(rowOnTop, 'nothing covers the centre of the focused row').toBe(true)

    // Moving focus away dismisses it (blur, not Tab: the next row may be a truncated one with a tooltip of its own).
    await row.evaluate((node) => (node as HTMLElement).blur())
    await expect(tip).toBeHidden()
  })

  test('(q) touch: at 390 the tooltip never shows', async ({ page }, testInfo) => {
    test.skip(!isMobile(testInfo.project.name), 'the touch case runs in the phone project')
    test.skip(neighbour === null, 'no standalone post shares the category of the temporary post on this stack')
    await openPost(page, localePath(`/posts/${neighbour}`))
    const row = await longRow(page, true)
    // A touch pointer over the row (the events a finger produces before a tap): the host ignores pointerType "touch".
    await row.dispatchEvent('pointerover', { pointerType: 'touch', bubbles: true })
    await page.waitForTimeout(600)
    await expect(page.locator('[data-rail-tip]')).toBeHidden()
  })
})

test.describe('Post layout: the shared frame without JavaScript and across navigation', () => {
  test('(r) with JavaScript off: frame, header Container and footer Container have the same edges at 1440 and 1920', async ({
    browser,
  }, testInfo) => {
    test.skip(isMobile(testInfo.project.name), 'the equality is a desktop window case')
    for (const width of [1440, 1920]) {
      // `javaScriptEnabled: false`: nothing but the server HTML and the stylesheet decides the widths (the frame is plain CSS).
      const context = await browser.newContext({
        baseURL: testInfo.project.use.baseURL,
        javaScriptEnabled: false,
        viewport: { width, height: 900 },
      })
      try {
        const page = await context.newPage()
        await page.goto(localePath(LONG_POST))
        await expect(reader(page).grid).toBeVisible()
        const g = await frameGeometry(page)
        const { width: frameWidth, borders } = expectFrameAligned(g, `no JS ${width}px`)
        expect(frameWidth, `no JS ${width}px: the frame is 1400px`).toBe(READER_FRAME_MAX)
        expect(borders, `no JS ${width}px: side borders`).toBe(1)
      } finally {
        await context.close()
      }
    }
  })

  test('(r) after a client navigation from the post to /writing the header Container is still the 1400px frame, with its hairlines', async ({
    page,
  }, testInfo) => {
    test.skip(isMobile(testInfo.project.name), 'the Explore link and the framed header are desktop cases')
    await openPost(page, localePath(LONG_POST))
    await setViewport(page, 1440)
    // The Container of the header: its outer width, its gutter-less content width (outer minus the paddings, as before the shared
    // frame) and the side hairlines. The shell is shared by every page, so none of them changes on a navigation.
    const headerBox = async () => {
      const g = await frameGeometry(page)
      return {
        width: Math.round(widthOf(g.header.edges)),
        content: Math.round(widthOf(g.header.edges) - g.header.paddingLeft - g.header.paddingRight),
        left: Math.round(g.header.edges.left),
        borderLeft: g.header.borderLeft,
        borderRight: g.header.borderRight,
      }
    }
    // On the post the Container is the 1400px frame (1352px of content inside its 24px gutters), centred in the 1440 window.
    const onPost = await headerBox()
    expect(onPost.width, 'header Container width on the post').toBe(READER_FRAME_MAX)
    expect(onPost.content, 'header content width on the post').toBe(READER_FRAME_MAX - 48)
    expect([onPost.borderLeft, onPost.borderRight], 'header hairlines on the post').toEqual([1, 1])

    // The Explore link "Latest" is a client-side navigation: the header and footer persist, only <main> swaps.
    await reader(page).leftSticky.locator('a[href$="/writing"]').first().click()
    await expect(page).toHaveURL(/\/writing$/)
    await expect(reader(page).grid, 'the post grid is gone after the navigation').toHaveCount(0)
    await expect
      .poll(async () => (await headerBox()).width, { message: 'header Container width on /writing' })
      .toBe(READER_FRAME_MAX)
    const onWriting = await headerBox()
    expect(onWriting.content, 'header content width on /writing').toBe(READER_FRAME_MAX - 48)
    expectNear(onWriting.left, onPost.left, 1, 'header Container x on /writing')
    expect([onWriting.borderLeft, onWriting.borderRight], 'header hairlines on /writing').toEqual([1, 1])
    // The page body is the same frame: header, main and footer agree on /writing as they did on the post.
    expectFrameAligned(await frameGeometry(page), '/writing after the navigation')
  })
})

test.describe('Post layout: a short post fills the frame', () => {
  let temporary: TemporaryPost | null = null

  test.beforeAll(async ({ browser, backend }, testInfo) => {
    temporary = await createTemporaryPost(browser, backend, testInfo, 'post-layout-short')
  })

  test.afterAll(async ({ browser, backend }, testInfo) => {
    if (temporary !== null) await removeTemporaryPost(browser, backend, testInfo, temporary)
    temporary = null
  })

  test('(r) the sidebar tint runs to the bottom of the grid and the grid reaches the discovery band or the footer; the columns are still 260 / 908 / 230', async ({
    page,
  }, testInfo) => {
    test.skip(isMobile(testInfo.project.name), 'the stretched sidebar is a desktop case')
    await openPost(page, localePath(`/posts/${temporary!.slug}`))
    await setViewport(page, 1440, 1100)
    const { left, grid, discovery } = reader(page)
    const g = await frameGeometry(page)
    expectFrameAligned(g, 'short post 1440px')
    await expectColumns(page, { left: 260, right: 230 }, 1, 'short post 1440px')

    // The sidebar is stretched over the whole grid (the grid has `flex-1`, the aside is a grid item over its rows).
    const [leftBox, gridBox] = [await edgesOf(left), await edgesOf(grid)]
    expectNear(leftBox.bottom, gridBox.bottom, 1, 'sidebar bottom against the grid bottom')
    // The grid reaches the discovery band, or the footer when the post has no band: no gap under the tint.
    const below = (await discovery.count()) > 0 ? (await edgesOf(discovery)).top : g.footer.edges.top
    expectNear(gridBox.bottom, below, 1, 'grid bottom against the discovery band (or the footer)')
    // The footer sits right under the frame (no gap between the tint and the footer edge).
    expectNear(g.footer.edges.top, g.frame.edges.bottom, 1, 'footer starts where the frame ends')
    await expectNoPageOverflow(page, 'short post 1440px')
  })
})

test.describe('Post layout: collapsible groups', () => {
  test('(s) the series group toggles while its navigation landmark stays; the category group is closed for a series post', async ({
    page,
    backend,
  }, testInfo) => {
    test.skip(isMobile(testInfo.project.name), 'the phone card is the only toggle on a phone; its groups are always open')
    const data = await seriesMiddle(backend)
    test.skip(data === null, `the sample series "${SERIES_SLUG}" with at least 3 published parts is not on this stack`)
    const { series, current } = data!
    await openPost(page, localePath(`/posts/${current.slug}`))
    const { leftSticky } = reader(page)
    const landmark = page.getByRole('navigation', { name: series.title })
    const group = landmark.locator('details')
    const list = landmark.locator('ol')

    // Open on load: the current series is expanded by default, with its numbered list.
    await expect(landmark).toHaveCount(1)
    await expect(group).toHaveAttribute('open', '')
    await expect(list).toBeVisible()

    // Toggle: the list goes away, the landmark (named by the summary, which stays) does not.
    await landmark.locator('summary').click()
    await expect(group).not.toHaveAttribute('open')
    await expect(list).toBeHidden()
    await expect(page.getByRole('navigation', { name: series.title })).toHaveCount(1)
    await landmark.locator('summary').click()
    await expect(group).toHaveAttribute('open', '')
    await expect(list).toBeVisible()

    // The category group (when the post has a category: a secondary group) is the other <details> and is closed.
    const details = leftSticky.locator('details')
    if ((await details.count()) > 1) {
      const category = details.last()
      await expect(category).not.toHaveAttribute('open')
      await expect(category.locator('summary')).toBeVisible()
      await category.locator('summary').click()
      await expect(category).toHaveAttribute('open', '')
    }
    await expect(leftSticky.getByRole('list', { name: msg('Site.reader.exploreTitle') }).getByRole('link')).toHaveCount(5)
  })
})
