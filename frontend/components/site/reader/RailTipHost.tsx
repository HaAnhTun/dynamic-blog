'use client'

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type PointerEvent,
  type ReactNode,
} from 'react'

/** Hover delay before the tooltip shows (keyboard focus shows it at once). */
export const TIP_DELAY_MS = 250

/** The widest the tooltip may grow before the title wraps, in CSS px (36rem). */
const MAX_WIDTH_PX = 576

/** Room kept between the tooltip and the window edge, and between a focused row and its tooltip, in CSS px. */
const EDGE_PX = 16
const GAP_PX = 4

type Source = 'hover' | 'focus'
type Tip = { text: string; style: CSSProperties; source: Source }

/** True when the text span is cut by its ellipsis: only then does the tooltip tell the reader something new. */
function isTruncated(row: Element): boolean {
  const text = row.querySelector<HTMLElement>('[data-tip-text]')
  return text !== null && text.scrollWidth > text.clientWidth + 1
}

function tipRowOf(target: EventTarget | null, host: Element | null): HTMLElement | null {
  if (!(target instanceof Element)) return null
  const row = target.closest<HTMLElement>('[data-tip]')
  return row && host?.contains(row) ? row : null
}

function focusVisible(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  try {
    return target.matches(':focus-visible')
  } catch {
    return true
  }
}

/**
 * Places the tooltip. Hover: exactly over the row (the grey pill of the reference), starting at the row's inline-start edge.
 * Focus: below the row, never over it, so the focused row and its focus ring stay visible (WCAG 2.4.7, 2.4.11); the vertical
 * flip above the row happens in `settle`, once the real height is known.
 */
function placement(row: Element, source: Source): CSSProperties {
  const rect = row.getBoundingClientRect()
  const rtl = getComputedStyle(document.documentElement).direction === 'rtl'
  const style: CSSProperties = {}

  if (rtl) {
    style.insetInlineStart = window.innerWidth - rect.right
    style.maxWidth = Math.max(0, Math.min(MAX_WIDTH_PX, rect.right - EDGE_PX))
  } else {
    style.left = rect.left
    style.maxWidth = Math.max(0, Math.min(MAX_WIDTH_PX, window.innerWidth - rect.left - EDGE_PX))
  }

  if (source === 'hover') {
    style.top = rect.top
    style.minHeight = rect.height
  } else {
    style.top = rect.bottom + GAP_PX
  }
  return style
}

/**
 * A fixed tooltip for truncated rows of the left sidebar. One island wraps a whole server-rendered list and listens by
 * delegation, so the rows themselves stay server HTML.
 *
 * Markup contract: the focusable or hoverable element (link, summary, current-row span) carries `data-tip="<full title>"` and
 * the truncated span inside it carries `data-tip-text`. A tooltip shows only when that span is really cut by its ellipsis.
 *
 * Behaviour: hover (mouse or pen, never touch) after TIP_DELAY_MS; keyboard focus (`:focus-visible`) at once. It is a visual
 * aid only: `aria-hidden`, no role, never in the tab order, `pointer-events: none`, so the pointer stays on the row (open in
 * a new tab, context menu and selection keep working) and the full title is already the row's accessible name. It goes away when the
 * pointer or focus leaves the row, on Escape, scroll, resize and pointer press. Nothing here sets state from an effect.
 */
export function RailTipHost({ children }: { children: ReactNode }) {
  const [tip, setTip] = useState<Tip | null>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rowRef = useRef<HTMLElement | null>(null)
  const open = tip !== null

  const stopTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }, [])

  const hide = useCallback(() => {
    stopTimer()
    rowRef.current = null
    setTip(null)
  }, [stopTimer])

  const show = useCallback(
    (row: HTMLElement, source: Source) => {
      stopTimer()
      const text = row.getAttribute('data-tip')
      if (!text || !isTruncated(row)) {
        rowRef.current = null
        setTip(null)
        return
      }
      rowRef.current = row
      setTip({ text, style: placement(row, source), source })
    },
    [stopTimer],
  )

  // Listeners exist only while a tooltip is open, so Escape is never swallowed (the search palette uses it too).
  const source = tip?.source
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', hide)
    // Focusing a row that is off screen makes the browser scroll it into view right after the tooltip opened. A hover tooltip is
    // dropped by any scroll; a keyboard one follows its row instead (placed again from the row's new position), or goes when the row left the window.
    const onScroll = () => {
      const row = rowRef.current
      if (source !== 'focus' || !row) return hide()
      const rect = row.getBoundingClientRect()
      if (rect.bottom < 0 || rect.top > window.innerHeight) return hide()
      show(row, 'focus')
    }
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', hide)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', hide)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', hide)
    }
  }, [open, source, hide, show])

  useEffect(() => stopTimer, [stopTimer])

  const onPointerOver = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch') return
    const row = tipRowOf(event.target, hostRef.current)
    if (!row || row === rowRef.current) return
    stopTimer()
    rowRef.current = row
    timer.current = setTimeout(() => show(row, 'hover'), TIP_DELAY_MS)
  }

  const onPointerOut = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch') return
    const row = tipRowOf(event.target, hostRef.current)
    if (!row || row !== rowRef.current) return
    const into = event.relatedTarget
    if (into instanceof Node && row.contains(into)) return
    // A tooltip opened by keyboard focus stays while the row has focus; only a hover tooltip or a pending one ends here.
    if (tip?.source === 'focus') return
    hide()
  }

  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    const row = tipRowOf(event.target, hostRef.current)
    if (!row || !focusVisible(event.target)) return
    show(row, 'focus')
  }

  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    const row = tipRowOf(event.target, hostRef.current)
    if (!row) return
    const into = event.relatedTarget
    if (into instanceof Node && row.contains(into)) return
    hide()
  }

  // Keyboard placement flips above the row when the tooltip would not fit under it. The height is only known once it is in
  // the DOM, so this is a ref callback (a direct style write) and not an effect that sets state.
  const settle = (el: HTMLDivElement | null) => {
    const row = rowRef.current
    if (!el || !row || tip?.source !== 'focus') return
    const rowRect = row.getBoundingClientRect()
    // Back to the default (below the row) first: this runs again after a scroll, when an earlier flip may still be in the inline style.
    el.style.top = `${rowRect.bottom + GAP_PX}px`
    el.style.bottom = ''
    const height = el.getBoundingClientRect().height
    if (window.innerHeight - rowRect.bottom < height + GAP_PX * 2) {
      el.style.top = 'auto'
      el.style.bottom = `${window.innerHeight - rowRect.top + GAP_PX}px`
    }
  }

  return (
    <div
      ref={hostRef}
      className="min-w-0"
      onPointerOver={onPointerOver}
      onPointerOut={onPointerOut}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      {children}
      {tip ? (
        <div
          ref={settle}
          data-rail-tip=""
          aria-hidden="true"
          style={tip.style}
          className="pointer-events-none fixed z-50 flex w-max items-center rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm leading-snug font-medium break-words text-neutral-900 shadow-md [@media(hover:none)]:hidden dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
        >
          {tip.text}
        </div>
      ) : null}
    </div>
  )
}
