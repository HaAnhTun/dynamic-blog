import { expect, test } from './support/fixtures'
import {
  BROWSE_PATHS,
  CARD_PATHS,
  EXPLORE_CURRENT,
  FRAME_PATHS,
  GEOMETRY_WINDOWS,
  NOT_FOUND_PATHS,
  bandEdges,
  browseGrid,
  expectFrameAt,
  expectNear,
  exploreLinks,
  exploreNav,
  footerName,
  gapAboveFooter,
  logo,
  openPage,
  openSiteSidebar,
  setWidth,
  sidebarEyebrow,
  siteSidebar,
  textLeft,
  widestLongParagraph,
  type Family,
} from './support/frame'
import { msg } from './support/i18n'
import { expectNoOverflowNow } from './support/page'
import { edgesOf, frameGeometry, lineLengths, visibleHeaderHeight, widthOf } from './support/reader'

/**
 * The site-wide frame (spec 9, criteria 1 to 7, 11 and 12): header, `main` and footer are one bordered 1400px box on every public
 * page, BROWSE pages carry the shared sidebar, SHOWCASE pages line their bands up with the logo, CARD pages are a 768px card.
 *
 * The path list is `FRAME_PATHS` (e2e/support/frame.ts): the routes of overflow.spec.ts, the case-study page, a seeded post and the
 * global 404. Every width is a function of `document.documentElement.clientWidth` (a classic scrollbar takes about 15px), never of a
 * hard-coded window width; the windows around the 1400 cap and the 1424 hairline threshold are measured because the `frame:` media query
 * sees the window width WITH the scrollbar.
 *
 * Projects. `desktop` (1440x900) resizes its window for every width of 500px and more; `mobile` (390x844, isMobile emulation) runs the
 * 390 / 768 / 1024 cases, because a headless Chrome window cannot be narrower than about 500px. A case that has no meaning in a project says so
 * with `test.skip` and a reason. The English pass is `E2E_LOCALE=en` (paths, names and catalog text follow the locale).
 */

const FAMILY_NAME: Record<Family, string> = {
  browse: 'BROWSE',
  showcase: 'SHOWCASE',
  card: 'CARD',
  post: 'post',
  notfound: 'not found',
}

const ofFamily = (...families: Family[]) => FRAME_PATHS.filter(({ family }) => families.includes(family))

test.describe('Site frame: header, main and footer are one box', () => {
  for (const { path, family } of FRAME_PATHS) {
    test(`${path} (${FAMILY_NAME[family]}): same edges, 1400px from 1424, hairlines only from 1424`, async ({
      page,
      isMobile,
    }) => {
      test.skip(isMobile, 'the geometry windows are desktop widths')
      await openPage(page, path)
      for (const width of GEOMETRY_WINDOWS) {
        await setWidth(page, width)
        await expectFrameAt(page, `${path} @${width}px`)
      }
    })
  }

  test('the hairlines: none at 1400 and 1423 (the frame is the layout width), two from 1424 with a margin to the screen edge', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, 'a window of 1400px and more is a desktop case')
    await openPage(page, '/writing')
    for (const [width, drawn] of [
      [1400, false],
      [1423, false],
      [1424, true],
      [1425, true],
    ] as const) {
      await setWidth(page, width)
      const g = await frameGeometry(page)
      expect(g.frame.borderLeft, `${width}px: left hairline of the frame`).toBe(drawn ? 1 : 0)
      expect(g.header.borderRight, `${width}px: right hairline of the header Container`).toBe(drawn ? 1 : 0)
      expect(g.footer.borderLeft, `${width}px: left hairline of the footer Container`).toBe(drawn ? 1 : 0)
      // The frame never leaves less than 4px of margin to a hairline (a scrollbar takes up to 15px of the 1424).
      if (drawn) expect(g.frame.edges.left, `${width}px: margin left of the frame`).toBeGreaterThanOrEqual(4 - 1)
    }
  })
})

