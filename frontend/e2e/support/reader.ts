import { expect, type Browser, type Locator, type Page, type TestInfo } from '@playwright/test'
import { loginAsAdmin, msgStart, removeTemporaryPost, type TemporaryPost } from './admin'
import type { Backend } from './backend'
import { applyLocale, msg } from './i18n'

/**
 * Helpers of the post layout specs and of e2e/gallery.spec.ts: the geometry of the 1400px site frame (header, body, footer), the three columns of a
 * post, the hero block, the Tab walk, the characters-per-line measure and a published post with many headings.
 *
 * Every measured element is a structural hook: `#main-content` (the frame: `main` IS the 1400px box), `[data-reader-grid]` (the post
 * page's outer grid, whose last child holds the end blocks and whose next sibling is the discovery band), `[data-reader-hero]` (the
 * hero `<header>` of the article), `[data-reader-body]` (the body column, also `#post-body`), `[data-post-body]` (the `.prose`
 * element inside it), `aside[aria-label]` (the two rails), `[data-rail-sticky]` (the sticky div inside each rail, never the nav in
 * it), and the Containers of the site header and footer, found as the single `div` child of the banner and of the contentinfo
 * landmark (the hero `<header>` of the article is not a banner). Every width expectation is a function of `document.documentElement.clientWidth` (a classic scrollbar takes about 15px, a headless one may take none), never of
 * a hard-coded window width. Catalog text is read when a helper is CALLED, never at import time, so listing the tests does not need
 * the catalog keys of a feature that is not built yet.
 */

/** The rectangle of an element as four edges, in viewport coordinates. */
export type Edges = { left: number; right: number; top: number; bottom: number }

/** The frame, its columns and the article, as locators. */
export type Reader = {
  /** The 1400px frame: `main#main-content`, which holds the page grid and the discovery band. */
  frame: Locator
  /** The outer grid of the post page (`[data-reader-grid]`): the sidebar and the article. */
  grid: Locator
  /** The discovery band under the post (`[data-reader-grid] + *`); count 0 when the post has none. */
  discovery: Locator
  /** The hero `<header>` of the article (`[data-reader-hero]`): spans the body column and the right column. */
  hero: Locator
  /** The body column (`[data-reader-body]`, `#post-body`): cover, inline table of contents, text. Use it wherever "the text column" is meant. */
  column: Locator
  /** The end blocks (PostNav, author box, comments, related): the last child of the reader grid. */
  end: Locator
  /** `aside` of the left rail (the contextual navigation). */
  left: Locator
  /** `aside` of the right rail (the reading tools). */
  rail: Locator
  /** The sticky div of the left rail, visible copy only (the closed `<details>` copy has no such div). */
  leftSticky: Locator
  /** The sticky div of the right rail. */
  railSticky: Locator
  /** `article#post-article`: the hero, the body column AND the right column. */
  article: Locator
  /** The `.prose` element (`[data-post-body]`) inside the body column. */
  body: Locator
}

/** A CSS string literal for an attribute selector: the catalog text may contain quotes. */
function cssString(text: string): string {
  return JSON.stringify(text)
}

export function readerLabels(): { left: string; rail: string } {
  return { left: msg('Site.reader.leftLabel'), rail: msg('Site.reader.railLabel') }
}

export function reader(page: Page): Reader {
  const labels = readerLabels()
  const left = page.locator(`aside[aria-label=${cssString(labels.left)}]`)
  const rail = page.locator(`aside[aria-label=${cssString(labels.rail)}]`)
  return {
    frame: page.locator('#main-content'),
    grid: page.locator('[data-reader-grid]'),
    discovery: page.locator('[data-reader-grid] + *'),
    hero: page.locator('[data-reader-hero]'),
    column: page.locator('[data-reader-body]'),
    end: page.locator('[data-reader-grid] > :last-child'),
    left,
    rail,
    leftSticky: left.locator('[data-rail-sticky]'),
    railSticky: rail.locator('[data-rail-sticky]'),
    article: page.locator('article#post-article'),
    body: page.locator('[data-post-body]'),
  }
}

