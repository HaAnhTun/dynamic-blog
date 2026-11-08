import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HEADER_AT_TOP,
  HEADER_HIDE_DELTA_PX,
  HEADER_MIN_HIDE_PX,
  HEADER_SHOW_DELTA_PX,
  SITE_HEADER_VAR,
  headerHideFloor,
  headerPinned,
  isKeyboardFocus,
  isTextEntry,
  nextHeaderState,
  shouldShowBackToTop,
  siteHeaderHeight,
  type HeaderScroll,
} from './scroll-ui'
import { msg } from '@/test/render-intl'

/** Runs a sequence of scroll positions through nextHeaderState, returning the hidden state after each step. */
function run(positions: number[], options: { headerHeight?: number; maxScrollY?: number; start?: HeaderScroll } = {}) {
  let state = options.start ?? HEADER_AT_TOP
  return positions.map((scrollY) => {
    state = nextHeaderState(state, {
      scrollY,
      headerHeight: options.headerHeight ?? 64,
      pinned: false,
      maxScrollY: options.maxScrollY,
    })
    return state.hidden
  })
}

describe('nextHeaderState: dynamic sticky header', () => {
  it(msg('Admin.postImages.size', { width: 'the hide threshold is max(100px, 2 ', height: ' header height)' }), () => {
    expect(HEADER_MIN_HIDE_PX).toBe(100)
    expect(headerHideFloor(40)).toBe(100)
    expect(headerHideFloor(64)).toBe(128)
    // At 320px the header wraps to two rows: the threshold follows.
    expect(headerHideFloor(97)).toBe(194)
  })

  it('never hides below the threshold, even when scrolling steadily down; hides from the threshold on', () => {
    expect(run([20, 60, 99, 127])).toEqual([false, false, false, false])
    expect(run([127])).toEqual([false])
    expect(run([128])).toEqual([true])
    // A short header: the 100px floor still holds.
    expect(run([99], { headerHeight: 30 })).toEqual([false])
    expect(run([100], { headerHeight: 30 })).toEqual([true])
    // Below the threshold the turning point follows: past the threshold it still takes another 8px.
    expect(run([127, 130, 135])).toEqual([false, false, true])
  })

  it(`hides only after scrolling down at least ${HEADER_HIDE_DELTA_PX}px from the turning point`, () => {
    expect(HEADER_HIDE_DELTA_PX).toBe(8)
    const shown: HeaderScroll = { hidden: false, anchor: 500 }
    expect(run([507], { start: shown })).toEqual([false])
    expect(run([508], { start: shown })).toEqual([true])
    // Inertia: 3px steps do not add up to a hide in the wrong place when going up and then down.
    expect(run([495, 490, 497], { start: shown })).toEqual([false, false, false])
    expect(run([495, 490, 498], { start: shown })).toEqual([false, false, true])
  })

  it(`scrolling up ${HEADER_SHOW_DELTA_PX}px shows it at once; a 1–3px step back (the tail of an inertia bounce) still hides`, () => {
    expect(HEADER_SHOW_DELTA_PX).toBe(4)
    const hidden: HeaderScroll = { hidden: true, anchor: 2000 }
    expect(run([1997], { start: hidden })).toEqual([true])
    expect(run([1996], { start: hidden })).toEqual([false])
    // The turning point is the deepest spot: scroll further down, then up 4px from there.
    expect(run([2400, 2397, 2396], { start: hidden })).toEqual([true, true, false])
  })

  it('once shown again, stepping down under 8px does not hide: no flicker around the turning point', () => {
    expect(run([1000, 2000, 1990, 1993, 1997, 1998])).toEqual([true, true, false, false, false, true])
  })

  it('the top of the page always shows, even an overscroll bounce (negative scrollY) on iOS', () => {
    expect(run([3000, 50])).toEqual([true, false])
    expect(run([3000, -40])).toEqual([true, false])
  })

  it('an iOS bottom overscroll bounce (scrollY passes the bottom then returns) does not make the header show', () => {
    expect(run([3000, 3080, 3000], { maxScrollY: 3000 })).toEqual([true, true, true])
    // A page shorter than the threshold: never hides.
    expect(run([60, 90], { maxScrollY: 90 })).toEqual([false, false])
  })

  it('a pinned header (keyboard focus, open menu): always shown, and shown even when hidden deep in the page', () => {
    const hidden: HeaderScroll = { hidden: true, anchor: 3000 }
    const pinned = nextHeaderState(hidden, { scrollY: 3200, headerHeight: 64, pinned: true })
    expect(pinned).toEqual({ hidden: false, anchor: 3200 })
    // Still pinned: scrolling further down still does not hide.
    expect(nextHeaderState(pinned, { scrollY: 3600, headerHeight: 64, pinned: true }).hidden).toBe(false)
    // Unpinned: the next scroll down (≥ 8px from the last point while pinned) hides.
    expect(nextHeaderState({ hidden: false, anchor: 3600 }, { scrollY: 3608, headerHeight: 64, pinned: false }).hidden).toBe(true)
  })

  it('opening the page in the middle (#section link, reload): from the top-of-page state, the first computation hides the header', () => {
    expect(run([1800])).toEqual([true])
    expect(run([0])).toEqual([false])
  })
})