test.describe('Site frame: landmarks', () => {
  for (const { path } of FRAME_PATHS) {
    test(`${path}: one main, one banner, one contentinfo`, async ({ page }) => {
      await openPage(page, path)
      await expect(page.getByRole('main')).toHaveCount(1)
      await expect(page.getByRole('banner')).toHaveCount(1)
      await expect(page.getByRole('contentinfo')).toHaveCount(1)
    })
  }
})

test.describe('Site frame: text edges', () => {
  for (const { path, family } of FRAME_PATHS) {
    test(`${path} (${FAMILY_NAME[family]}): logo, footer name${
      family === 'browse' || family === 'post' ? ', sidebar text' : family === 'showcase' ? ' and every band' : ''
    } start at one x`, async ({ page, isMobile }) => {
      test.skip(isMobile, 'text edges are compared at desktop windows (the phone has no sidebar column)')
      await openPage(page, path)
      for (const width of [1280, 1440, 1920]) {
        await setWidth(page, width)
        const label = `${path} @${width}px`
        const logoLeft = await textLeft(logo(page))
        expectNear(await textLeft(footerName(page)), logoLeft, 1, `${label}: footer name against the logo`)
        if (family === 'browse' || family === 'post') {
          expectNear(await textLeft(sidebarEyebrow(page)), logoLeft, 1, `${label}: sidebar text against the logo`)
        }
        if (family === 'showcase') {
          const bands = await bandEdges(page)
          expect(bands.length, `${label}: bands with a heading`).toBeGreaterThanOrEqual(2)
          for (const band of bands) expectNear(band.left, logoLeft, 1, `${label}: band "${band.heading}" against the logo`)
        }
      }
    })
  }
})

test.describe('Site frame: no horizontal overflow', () => {
  for (const { path } of FRAME_PATHS) {
    test(`${path}: 390 / 768 / 1024 / 1280 / 1440 / 1920`, async ({ page, isMobile }) => {
      test.setTimeout(120_000)
      // The phone project emulates 390, 768 and 1024; the desktop project resizes its window from 768 up (together: the six widths).
      await openPage(page, path)
      for (const width of isMobile ? [390, 768, 1024] : [768, 1024, 1280, 1440, 1920]) {
        await setWidth(page, width, 800)
        await expectNoOverflowNow(page, `${path} @${width}px`)
      }
    })
  }
})