export async function edgesOf(locator: Locator): Promise<Edges> {
  const box = await locator.boundingBox()
  if (box === null) throw new Error(`${String(locator)} has no box (not rendered or display:none)`)
  return { left: box.x, right: box.x + box.width, top: box.y, bottom: box.y + box.height }
}

export function widthOf(edges: Edges): number {
  return edges.right - edges.left
}

export function centreOf(edges: Edges): number {
  return (edges.left + edges.right) / 2
}

/** The smallest box around all of the edges (the toolbar is the like, save and share controls taken together). */
export function unionOf(items: Edges[]): Edges {
  return {
    left: Math.min(...items.map((item) => item.left)),
    right: Math.max(...items.map((item) => item.right)),
    top: Math.min(...items.map((item) => item.top)),
    bottom: Math.max(...items.map((item) => item.bottom)),
  }
}

/**
 * Resize the window of the desktop project and let the layout settle: two frames, then the sticky header's measured height
 * (`--site-header-h`, written by useStickyHeader) is read again. Only for widths of 500px and more: below that a headless Chrome
 * window cannot go (memory note "Headless Chrome mobile QA pitfalls"), the phone is the `mobile` project (isMobile emulation).
 */
export async function setViewport(page: Page, width: number, height = 900): Promise<void> {
  expect(width, 'a window under 500px needs device emulation (the mobile project), not setViewportSize').toBeGreaterThanOrEqual(
    500,
  )
  await page.setViewportSize({ width, height })
  await settle(page)
}

/** Two animation frames, so a resize or a scroll has been laid out and the scroll handlers have run. */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
}

/**
 * Open a post, wait until the page is hydrated (the header height is measured) and the frame is laid out. The like and save buttons
 * are inert placeholders until the session answers and then become taller controls (the guest label of the like link wraps in the
 * right column): the page is settled only when both placeholders are gone, or a geometry taken now would be taken mid-change.
 */
export async function openPost(page: Page, path: string): Promise<void> {
  await page.goto(path)
  await expect(page.locator('article#post-article')).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--site-header-h')))
    .toMatch(/^\d+(\.\d+)?px$/)
  await expect(page.locator('[data-like-placeholder], [data-bookmark-placeholder]')).toHaveCount(0)
  await settle(page)
}

/** The sticky header's height as useStickyHeader measured it. */
export async function headerHeight(page: Page): Promise<number> {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--site-header-h')))
    .toMatch(/^\d+(\.\d+)?px$/)
  return Number.parseFloat(await page.evaluate(() => document.documentElement.style.getPropertyValue('--site-header-h')))
}

/**
 * The height of the header that is on screen right now, as `useStickyHeader` writes it into `--site-header-visible-h`: the measured
 * header height while the header is shown, `0` while it has slid away. Polled until the variable holds a length, so a read right
 * after a scroll waits for the scroll handler instead of racing it.
 */
export async function visibleHeaderHeight(page: Page): Promise<number> {
  const read = () =>
    page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--site-header-visible-h').trim())
  await expect.poll(read).toMatch(/^\d+(\.\d+)?px$/)
  return Number.parseFloat(await read())
}

/** The Container of the site header: the single `div` child of the banner landmark (the skip link is its sibling `a`). */
export function headerContainer(page: Page): Locator {
  return page.getByRole('banner').locator(':scope > div')
}

/** The Container of the site footer: the single `div` child of the contentinfo landmark. */
export function footerContainer(page: Page): Locator {
  return page.getByRole('contentinfo').locator(':scope > div')
}

/** A box with its computed side borders and paddings (0 when absent). */
export type BoxWithBorders = { edges: Edges; borderLeft: number; borderRight: number; paddingLeft: number; paddingRight: number }

/** The outer geometry the spec compares: the frame (`main`), the Container of the site header and that of the footer. */
export type FrameGeometry = {
  /** The client width (`layoutWidth`): the width every expectation is a function of. */
  clientWidth: number
  /** The window width media queries see (`window.innerWidth`, scrollbar included): the `frame:` breakpoint (89rem = 1424px) keys off it. */
  innerWidth: number
  frame: BoxWithBorders
  header: BoxWithBorders
  footer: BoxWithBorders
}

