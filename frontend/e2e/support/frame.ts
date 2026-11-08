import { expect, type Locator, type Page } from '@playwright/test'
import { localePath, msg } from './i18n'
import {
  centreOf,
  FRAME_BORDER_FROM,
  footerContainer,
  frameGeometry,
  headerContainer,
  READER_FRAME_MAX,
  setViewport,
  settle,
  widthOf,
  type FrameGeometry,
} from './reader'

/**
 * Helpers of e2e/site-frame.spec.ts and e2e/navigation.spec.ts: the path list of the site-wide frame, the family of each path
 * (BROWSE, SHOWCASE, CARD, post, not found), the Explore group each BROWSE path marks, and the measurements that are not specific to
 * the post page (frame geometry across window widths, text edges, the bands of the home page, the sidebar of a BROWSE page).
 *
 * Hooks are structural, as in e2e/support/reader.ts: `#main-content` is the frame, the header and footer Containers are the `div` child of
 * the banner and contentinfo landmarks, the sidebar is the complementary region named `Site.frame.sidebarLabel`, the page column of a
 * BROWSE page is `#page-content`, its grid is the `div` of `main` that has an `aside` child. Catalog text is read when a helper is called.
 */

/** The page shapes of the spec: BROWSE (sidebar + column), SHOWCASE (home, about), CARD (a 768px card), the post, a 404. */
export type Family = 'browse' | 'showcase' | 'card' | 'post' | 'notfound'

export const BROWSE_PATHS = [
  '/writing',
  '/writing?page=1',
  '/start-here',
  '/series',
  '/series/xay-blog-nay',
  '/series/pipeline-bat-dong-bo-tren-aws',
  '/topics',
  '/archive',
  '/gallery',
  '/case-studies',
  '/case-studies/example-case-study',
  '/search',
  '/search?q=queue',
  '/categories/kien-truc',
  '/tags/aws',
  // Saved posts, as a guest sees them (the sign-in invitation): the shortest BROWSE page, so the stretched sidebar shows.
  '/bookmarks',
]

export const SHOWCASE_PATHS = ['/', '/about']

export const CARD_PATHS = [
  '/login',
  '/login?error=state',
  '/profile',
  '/notifications',
  '/newsletter',
  // The two token pages as a reader opens them from a mail (button not yet clicked, nothing called).
  '/newsletter/confirm?token=e2e-khong-phai-token-that-0123456789',
  '/newsletter/unsubscribe?token=e2e-khong-phai-token-that-0123456789',
]

/** A post that does not exist, a profile that does not exist (both in-group 404s) and a path no route matches (the global 404). */
export const NOT_FOUND_PATHS = ['/posts/khong-co-bai-nay-e2e', '/u/khong-co-nguoi-nay-e2e', '/khong-co-trang-nay']

/** The longest post of the sample data: a table of contents, more than four screens, a discovery band. */
export const POST_PATH = '/posts/khi-nao-nen-them-mot-queue'

/** The routes e2e/overflow.spec.ts has always measured (every public page family, with the seed data it relies on). */
export const PUBLIC_ROUTES = [
  '/',
  ...BROWSE_PATHS.filter((path) => path !== '/case-studies/example-case-study'),
  '/about',
  ...CARD_PATHS,
  ...NOT_FOUND_PATHS.filter((path) => path !== '/khong-co-trang-nay'),
]

/** Every path of the frame spec: the routes above, the case-study page, a seeded post and the global 404 (acceptance 9). */
export const FRAME_PATHS: { path: string; family: Family }[] = [
  ...SHOWCASE_PATHS.map((path) => ({ path, family: 'showcase' as const })),
  ...BROWSE_PATHS.map((path) => ({ path, family: 'browse' as const })),
  ...CARD_PATHS.map((path) => ({ path, family: 'card' as const })),
  ...NOT_FOUND_PATHS.map((path) => ({ path, family: 'notfound' as const })),
  { path: POST_PATH, family: 'post' },
]