test.describe('Site frame: text measure', () => {
  /** Open text (a lead, a description, a paragraph of an article): 60 to 75 characters a line. */
  const OPEN: { path: string; selector: string; what: string }[] = [
    { path: '/start-here', selector: '#page-content > header p', what: 'lead' },
    { path: '/series/xay-blog-nay', selector: '#page-content > header h1 + p', what: 'series description' },
    { path: '/case-studies/example-case-study', selector: '#page-content article section p', what: 'case-study paragraphs' },
    { path: '/about', selector: '#main-content h1 + p', what: 'intro' },
    { path: '/', selector: '#main-content h1 + p', what: 'hero subline' },
  ]
  /** Text inside a narrow card (home introduction, about cards, topics cards, case-study cards): 45 to 75 characters a line. */
  const CARD: { path: string; selector: string; what: string; optional?: boolean }[] = [
    { path: '/', selector: '#main-content section[aria-labelledby="gioi-thieu"] p', what: 'introduction card' },
    { path: '/about', selector: '#main-content section.rounded-card p', what: 'section cards' },
    // A topic card has a paragraph only when the category has a description, and the shared E2E data has none.
    { path: '/topics', selector: '#page-content .rounded-card p', what: 'topic cards', optional: true },
    { path: '/case-studies', selector: '#page-content .rounded-card p', what: 'case-study cards' },
  ]
  const WINDOWS = [1440, 1280, 1100]

  for (const [kind, targets, [low, high]] of [
    ['open text', OPEN, [60, 75]],
    ['card text', CARD, [45, 75]],
  ] as const) {
    for (const target of targets) {
      const { path, selector, what } = target
      const optional = 'optional' in target && target.optional === true
      test(`${path}: ${what} is ${low} to ${high} characters a line (${kind})`, async ({ page, isMobile }, testInfo) => {
        test.skip(isMobile, 'the measure is checked at desktop windows')
        await openPage(page, path)
        test.skip(optional && (await page.locator(selector).count()) === 0, `${what}: the data has no such paragraph`)
        expect(await page.locator(selector).count(), `${selector} matches nothing: the hook has moved`).toBeGreaterThan(0)
        for (const width of WINDOWS) {
          await setWidth(page, width)
          const measure = await lineLengths(page, 6, { selector, minChars: 60, minLines: 2 })
          if (measure.counts.length === 0) {
            // Text shorter than one full line has no measure; say so instead of passing silently.
            testInfo.annotations.push({ type: 'not measured', description: `${path} @${width}px: ${what} wraps on no full line` })
            continue
          }
          expect(
            measure.median,
            `${path} @${width}px ${what}: median ${measure.median} of [${measure.counts.join(', ')}] characters a line`,
          ).toBeGreaterThanOrEqual(low)
          expect(measure.median, `${path} @${width}px ${what}: median line is too long`).toBeLessThanOrEqual(high)
        }
      })
    }
  }

  for (const { path } of ofFamily('browse', 'showcase', 'card', 'notfound')) {
    test(`${path}: no paragraph of more than 200 characters is wider than 46rem`, async ({ page, isMobile }) => {
      test.skip(isMobile, 'the cap is read at the desktop window')
      await openPage(page, path)
      const widest = await widestLongParagraph(page)
      expect(widest.width, `a paragraph of the page is ${widest.width}px wide: "${widest.text}"`).toBeLessThanOrEqual(46 * 16 + 1)
    })
  }
})

test.describe('Site frame: the gap above the footer', () => {
  for (const { path } of FRAME_PATHS) {
    test(`${path}: at least 40px between the last content and the footer`, async ({ page, isMobile }) => {
      test.skip(isMobile, 'measured at the 1440 window')
      await openPage(page, path)
      await setWidth(page, 1440)
      expect(await gapAboveFooter(page), 'space under the last block of the page').toBeGreaterThanOrEqual(40 - 1)
    })
  }
})

