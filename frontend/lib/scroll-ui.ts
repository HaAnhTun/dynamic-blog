/**
 * Scroll rules for the dynamic sticky header and the "Back to top" button: pure functions so each
 * threshold can be tested, plus two small DOM-reading functions. The event listening is in components/site/useStickyHeader.ts and BackToTop.tsx.
 */

/** The CSS variable carrying the measured height of the public header; globals.css sets a default 0px at :root. */
export const SITE_HEADER_VAR = '--site-header-h'

/** Never hide the header while it is closer to the top of the page than this, even when the header is short. */
export const HEADER_MIN_HIDE_PX = 100

/** Scrolling down at least this much from the turning point hides it: scroll inertia must not make the header flicker. */
export const HEADER_HIDE_DELTA_PX = 8

/**
 * Scrolling up this much shows it at once. Not 0 or 1: the tail bounce of inertia and subpixel rounding on
 * phones produce 1–3px steps back while the reader is still scrolling down.
 */
export const HEADER_SHOW_DELTA_PX = 4

/**
 * The header state. `anchor` is the turning point: while shown, the highest position (smallest scrollY) since
 * the last state change; while hidden, the deepest position. The offset from it is the distance scrolled back.
 */
export type HeaderScroll = { hidden: boolean; anchor: number }

export const HEADER_AT_TOP: HeaderScroll = { hidden: false, anchor: 0 }

export type HeaderScrollInput = {
  scrollY: number
  /** Header height (px). The hide threshold is max(100px, 2 × height): a header wrapping to two rows moves the threshold with it. */
  headerHeight: number
  /** The header is pinned (headerPinned: keyboard focus inside it, or one of its menus open): always shown. */
  pinned: boolean
  /** scrollHeight − clientHeight. An iOS bottom overscroll bounce (scrollY passes the bottom then returns) does not count as scrolling up. */
  maxScrollY?: number
}

export function headerHideFloor(headerHeight: number): number {
  return Math.max(HEADER_MIN_HIDE_PX, 2 * headerHeight)
}

/** Focus that arrived by keyboard (`:focus-visible`). A browser that does not understand this selector: treated as keyboard, which is safer. */
export function isKeyboardFocus(element: Element): boolean {
  try {
    return element.matches(':focus-visible')
  } catch {
    return true
  }
}

/**
 * The header must stay still: keyboard focus inside it, or one of its menus open (`aria-expanded`). Focus from a mouse
 * click or a tap does not pin: Chrome on Android focuses buttons and links on tap, and the header would never hide again.
 */
export function headerPinned(header: Element): boolean {
  const active = document.activeElement
  if (active !== null && header.contains(active) && isKeyboardFocus(active)) return true
  return header.querySelector('[aria-expanded="true"]') !== null
}

/** The next state after a scroll (or a focus into the header). */
export function nextHeaderState(prev: HeaderScroll, input: HeaderScrollInput): HeaderScroll {
  const max = input.maxScrollY === undefined ? Infinity : Math.max(input.maxScrollY, 0)
  const y = Math.min(Math.max(input.scrollY, 0), max)

  if (input.pinned || y < headerHideFloor(input.headerHeight)) return { hidden: false, anchor: y }

  if (prev.hidden) {
    if (prev.anchor - y >= HEADER_SHOW_DELTA_PX) return { hidden: false, anchor: y }
    return { hidden: true, anchor: Math.max(prev.anchor, y) }
  }
  if (y - prev.anchor >= HEADER_HIDE_DELTA_PX) return { hidden: true, anchor: y }
  return { hidden: false, anchor: Math.min(prev.anchor, y) }
}

/**
 * The header height currently written on <html> (px), 0 when not yet measured or the page has no public header (admin).
 * Reads the inline style, where useStickyHeader writes it, not via getComputedStyle: cheap, and exact to the subpixel.
 */
export function siteHeaderHeight(): number {
  const value = Number.parseFloat(document.documentElement.style.getPropertyValue(SITE_HEADER_VAR))
  return Number.isFinite(value) ? value : 0
}

/** The button only exists on pages longer than this many screens. */
export const BACK_TO_TOP_MIN_SCREENS = 4

/** ...and only shows once scrolled past this many screens. */
export const BACK_TO_TOP_AFTER_SCREENS = 1.5

export type PageScroll = { scrollY: number; viewportHeight: number; documentHeight: number }

export function shouldShowBackToTop({ scrollY, viewportHeight, documentHeight }: PageScroll): boolean {
  if (viewportHeight <= 0) return false
  return documentHeight > BACK_TO_TOP_MIN_SCREENS * viewportHeight && scrollY > BACK_TO_TOP_AFTER_SCREENS * viewportHeight
}

/** Fields that do not open the on-screen keyboard: focusing them needs no room made. */
const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'range', 'color', 'file', 'hidden'])

/** The element receiving typed text (input, editing area): on a phone the on-screen keyboard takes half the screen. */
export function isTextEntry(element: EventTarget | null): boolean {
  if (!(element instanceof HTMLElement)) return false
  if (element instanceof HTMLTextAreaElement) return true
  if (element instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(element.type)
  // `isContentEditable` also catches designMode; jsdom lacks it, so ask for the attribute too.
  return element.isContentEditable || element.closest('[contenteditable]:not([contenteditable="false"])') !== null
}