/** The outer box of an element with its computed side borders and paddings (0 when absent). */
export async function boxWithBorders(locator: Locator): Promise<BoxWithBorders> {
  return locator.evaluate((node) => {
    const box = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    const px = (name: string) => Number.parseFloat(style.getPropertyValue(name)) || 0
    return {
      edges: { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
      borderLeft: px('border-left-width'),
      borderRight: px('border-right-width'),
      paddingLeft: px('padding-left'),
      paddingRight: px('padding-right'),
    }
  })
}

/**
 * The OUTER boxes of the frame (`main#main-content`), of the Container of the site header (the `div` child of the banner) and of the
 * Container of the footer (the `div` child of the contentinfo), with their computed side borders and paddings. Outer, because the
 * frame has no padding while the header Container has a 24px gutter: inner edges are not comparable any more. Playwright's strict
 * mode makes a second banner or a second footer `div` a failure here instead of a silent first match.
 */
export async function frameGeometry(page: Page): Promise<FrameGeometry> {
  const [sizes, frame, header, footer] = await Promise.all([
    page.evaluate(() => ({ clientWidth: document.documentElement.getBoundingClientRect().width, innerWidth: window.innerWidth })),
    boxWithBorders(page.locator('#main-content')),
    boxWithBorders(headerContainer(page)),
    boxWithBorders(footerContainer(page)),
  ])
  return { ...sizes, frame, header, footer }
}

/** The widest the frame gets, in CSS px (87.5rem). Below it the frame is the whole client width. */
export const READER_FRAME_MAX = 1400

/** From this WINDOW width (`--breakpoint-frame`, 89rem) the frame draws its 1px side borders. */
export const FRAME_BORDER_FROM = 1424

/**
 * The client width of the page: the layout viewport without the scrollbar lane, read from the box of the root element.
 * `document.documentElement.clientWidth` is not used: `html` reserves its scrollbar lane (`scrollbar-gutter: stable`, globals.css), and
 * Chrome 155 started in headless mode with `--hide-scrollbars` (Playwright's default) still lays the page out inside that lane but
 * reports a `clientWidth` that includes it, 15px wider than the page. The root's own box is the page's width in every case: with a
 * visible scrollbar, with a hidden one, and with an overlay one (a phone, macOS), where both numbers are the window width.
 */
export async function clientWidthOf(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.getBoundingClientRect().width)
}

/** No horizontal page scroll (a failing layout is often seen first as overflow). */
export async function expectNoPageOverflow(page: Page, label: string): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(scrollWidth, `${label}: horizontal page scroll`).toBeLessThanOrEqual(clientWidth)
}

/**
 * The characters of each rendered line of the body paragraphs of at least 200 characters, counted with `Range.getClientRects` (one range
 * per character; `ch` is not used because it depends on the zero glyph). A new line starts when a character is lower than the line's
 * first character by more than half its own height, so an inline code chip with a smaller font stays on its line. The last line of a
 * paragraph is dropped (a partial line says nothing about the measure). Returns the counts and their median.
 *
 * By default the paragraphs are the ones of the post body (`[data-post-body] > p`, at least 200 characters, at least 3 lines). The
 * site-frame spec measures leads and cards of other pages with `selector`, and shorter text with `minChars` / `minLines` (2 lines
 * leave one full line to count).
 */