/** The window widths of the geometry checks: either side of the 1400 cap and of the 1424 hairline threshold (89rem). */
export const GEOMETRY_WINDOWS = [1280, 1400, 1423, 1424, 1425, 1440, 1500, 1920]

/** The five rows of the Explore group, in order, with the page each stands for (hrefs without the locale prefix). */
export type ExploreKey = 'latest' | 'series' | 'topics' | 'archive' | 'best'

export function exploreLinks(): { key: ExploreKey; href: string; label: string }[] {
  return [
    { key: 'latest', href: '/writing', label: msg('Site.listing.sectionNav.latest') },
    { key: 'series', href: '/series', label: msg('Site.listing.sectionNav.series') },
    { key: 'topics', href: '/topics', label: msg('Site.listing.sectionNav.topics') },
    { key: 'archive', href: '/archive', label: msg('Site.listing.sectionNav.archive') },
    { key: 'best', href: '/start-here', label: msg('Site.footer.links.startHere') },
  ]
}

/**
 * The Explore row each BROWSE page marks (spec 4.2): `page` on the section's own page, `true` on a child of it (a series, a category,
 * a tag), `null` for a page that stands for no section. The path is the page, query strings included.
 */
export const EXPLORE_CURRENT: { path: string; key: ExploreKey | null; current: 'page' | 'true' | null }[] = [
  { path: '/writing', key: 'latest', current: 'page' },
  { path: '/writing?page=1', key: 'latest', current: 'page' },
  { path: '/series', key: 'series', current: 'page' },
  { path: '/series/xay-blog-nay', key: 'series', current: 'true' },
  { path: '/series/pipeline-bat-dong-bo-tren-aws', key: 'series', current: 'true' },
  { path: '/topics', key: 'topics', current: 'page' },
  { path: '/categories/kien-truc', key: 'topics', current: 'true' },
  { path: '/tags/aws', key: 'topics', current: 'true' },
  { path: '/archive', key: 'archive', current: 'page' },
  { path: '/start-here', key: 'best', current: 'page' },
  { path: '/gallery', key: null, current: null },
  { path: '/search', key: null, current: null },
  { path: '/search?q=queue', key: null, current: null },
  { path: '/bookmarks', key: null, current: null },
  { path: '/case-studies', key: null, current: null },
  { path: '/case-studies/example-case-study', key: null, current: null },
]

/**
 * Go to a public path of the locale under test and wait until the page is laid out and hydrated: the frame is visible, the header
 * height is measured (`--site-header-h`, written by useStickyHeader) and the web font has loaded (Inter is wider than the fallback).
 */
export async function openPage(page: Page, path: string): Promise<void> {
  await page.goto(localePath(path))
  await expect(page.locator('#main-content')).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--site-header-h')))
    .toMatch(/^\d+(\.\d+)?px$/)
  await page.evaluate(() => document.fonts.ready)
  await settle(page)
}

/** Move to a window width: a real resize from 500px, device emulation below it (a headless Chrome window cannot be narrower). */
export async function setWidth(page: Page, width: number, height = 900): Promise<void> {
  if (width >= 500) return setViewport(page, width, height)
  await page.setViewportSize({ width, height })
  await settle(page)
}

/** `actual` is within `tolerance` of `expected`; the message prints both numbers. */
export function expectNear(actual: number, expected: number, tolerance: number, what: string): void {
  expect(Math.abs(actual - expected), `${what}: ${actual} against ${expected} (tolerance ${tolerance})`).toBeLessThanOrEqual(
    tolerance,
  )
}

/**
 * Header Container, `main` and footer Container are one box (acceptance 1 and 2): the frame is `min(1400, client width)` wide and
 * centred on the client axis; the header and footer Containers have the same OUTER left and right edges (+-1); from the `frame:`
 * breakpoint (a 1424px WINDOW, scrollbar included) all three draw a 1px hairline on each side, below it none; from that window the
 * frame is exactly 1400 wide. Returns the frame width and the hairline width.
 */