test.describe('Site frame: the BROWSE sidebar', () => {
  for (const path of BROWSE_PATHS) {
    test(`${path}: 260 / 224 wide, tinted, as tall as the grid, one Explore navigation`, async ({ page, isMobile }) => {
      test.skip(isMobile, 'the sidebar column exists from a 1024px window')
      await openPage(page, path)
      for (const [width, track] of [
        [1440, 260],
        [1280, 260],
        [1100, 224],
        [1024, 224],
      ] as const) {
        await setWidth(page, width)
        const label = `${path} @${width}px`
        const sidebar = siteSidebar(page)
        await expect(sidebar, label).toBeVisible()
        const [side, grid] = [await edgesOf(sidebar), await edgesOf(browseGrid(page))]
        expectNear(widthOf(side), track, 1, `${label}: sidebar width`)
        // Tinted, with a hairline on its inner edge, as tall as the page grid (a short page too): the tint reaches the footer or the band.
        expect(await sidebar.evaluate((node) => getComputedStyle(node).backgroundColor), `${label}: sidebar tint`).not.toBe(
          'rgba(0, 0, 0, 0)',
        )
        await expect(sidebar, `${label}: sidebar inner hairline`).toHaveCSS('border-inline-end-width', '1px')
        expectNear(side.bottom, grid.bottom, 1, `${label}: sidebar bottom against the grid bottom`)
        expectNear(side.top, grid.top, 1, `${label}: sidebar top against the grid top`)
        // The grid reaches what is under it: a discovery band (/writing, /search) or the footer.
        const next = browseGrid(page).locator('xpath=following-sibling::*[1]')
        const below = (await next.count()) > 0 ? (await edgesOf(next)).top : (await frameGeometry(page)).footer.edges.top
        expectNear(grid.bottom, below, 1, `${label}: grid bottom against the band or the footer`)
        // Criterion 12: exactly one Explore navigation (the hidden twin is out of the accessibility tree), inside the sidebar.
        await expect(exploreNav(page), `${label}: Explore navigations`).toHaveCount(1)
        await expect(page.getByRole('navigation', { name: msg('Site.reader.exploreTitle'), exact: true }), label).toHaveCount(1)
      }
    })
  }

  test('/writing: the sidebar scroller sticks under the visible part of the header, on the way down and on the way up', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, 'the sticky sidebar is a desktop case')
    await openPage(page, '/writing')
    await setWidth(page, 1440, 700)
    const sticky = siteSidebar(page).locator('[data-rail-sticky]')
    await expect(sticky).toBeVisible()
    const scrollable = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)
    test.skip(scrollable < 600, 'the list is shorter than the window on this stack, nothing scrolls')
    const stuckUnderHeader = async () => Math.abs((await edgesOf(sticky)).top - (await visibleHeaderHeight(page)))
    const reference = await edgesOf(sticky)
    expect(reference.top, 'at the top of the page the scroller starts right under the header').toBeGreaterThanOrEqual(0)
    for (const [y, step] of [
      [500, 'after a scroll down (the header slides away)'],
      [350, 'after a scroll up (the header is back)'],
    ] as const) {
      await page.evaluate((to) => window.scrollTo(0, to), y)
      await expect.poll(stuckUnderHeader, { message: `scroller top against the visible header ${step}` }).toBeLessThanOrEqual(1)
      expect((await edgesOf(sticky)).bottom, `scroller stays inside the window ${step}`).toBeLessThanOrEqual(700 + 1)
    }
  })

  for (const path of BROWSE_PATHS) {
    test(`${path}: below 1024 the sidebar is a closed card of at least 44px above the page, and it opens`, async ({
      page,
      isMobile,
    }) => {
      await openPage(page, path)
      const current = EXPLORE_CURRENT.find((row) => row.path === path)
      const currentLabel = current?.key ? exploreLinks().find((link) => link.key === current.key)?.label : undefined
      for (const width of isMobile ? [390, 768] : [768]) {
        await setWidth(page, width)
        const label = `${path} @${width}px`
        const sidebar = siteSidebar(page)
        const card = sidebar.locator('details[data-rail-phone]')
        const summary = card.locator(':scope > summary')
        await expect(card, `${label}: the closed card`).toBeVisible()
        await expect(card, `${label}: closed`).not.toHaveAttribute('open', '')
        await expect(sidebar.locator('[data-rail-sticky]'), `${label}: the desktop copy is not drawn`).toBeHidden()
        const box = await edgesOf(card)
        expect(box.bottom - box.top, `${label}: card height`).toBeGreaterThanOrEqual(44 - 0.5)
        expect((await edgesOf(summary)).bottom - (await edgesOf(summary)).top, `${label}: summary height`).toBeGreaterThanOrEqual(
          44 - 0.5,
        )
        // Above the page: the sidebar is the first grid child, so the card sits over the page column.
        expect(box.bottom, `${label}: card above the page column`).toBeLessThanOrEqual(
          (await edgesOf(page.locator('#page-content'))).top + 1,
        )
        // The summary names the section (or just "Explore" when the page stands for none).
        await expect(summary, `${label}: summary text`).toContainText(
          currentLabel ? msg('Site.frame.summary', { current: currentLabel }) : msg('Site.reader.exploreTitle'),
        )

        const opened = await openSiteSidebar(page)
        await expect(
          opened.getByRole('navigation', { name: msg('Site.reader.exploreTitle'), exact: true }).getByRole('link'),
        ).toHaveCount(5)
        // Close it again for the next width.
        await summary.click()
        await expect(card, `${label}: closed again`).not.toHaveAttribute('open', '')
      }
    })
  }
})