export async function lineLengths(
  page: Page,
  maxParagraphs = 6,
  options: { selector?: string; minChars?: number; minLines?: number } = {},
): Promise<{ counts: number[]; median: number; paragraphs: number }> {
  const { selector = '[data-post-body] > p', minChars = 200, minLines = 3 } = options
  const result = await page.evaluate(
    ({ limit, paragraphSelector, minimumChars, minimumLines }) => {
      const counts: number[] = []
      let paragraphs = 0
      for (const paragraph of document.querySelectorAll(paragraphSelector)) {
        if (paragraphs >= limit) break
        if ((paragraph.textContent ?? '').trim().length < minimumChars) continue
        // A paragraph that is not drawn (a hidden twin copy) has no boxes to count.
        if (paragraph.getClientRects().length === 0) continue
        const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
        const lines: number[] = []
        let lineTop = Number.NaN
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const text = node.textContent ?? ''
          for (let index = 0; index < text.length; index += 1) {
            const range = document.createRange()
            range.setStart(node, index)
            range.setEnd(node, index + 1)
            const box = range.getClientRects()[0]
            // A collapsed space at the end of a line has no box: it is not a character of the line.
            if (!box || box.width === 0) continue
            if (Number.isNaN(lineTop) || box.top > lineTop + box.height / 2) {
              lineTop = box.top
              lines.push(0)
            }
            lines[lines.length - 1] += 1
          }
        }
        if (lines.length < minimumLines) continue
        paragraphs += 1
        counts.push(...lines.slice(0, -1))
      }
      return { counts, paragraphs }
    },
    { limit: maxParagraphs, paragraphSelector: selector, minimumChars: minChars, minimumLines: minLines },
  )
  const sorted = [...result.counts].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const median = sorted.length === 0 ? 0 : sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
  return { counts: result.counts, median, paragraphs: result.paragraphs }
}

/** Where keyboard focus is, in the terms of the layout. */
export type Region = 'header' | 'skip' | 'left' | 'hero' | 'article' | 'rail' | 'end'

export type TabStop = {
  region: Region
  /** Tag, id and the start of the text, to read a failure. */
  label: string
  /** Page coordinates (viewport plus scroll) of the focused element's top left corner. */
  left: number
  top: number
  /** The like, save and share controls, by the ids and list the site has always had. */
  like: boolean
  save: boolean
  share: boolean
  /** The Share menu of the actions toolbar: below `sm` it stands in for the share list, which is not drawn there (`ShareMenu`, page.tsx). */
  shareMenu: boolean
}

async function focusedStop(page: Page): Promise<TabStop | null> {
  const labels = readerLabels()
  return page.evaluate((names) => {
    const node = document.activeElement
    if (!node || node === document.body) return null
    const within = (selector: string) => node.closest(selector) !== null
    // The order of the tests matters. The hero is a `<header>` INSIDE the article, so the site-header test excludes it and the hero
    // is tested first; the right rail is an `aside` inside the article, so it is tested before `article` as well.
    const region: Region = node.matches('a[href="#post-article"], a[href="#post-body"]')
      ? 'skip'
      : within('[data-reader-hero]')
        ? 'hero'
        : within('header:not([data-reader-hero])')
          ? 'header'
          : within(`aside[aria-label=${JSON.stringify(names.left)}]`)
            ? 'left'
            : within(`aside[aria-label=${JSON.stringify(names.rail)}]`)
              ? 'rail'
              : within('article#post-article')
                ? 'article'
                : 'end'
    const box = node.getBoundingClientRect()
    return {
      region,
      label: `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''} ${(node.textContent ?? '').trim().slice(0, 40)}`,
      left: box.left + window.scrollX,
      top: box.top + window.scrollY,
      like: within('#luot-thich'),
      save: within('#luu-bai'),
      share: within('ul[aria-labelledby="chia-se"]'),
      shareMenu: within('#luu-bai ~ div details'),
    }
  }, labels)
}

/** Tab from the top of the document, recording every stop, until the first stop in `until` (included). */
export async function walkTabStops(page: Page, until: Region = 'end', max = 400): Promise<TabStop[]> {
  await page.evaluate(() => {
    ;(document.activeElement as HTMLElement | null)?.blur()
    window.scrollTo(0, 0)
  })
  const stops: TabStop[] = []
  for (let press = 0; press < max; press += 1) {
    await page.keyboard.press('Tab')
    const stop = await focusedStop(page)
    if (stop === null) continue
    stops.push(stop)
    if (stop.region === until) return stops
  }
  throw new Error(
    `no stop in region "${until}" after ${max} Tab presses; last stops: ${stops
      .slice(-5)
      .map((s) => s.label)
      .join(' | ')}`,
  )
}