export function expectFrameAligned(g: FrameGeometry, label: string): { width: number; borders: number } {
  const width = Math.min(READER_FRAME_MAX, g.clientWidth)
  const borders = g.innerWidth >= FRAME_BORDER_FROM ? 1 : 0
  const frame = g.frame.edges
  expectNear(widthOf(frame), width, 1, `${label}: frame width`)
  expectNear(centreOf(frame), g.clientWidth / 2, 1, `${label}: frame centre against the client axis`)
  if (g.innerWidth >= FRAME_BORDER_FROM)
    expectNear(widthOf(frame), READER_FRAME_MAX, 0.5, `${label}: the frame is at its 1400px cap`)
  if (g.clientWidth <= READER_FRAME_MAX)
    expectNear(frame.left, 0, 1, `${label}: the frame is the window, flush with the screen edge`)
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
    expect(box.borderLeft, `${label}: ${name} left hairline`).toBe(borders)
    expect(box.borderRight, `${label}: ${name} right hairline`).toBe(borders)
  }
  return { width, borders }
}

/** Measure and check the frame of the page that is open (a shortcut for `expectFrameAligned(await frameGeometry(page))`). */
export async function expectFrameAt(page: Page, label: string): Promise<{ width: number; borders: number }> {
  return expectFrameAligned(await frameGeometry(page), label)
}

/** The left edge of the first drawn character of an element (not its box: a card's padding is not part of a text edge). */
export async function textLeft(locator: Locator): Promise<number> {
  return locator.evaluate((node) => {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      if ((text.textContent ?? '').trim() === '') continue
      const range = document.createRange()
      range.selectNodeContents(text)
      const box = range.getClientRects()[0]
      if (box && box.width > 0) return box.left
    }
    throw new Error('the element has no drawn text')
  })
}

/** The site name in the header: the first link inside the header Container (the skip link sits outside it). */
export function logo(page: Page): Locator {
  return headerContainer(page).getByRole('link').first()
}

/** The site name in the footer: the first paragraph of the footer Container. */
export function footerName(page: Page): Locator {
  return footerContainer(page).locator('p').first()
}

/** The eyebrow of the Explore group in the visible (desktop) copy of a sidebar: the sidebar's own text edge. Post page and BROWSE pages alike. */
export function sidebarEyebrow(page: Page): Locator {
  return page.locator('#rail-explore')
}

/**
 * The text edge of each band of a SHOWCASE page, in the DOM order of the bands (the `div` children of `main`). A band's edge is the first
 * heading's first drawn character, or the box of the card the heading sits in (a card draws its own padding; its box edge is what lines
 * up). One band is read differently, by structure: when the heading sits in a later column of a multi-column grid (the hero of the About
 * page from `lg`: the person in a 13rem column at the page edge, the title in the second column, 17rem further right with the column gap,
 * by design), the edge is the first drawn character of the FIRST column, so a heading that is out of line anywhere else still fails.
 * Bands without a heading (a nav of links) are left out.
 */
