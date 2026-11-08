'use client'

import { useEffect, useRef, useState, type RefObject } from 'react'
import {
  HEADER_AT_TOP,
  SITE_HEADER_VAR,
  headerPinned,
  isKeyboardFocus,
  nextHeaderState,
  type HeaderScroll,
} from '@/lib/scroll-ui'

/**
 * The part of the header that is on screen, written on <html>: the measured height while the header is shown, `0px` while it is hidden by the
 * scroll. `--site-header-h` keeps the measured height either way (anchors and scroll-padding stay below the header); the sticky sidebar and
 * right column of the post page start under what is actually visible, so they use this one. Default `0px` in app/globals.css.
 */
export const SITE_HEADER_VISIBLE_VAR = '--site-header-visible-h'

/**
 * `static`: not measured yet (server HTML, before hydration, no JS), a plain header as before the sticky behavior. `sticky`: measured, sticky,
 * no transition yet (no sliding when switching mode). `live`: sticky, hiding and showing with a transition.
 */
export type StickyMode = 'static' | 'sticky' | 'live'

/**
 * The dynamic sticky header : hidden when scrolling down, shown when scrolling up (rules in lib/scroll-ui.ts), and it writes
 * the measured height into `--site-header-h` on <html> for scroll-padding, the table of contents and TocSpy, and the visible height
 * into `--site-header-visible-h` for the sticky columns of the post page.
 */
export function useStickyHeader(ref: RefObject<HTMLElement | null>): { hidden: boolean; mode: StickyMode } {
  const [hidden, setHidden] = useState(false)
  const [mode, setMode] = useState<StickyMode>('static')
  const state = useRef<HeaderScroll>(HEADER_AT_TOP)

  useEffect(() => {
    const header = ref.current
    if (header === null) return
    const root = document.documentElement
    let height = 0
    let hiddenNow = false
    /** The position the latest scroll event saw (see onFocusIn). */
    let lastY = window.scrollY
    let frame = 0
    let started = false
    let liveFrame = 0

    function writeVisible() {
      root.style.setProperty(SITE_HEADER_VISIBLE_VAR, hiddenNow ? '0px' : `${height}px`)
    }

    function measure() {
      height = header!.getBoundingClientRect().height
      root.style.setProperty(SITE_HEADER_VAR, `${height}px`)
      writeVisible()
    }

    function apply(next: HeaderScroll) {
      state.current = next
      hiddenNow = next.hidden
      writeVisible()
      setHidden(next.hidden)
    }

    function update() {
      frame = 0
      apply(
        nextHeaderState(state.current, {
          scrollY: window.scrollY,
          maxScrollY: root.scrollHeight - root.clientHeight,
          headerHeight: height,
          pinned: headerPinned(header!),
        }),
      )
      if (!started) {
        started = true
        setMode('sticky')
        liveFrame = requestAnimationFrame(() => setMode('live'))
      }
    }

    function onScroll() {
      lastY = window.scrollY
      if (frame === 0) frame = requestAnimationFrame(update)
    }

    // Keyboard focus into the header (Tab to the skip link, Shift+Tab going up) shows it at once; a mouse click on a header that is
    // already shown changes nothing. When Tabbing into a sticky header, Chrome scrolls the page ~500px to "bring it into view" BEFORE focusin,
    // and the scroll event of that jump arrives AFTER (measured on real Chrome): lastY is still where the reader stands, return the page there.
    function onFocusIn(event: FocusEvent) {
      const wasHidden = state.current.hidden
      const keyboard = event.target instanceof Element && isKeyboardFocus(event.target)
      if (!keyboard && !wasHidden) return
      const y = keyboard ? lastY : window.scrollY
      if (keyboard && window.scrollY !== y) window.scrollTo(0, y)
      apply({ hidden: false, anchor: y })
    }

    measure()
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    resize?.observe(header)
    window.addEventListener('scroll', onScroll, { passive: true })
    header.addEventListener('focusin', onFocusIn)
    // The first time (also when the header starts sticky) computes from point 0: a page opened already in the middle makes the header yield room.
    onScroll()

    return () => {
      if (frame !== 0) cancelAnimationFrame(frame)
      if (liveFrame !== 0) cancelAnimationFrame(liveFrame)
      resize?.disconnect()
      window.removeEventListener('scroll', onScroll)
      header.removeEventListener('focusin', onFocusIn)
      root.style.removeProperty(SITE_HEADER_VAR)
      root.style.removeProperty(SITE_HEADER_VISIBLE_VAR)
    }
  }, [ref])

  return { hidden, mode }
}