/** Press Tab until the given element has focus (the real keyboard path, so `:focus-visible` is true). */
export async function tabTo(page: Page, target: Locator, max = 400): Promise<void> {
  const handle = await target.elementHandle()
  if (handle === null) throw new Error(`${String(target)} is not in the page`)
  for (let press = 0; press < max; press += 1) {
    await page.keyboard.press('Tab')
    if (await page.evaluate((node) => document.activeElement === node, handle)) return
  }
  throw new Error(`${String(target)} was not reached in ${max} Tab presses`)
}

/**
 * After a skip link has been activated and Tab pressed once: is the focus inside `scope` (a CSS selector; default the article), and is
 * it the FIRST element a keyboard can reach in it (visible, not inside a closed `<details>` other than its summary, tabindex not
 * negative)? `#post-body` is the scope of the second skip link ("to the text").
 */
export async function focusIsFirstIn(
  page: Page,
  scope = '#post-article',
): Promise<{ inScope: boolean; isFirst: boolean; active: string; first: string }> {
  return page.evaluate((scopeSelector) => {
    const root = document.querySelector(scopeSelector)
    const describe = (node: Element | null) =>
      node === null
        ? 'none'
        : `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''} ${(node.textContent ?? '').trim().slice(0, 40)}`
    const inClosedDetails = (node: Element): boolean => {
      for (let up = node.parentElement; up; up = up.parentElement) {
        if (up.tagName === 'DETAILS' && !(up as HTMLDetailsElement).open) {
          const summary = up.querySelector(':scope > summary')
          if (!summary || !summary.contains(node)) return true
        }
      }
      return false
    }
    const usable = (node: Element) =>
      node.getClientRects().length > 0 &&
      getComputedStyle(node).visibility !== 'hidden' &&
      !inClosedDetails(node) &&
      (node as HTMLElement).tabIndex >= 0
    const selector =
      'a[href], button:not([disabled]), summary, input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]'
    const first = root ? ([...root.querySelectorAll(selector)].find(usable) ?? null) : null
    const active = document.activeElement
    return {
      inScope: root !== null && active !== null && root.contains(active),
      isFirst: first !== null && first === active,
      active: describe(active),
      first: describe(first),
    }
  }, scope)
}

/** What `readProgress` reads: the share of the post body that has scrolled by, 0..1. */
export async function readProgress(rail: Locator): Promise<number> {
  const value = rail.locator('[data-progress-value]')
  if (await value.isVisible()) {
    const digits = /\d+/.exec((await value.textContent()) ?? '')
    return digits === null ? Number.NaN : Number(digits[0]) / 100
  }
  // Below the `rail:` breakpoint: the fixed bar, drawn with a transform; the hidden meter has no box.
  return rail.locator('[style*="scaleX"]').evaluateAll((nodes) => {
    for (const node of nodes) {
      if (node.getBoundingClientRect().width === 0) continue
      return new DOMMatrixReadOnly(getComputedStyle(node).transform).a
    }
    return Number.NaN
  })
}

/** The page scroll position at which `[data-post-body]` has been read to `share` (0..1), the rule of lib/reading-progress.ts. */
export async function scrollYForProgress(page: Page, share: number): Promise<number> {
  return page.evaluate((target) => {
    const body = document.querySelector('[data-post-body]')
    if (!body) throw new Error('[data-post-body] was not found')
    const box = body.getBoundingClientRect()
    const scrollable = Math.max(box.height - window.innerHeight, 1)
    return window.scrollY + box.top + target * scrollable
  }, share)
}

/**
 * The focus outline of the focused element compared with the box of its nearest scroll container (the part that clips): returns the
 * outline's four edges and the scroller's client box, both in viewport coordinates, and the outline style so a missing ring is
 * a failure, not a silent pass.
 */