export async function bandEdges(page: Page): Promise<{ heading: string; left: number }[]> {
  return page.evaluate(() => {
    const main = document.querySelector('#main-content')!
    // The left edge of the first drawn character under `root`: a visually hidden label (a 1px clipped box) has a text position of its own and is no edge.
    const firstDrawnLeft = (root: Element) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        if ((text.textContent ?? '').trim() === '') continue
        const holder = text.parentElement?.getBoundingClientRect()
        if (!holder || holder.width <= 2 || holder.height <= 2) continue
        const range = document.createRange()
        range.selectNodeContents(text)
        const box = range.getClientRects()[0]
        if (box && box.width > 0) return box.left
      }
      return Number.NaN
    }
    /** The first column of the multi-column grid whose later column holds `heading`, inside `band`; null when the heading is in no later column. */
    const firstColumnOf = (heading: Element, band: Element) => {
      for (let node: Element = heading; node !== band && node.parentElement; node = node.parentElement) {
        const parent = node.parentElement
        if (parent === band) break
        const columns = getComputedStyle(parent).gridTemplateColumns
        if (
          getComputedStyle(parent).display === 'grid' &&
          columns.trim().split(/\s+/).length > 1 &&
          parent.firstElementChild !== node
        )
          return parent.firstElementChild
      }
      return null
    }
    const edges: { heading: string; left: number }[] = []
    for (const band of main.children) {
      if (band.tagName !== 'DIV') continue
      const heading = band.querySelector('h1, h2')
      if (!heading) continue
      const card = heading.closest('.rounded-card')
      const left = card ? card.getBoundingClientRect().left : firstDrawnLeft(firstColumnOf(heading, band) ?? heading)
      edges.push({ heading: (heading.textContent ?? '').trim().slice(0, 40), left })
    }
    return edges
  })
}

/** The page grid of a BROWSE page: the `div` of `main` that holds the sidebar and the page column. */
export function browseGrid(page: Page): Locator {
  return page.locator('#main-content > div:has(> aside)')
}

/** The sidebar of a BROWSE page: the complementary region named `Site.frame.sidebarLabel` (one visible copy at a time). */
export function siteSidebar(page: Page): Locator {
  return page.getByRole('complementary', { name: msg('Site.frame.sidebarLabel') })
}

/** The Explore navigation of a BROWSE page: a `navigation` named `Site.reader.exploreTitle` inside the sidebar. */
export function exploreNav(page: Page): Locator {
  return siteSidebar(page).getByRole('navigation', { name: msg('Site.reader.exploreTitle'), exact: true })
}

/**
 * Open the sidebar where it is a closed card and return its `aside`. Below `lg` the sidebar is ONE `<details data-rail-phone>` card and
 * Playwright's role queries do not see inside a closed one, so its summary is pressed first; from `lg` the card is `display:none`,
 * its summary is not visible and nothing is clicked (same rule as `openLeftRail` of the post page).
 */
export async function openSiteSidebar(page: Page): Promise<Locator> {
  const sidebar = siteSidebar(page)
  const summary = sidebar.locator('[data-rail-phone] > summary')
  if (await summary.isVisible()) {
    const card = sidebar.locator('details[data-rail-phone]')
    if (!(await card.evaluate((node) => (node as HTMLDetailsElement).open))) await summary.click()
  }
  return sidebar
}

/**
 * The space between the last drawn content of the page and the footer, in CSS px: the footer's top minus the lowest bottom of any leaf
 * element of `main` outside the sidebars (a leaf is an element with no element children). The frame hairlines touch the footer, so the
 * air above it is each page's own bottom padding (spec risk 1).
 */
export async function gapAboveFooter(page: Page): Promise<number> {
  return page.evaluate(() => {
    const main = document.querySelector('#main-content')!
    const footer = document.querySelector('footer')!
    let bottom = 0
    for (const node of main.querySelectorAll('*')) {
      if (node.children.length > 0 || node.closest('aside')) continue
      const box = node.getBoundingClientRect()
      if (box.width === 0 || box.height === 0) continue
      if (getComputedStyle(node).position === 'fixed') continue
      bottom = Math.max(bottom, box.bottom)
    }
    return footer.getBoundingClientRect().top - bottom
  })
}

/** The widest `p` of more than 200 characters in `main`, in CSS px, with its text start: the reading measure cap (46rem = 736px). */
export async function widestLongParagraph(page: Page): Promise<{ width: number; text: string }> {
  return page.evaluate(() => {
    let widest = { width: 0, text: '' }
    for (const paragraph of document.querySelectorAll('#main-content p')) {
      const text = (paragraph.textContent ?? '').trim()
      if (text.length <= 200) continue
      const width = paragraph.getBoundingClientRect().width
      if (width > widest.width) widest = { width, text: text.slice(0, 40) }
    }
    return widest
  })
}
