import { expect, type Locator, type Page } from '@playwright/test'

/**
 * Waits until React has hydrated `element`: React puts its props on a DOM node (`__reactProps$...`) when it takes the node over from
 * the server HTML. A spec that sets a caret, a selection or a value by script right after `goto` must wait for this, or the hydration
 * can overwrite what it did (the textarea of the post editor loses its caret and an image lands at the top of the text).
 *
 * The `__reactProps$` key is an internal of React, not a documented API. Checked against React 19.3.0 (`react-dom`, the version of
 * `package.json`). When React is upgraded and every wait using this helper starts to time out with "has not been hydrated by React", look
 * here first: print `Object.keys(node)` of a hydrated element and follow the new name.
 */
export async function waitForHydration(element: Locator): Promise<void> {
  await expect
    .poll(() => element.evaluate((node) => Object.keys(node).some((key) => key.startsWith('__reactProps$'))), {
      message: 'the element has not been hydrated by React',
    })
    .toBe(true)
}

/**
 * Sizes the window so that the PAGE is `width` wide. The site reserves the scrollbar gutter (`scrollbar-gutter: stable`), and the desktop
 * project's Chrome draws a classic 15px scrollbar: in a 320px window the page is 305px wide, a width no phone has (a phone's scrollbar is
 * an overlay and takes nothing). The window is widened by what the gutter takes, so a "320px" header or layout case measures a 320px page
 * in both projects; on the phone project nothing is added.
 *
 * Only for a width far from a breakpoint: media queries test the WINDOW, which is the gutter wider than the page, so `setLayoutWidth(page, 767, ...)`
 * is a 782px window where `md:` applies. A case at a breakpoint (639, 767) sets the window with `page.setViewportSize`.
 */
export async function setLayoutWidth(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height })
  const gutter = await page.evaluate(
    (target) => Math.max(0, target - Math.round(document.body.getBoundingClientRect().width)),
    width,
  )
  if (gutter > 0) await page.setViewportSize({ width: width + gutter, height })
}

/** The real size of an `<img>` once loaded (next/image: the optimized version, the same ratio). */
export async function naturalSize(image: Locator): Promise<{ width: number; height: number }> {
  await expect(image).toBeVisible()
  await expect
    .poll(() => image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0), {
      message: 'image has not finished loading',
    })
    .toBe(true)
  return image.evaluate((node: HTMLImageElement) => ({ width: node.naturalWidth, height: node.naturalHeight }))
}

/**
 * The document width compared with the viewport. Measured after the web font has loaded: Inter is wider than the fallback font,
 * and a real horizontal overflow only shows once the text is in the right font.
 *
 * Compared with `clientWidth` (the layout viewport), NOT with `innerWidth`: when emulating a phone
 * (`isMobile`), Chrome widens `innerWidth` to the overflowing content — measured 600 with a 600px block in a
 * 320 frame — so `scrollWidth <= innerWidth` is always true and the check becomes meaningless. `clientWidth`
 * stays at 320. The "the measurement catches horizontal overflow" test in overflow.spec.ts pins this.
 */
export async function horizontalExtent(page: Page): Promise<{ scrollWidth: number; clientWidth: number; innerWidth: number }> {
  return page.evaluate(async () => {
    await document.fonts.ready
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      innerWidth: window.innerWidth,
    }
  })
}

/**
 * The element sticking out past the right edge, so a failure points straight at the culprit instead of a number. An element inside a box
 * that scrolls or clips on its own (a code block, a table frame) is not listed: it cannot widen the page, and listing it hid the culprit.
 */
export async function offenders(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const limit = document.documentElement.clientWidth
    const clipped = (node: Element) => {
      for (let parent = node.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        if (getComputedStyle(parent).overflowX !== 'visible') return true
      }
      return false
    }
    return [...document.querySelectorAll('body *')]
      .filter((node) => node.getBoundingClientRect().right > limit + 0.5 && !clipped(node))
      .slice(0, 5)
      .map(
        (node) =>
          `${node.tagName.toLowerCase()}.${String(node.className).slice(0, 60)} → ${Math.round(node.getBoundingClientRect().right)}px`,
      )
  })
}

/** Measure the page that is open, without reloading: an open form or panel keeps its state at measuring time. */
export async function expectNoOverflowNow(page: Page, label: string): Promise<void> {
  const { scrollWidth, clientWidth } = await horizontalExtent(page)
  const culprits = scrollWidth > clientWidth ? await offenders(page) : []
  expect.soft(scrollWidth, `${label} overflows horizontally: ${culprits.join(' | ')}`).toBeLessThanOrEqual(clientWidth)
}

export type SeoHead = {
  title: string
  description: string | null
  canonical: string | null
  robots: string | null
  og: Record<string, string>
  /** Each parsed JSON-LD block; a block that does not parse is an error as soon as it is read. */
  jsonLd: Record<string, unknown>[]
  /** The number of tags of each kind: a page with two canonicals or two descriptions is an SEO error. */
  counts: { description: number; canonical: number; robots: number; ogTitle: number }
}

/**
 * The metadata as the browser sees it, read across the whole document and not only `<head>`: for a browser,
 * Next 16 may stream the metadata of a dynamic page after the frame — still valid, while a crawler gets the
 * blocking version in `<head>`.
 */
export async function readSeo(page: Page): Promise<SeoHead> {
  const raw = await page.evaluate(() => {
    const attr = (selector: string, name: string) => document.querySelector(selector)?.getAttribute(name) ?? null
    const og: Record<string, string> = {}
    for (const node of document.querySelectorAll('meta[property^="og:"]')) {
      const key = node.getAttribute('property')!
      if (!(key in og)) og[key] = node.getAttribute('content') ?? ''
    }
    return {
      title: document.title,
      description: attr('meta[name="description"]', 'content'),
      canonical: attr('link[rel="canonical"]', 'href'),
      robots: attr('meta[name="robots"]', 'content'),
      og,
      jsonLd: [...document.querySelectorAll('script[type="application/ld+json"]')].map((node) => node.textContent ?? ''),
      counts: {
        description: document.querySelectorAll('meta[name="description"]').length,
        canonical: document.querySelectorAll('link[rel="canonical"]').length,
        robots: document.querySelectorAll('meta[name="robots"]').length,
        ogTitle: document.querySelectorAll('meta[property="og:title"]').length,
      },
    }
  })
  return { ...raw, jsonLd: raw.jsonLd.map((text) => JSON.parse(text) as Record<string, unknown>) }
}

/** Every `@type` in the JSON-LD blocks, including nested nodes (`mainEntity`, `@graph`). */
export function jsonLdTypes(blocks: unknown[]): string[] {
  const found: string[] = []
  const visit = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(visit)
    if (node === null || typeof node !== 'object') return
    const type = (node as Record<string, unknown>)['@type']
    if (typeof type === 'string') found.push(type)
    for (const value of Object.values(node)) visit(value)
  }
  visit(blocks)
  return found
}