describe('headerPinned, isKeyboardFocus', () => {
  /** jsdom does not understand `:focus-visible`: simulates "the current focus arrived by keyboard". */
  function keyboardFocus(on: boolean) {
    const matches = Element.prototype.matches
    vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
      if (selector === ':focus-visible') return on && this === document.activeElement
      return matches.call(this, selector)
    })
  }

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  function header() {
    document.body.innerHTML =
      '<header><a href="/">Name</a><button id="menu" aria-expanded="false">Account</button></header><main><a id="ngoai" href="/x">x</a></main>'
    return document.querySelector('header')!
  }

  it('keyboard focus inside the header: pinned; focus from a mouse click or a tap: not', () => {
    const element = header()
    const link = element.querySelector('a')!
    link.focus()

    keyboardFocus(false)
    expect(headerPinned(element)).toBe(false)
    vi.restoreAllMocks()
    keyboardFocus(true)
    expect(headerPinned(element)).toBe(true)
    // Keyboard focus outside the header: not pinned.
    document.getElementById('ngoai')!.focus()
    expect(headerPinned(element)).toBe(false)
  })

  it('the header menu is open (aria-expanded="true"): pinned, wherever the focus is', () => {
    const element = header()
    keyboardFocus(false)
    expect(headerPinned(element)).toBe(false)
    element.querySelector('#menu')!.setAttribute('aria-expanded', 'true')
    expect(headerPinned(element)).toBe(true)
  })

  it('a browser that does not understand :focus-visible (the selector throws): treated as keyboard', () => {
    const element = header()
    vi.spyOn(Element.prototype, 'matches').mockImplementation(() => {
      throw new SyntaxError('unknown pseudo-class')
    })
    expect(isKeyboardFocus(element)).toBe(true)
  })
})

describe('siteHeaderHeight', () => {
  afterEach(() => document.documentElement.style.removeProperty(SITE_HEADER_VAR))

  it('reads --site-header-h on <html>; 0 when not set', () => {
    expect(SITE_HEADER_VAR).toBe('--site-header-h')
    expect(siteHeaderHeight()).toBe(0)
    document.documentElement.style.setProperty(SITE_HEADER_VAR, '64.5px')
    expect(siteHeaderHeight()).toBe(64.5)
  })
})

describe('shouldShowBackToTop: the "Back to top" button', () => {
  const page = (scrollY: number, documentHeight: number) => ({ scrollY, viewportHeight: 800, documentHeight })

  it('a page not longer than 4 screens: never shows', () => {
    expect(shouldShowBackToTop(page(2400, 3200))).toBe(false)
    expect(shouldShowBackToTop(page(1500, 2000))).toBe(false)
  })

  it('a long page: shows once scrolled past 1.5 screens, not shown at the top', () => {
    expect(shouldShowBackToTop(page(0, 10_000))).toBe(false)
    expect(shouldShowBackToTop(page(1200, 10_000))).toBe(false)
    expect(shouldShowBackToTop(page(1201, 10_000))).toBe(true)
    expect(shouldShowBackToTop(page(9000, 10_000))).toBe(true)
  })

  it('exact boundaries: both thresholds are "past" (>), not "from" (≥)', () => {
    expect(shouldShowBackToTop(page(5000, 3200))).toBe(false)
    expect(shouldShowBackToTop(page(5000, 3201))).toBe(true)
    expect(shouldShowBackToTop(page(1200, 3201))).toBe(false)
  })

  it('a viewport with no height yet (0): does not show', () => {
    expect(shouldShowBackToTop({ scrollY: 5000, viewportHeight: 0, documentHeight: 10_000 })).toBe(false)
  })
})

describe('isTextEntry', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('text inputs and editing areas: yes; buttons, checkboxes, links: no', () => {
    document.body.innerHTML =
      '<textarea id="a"></textarea><input id="b"><input id="c" type="email"><input id="d" type="search">' +
      '<div contenteditable="true"><p id="e">x</p></div><div contenteditable="false" id="f"></div>' +
      '<input id="g" type="checkbox"><input id="h" type="submit"><button id="i"></button><a id="j" href="#">x</a>'
    const $ = (id: string) => document.getElementById(id)
    for (const id of ['a', 'b', 'c', 'd', 'e']) expect(isTextEntry($(id)), id).toBe(true)
    for (const id of ['f', 'g', 'h', 'i', 'j']) expect(isTextEntry($(id)), id).toBe(false)
    expect(isTextEntry(null)).toBe(false)
    expect(isTextEntry(document.body)).toBe(false)
  })
})