test.describe('Site frame: the CARD pages', () => {
  for (const { path } of ofFamily('card', 'notfound')) {
    test(`${path}: one 768px column centred in the frame`, async ({ page, isMobile }) => {
      test.skip(isMobile, 'measured at the 1440 window')
      await openPage(page, path)
      await setWidth(page, 1440)
      const g = await frameGeometry(page)
      const column = await edgesOf(page.locator('#main-content > :not(script)').first())
      expectNear(widthOf(column), 768, 1, `${path}: the card column width`)
      expectNear(
        (column.left + column.right) / 2,
        (g.frame.edges.left + g.frame.edges.right) / 2,
        1,
        `${path}: the column is centred`,
      )
      await expect(page.locator('#main-content').getByRole('heading', { level: 1 }), `${path}: one h1`).toHaveCount(1)
    })
  }

  test('no CARD page and no home or about page has the sidebar of a BROWSE page', async ({ page, isMobile }) => {
    test.skip(isMobile, 'one window is enough')
    for (const path of [...CARD_PATHS, ...NOT_FOUND_PATHS, '/', '/about']) {
      await openPage(page, path)
      await expect(siteSidebar(page), path).toHaveCount(0)
    }
  })
})

test.describe('Site frame: the home page', () => {
  /** The ids of the section headings, in DOM order (`series` and `anh` are optional: a blog without published series or photos has no such block). */
  const SECTION_IDS = ['gioi-thieu', 'bai-viet', 'chang-duong', 'hien-tai', 'lien-he']

  test('the DOM order of the headings: hero, introduction, posts, series, journey, now, photos, contact (no skills section)', async ({
    page,
  }) => {
    await openPage(page, '/')
    const headings = await page.evaluate(() =>
      [...document.querySelectorAll('#main-content h1, #main-content h2[id]')].map(
        (node) => `${node.tagName.toLowerCase()}#${node.id}`,
      ),
    )
    expect(headings[0], 'the first heading of the page is the hero h1').toMatch(/^h1/)
    const ids = headings.map((entry) => entry.split('#')[1])
    expect(
      ids.filter((id) => SECTION_IDS.includes(id)),
      `headings: ${headings.join(', ')}`,
    ).toEqual(SECTION_IDS)
    expect(ids, 'the home page carries no skills section').not.toContain('ky-nang')
    if (ids.includes('series')) {
      expect(ids.indexOf('series'), 'the series sit right after the posts').toBe(ids.indexOf('bai-viet') + 1)
    }
    if (ids.includes('anh')) {
      expect(ids.indexOf('anh'), 'photos sit between the journey and the contact').toBeGreaterThan(ids.indexOf('hien-tai'))
      expect(ids.indexOf('anh')).toBeLessThan(ids.indexOf('lien-he'))
    }
  })

  test('at 1440 the two cells of rows A and B are within 2.2 : 1 in height (row C is a wide journey beside a short card)', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, 'the pair rows exist from lg')
    await openPage(page, '/')
    await setWidth(page, 1440)
    const bands = page.locator('#main-content > div')
    for (const [index, name] of [
      [0, 'A hero + introduction'],
      [1, 'B posts + series'],
    ] as const) {
      const cells = bands.nth(index).locator(':scope > div > *')
      // Row B is a single cell (the posts at full width) when the blog has no published series yet.
      if (index === 1 && (await cells.count()) === 1) continue
      await expect(cells, `row ${name}: two cells`).toHaveCount(2)
      const heights = [await edgesOf(cells.nth(0)), await edgesOf(cells.nth(1))].map((box) => box.bottom - box.top)
      const ratio = Math.max(...heights) / Math.min(...heights)
      expect(ratio, `row ${name}: cell heights ${heights.map(Math.round).join(' and ')}`).toBeLessThanOrEqual(2.2)
    }
  })
})
