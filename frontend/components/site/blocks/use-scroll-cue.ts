'use client'

import { useEffect, type RefObject } from 'react'

/** The fade that says a box scrolls sideways: its right edge fades out while there is more to the right (`data-more="true"`, see below). */
export const SCROLL_CUE = 'data-[more=true]:[mask-image:linear-gradient(to_right,#000_calc(100%-2rem),transparent)]'

/**
 * Marks a horizontally scrolling element with `data-more="true"` while there is more content to the right of what shows, and `"false"`
 * otherwise, so a fade on its right edge (SCROLL_CUE) says that it scrolls: a phone hides its scrollbars, and the cut edge of a
 * drawing, of a row of tabs or of a code line otherwise reads as the end of the content. The attribute is written straight on the
 * element, not through state: it follows the scroll position, not a render. Returns the function that stops watching.
 */
export function watchScrollCue(element: HTMLElement): () => void {
  const update = () => {
    element.setAttribute('data-more', element.scrollLeft + element.clientWidth < element.scrollWidth - 2 ? 'true' : 'false')
  }
  update()
  element.addEventListener('scroll', update, { passive: true })
  // Not in every environment (jsdom has none): without it the cue still follows the scroll, it only misses a resize.
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
  observer?.observe(element)
  return () => {
    element.removeEventListener('scroll', update)
    observer?.disconnect()
  }
}

/**
 * The hook form of watchScrollCue for a box a component renders itself. `active` is false until the content is there (a diagram is
 * drawn after the first render).
 */
export function useScrollCue(box: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    const element = box.current
    if (!element || !active) return
    return watchScrollCue(element)
  }, [box, active])
}