export async function outlineAndScroller(
  target: Locator,
): Promise<{ style: string; ring: Edges; scroller: Edges; scrollerTag: string }> {
  return target.evaluate((node) => {
    const box = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    const grow = Number.parseFloat(style.outlineOffset) + Number.parseFloat(style.outlineWidth)
    let scroller: HTMLElement | null = node.parentElement
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY + getComputedStyle(scroller).overflowX)) {
      scroller = scroller.parentElement
    }
    if (!scroller) throw new Error('the focused link has no scroll container')
    const frame = scroller.getBoundingClientRect()
    const left = frame.left + scroller.clientLeft
    const top = frame.top + scroller.clientTop
    return {
      style: style.outlineStyle,
      ring: { left: box.left - grow, right: box.right + grow, top: box.top - grow, bottom: box.bottom + grow },
      scroller: { left, right: left + scroller.clientWidth, top, bottom: top + scroller.clientHeight },
      scrollerTag: `${scroller.tagName.toLowerCase()}${scroller.hasAttribute('data-rail-sticky') ? '[data-rail-sticky]' : ''}${scroller.hasAttribute('data-toc-list') ? '[data-toc-list]' : ''}`,
    }
  })
}

/** Headings of level 2 to 4 in a markdown body, outside code fences: the entries a table of contents would list. */
export function headingCount(markdown: string): number {
  let fenced = false
  let count = 0
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    else if (!fenced && /^#{2,4}\s+\S/.test(line)) count += 1
  }
  return count
}

/** The first published post whose body has at least `min` headings, scanning at most `limit` posts; null when there is none. */
export async function findPostWithHeadings(backend: Backend, min: number, limit = 40): Promise<string | null> {
  for (const summary of (await backend.publishedPosts()).slice(0, limit)) {
    const post = await backend.post(summary.slug)
    if (headingCount(post.content) >= min) return summary.slug
  }
  return null
}

/** The markdown of a post with `sections` long headings (about every third one followed by a sub-heading) and a few paragraphs under each. */
export function longPostContent(sections: number): string {
  const paragraph =
    'A paragraph of the post, long enough to take several lines in the text column, so the page is tall and the scroll position moves ' +
    'through the table of contents one heading at a time while the rails stay where they are.'
  const parts: string[] = []
  for (let index = 1; index <= sections; index += 1) {
    parts.push(`## Section ${index}: a deliberately long heading that wraps in a narrow column`, paragraph, paragraph, paragraph)
    if (index % 3 === 0) parts.push(`### Detail ${index}: a nested heading under the section`, paragraph, paragraph)
  }
  return parts.join('\n\n')
}

const CHORE_STEP_MS = 15_000

/**
 * A PUBLISHED post with the given body, for the cases that need data the sample content may not have (a post with at least 15
 * headings, a standalone post of a category). Same recipe as createTemporaryPost (admin.ts): the draft is created through the API (a
 * draft is in no cache) and published through the admin UI, because only a Server Action refreshes the cached public lists. Clean it up
 * with `removeTemporaryPost` (admin.ts).
 */
export async function createPublishedPost(
  browser: Browser,
  backend: Backend,
  testInfo: TestInfo,
  input: { purpose: string; content: string; categoryId?: string; title?: string },
): Promise<TemporaryPost> {
  const stamp = Date.now()
  const title = input.title ?? `E2E post ${input.purpose} ${testInfo.project.name} ${stamp}`
  const draft = await backend.createDraftPost({
    title,
    content: input.content,
    excerpt: 'Temporary post of the E2E suite; deleted at the end of the spec.',
    categoryId: input.categoryId,
  })
  const post = { id: draft.id, slug: draft.slug, title }
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL })
  try {
    await applyLocale(context)
    const page = await context.newPage()
    await loginAsAdmin(page)
    await page.goto(`/admin/posts/${post.id}/edit`, { timeout: CHORE_STEP_MS })
    await page.getByRole('button', { name: msg('Admin.posts.row.publish'), exact: true }).click({ timeout: CHORE_STEP_MS })
    await expect(page.getByRole('status').first()).toHaveText(msgStart('Admin.editor.state.publishedAt'), {
      timeout: CHORE_STEP_MS,
    })
  } catch (error) {
    await removeTemporaryPost(browser, backend, testInfo, post).catch(() => {})
    throw error
  } finally {
    await context.close()
  }
  return post
}
