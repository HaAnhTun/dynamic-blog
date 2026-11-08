'use client'

import { useEffect } from 'react'

/**
 * Make a `#fragment` link to a block of the sticky right column land on the column instead of on the block.
 *
 * The browser scrolls a fragment target to the top of the window. A block inside the `position: sticky` rail moves down with the
 * scroll, so the scroll can only stop where the rail's container ends: the reader who signs in from the like link came back at
 * the end of the article with the button above the window. Scrolling the column's own box (the `aside`, which is not sticky) to the top
 * instead lets the rail settle at its pinned position, with the block in view. Runs once on mount, after the browser's own fragment
 * scroll (two animation frames); does nothing when the page has another hash, when the block is not in the rail, or when the rail is not
 * sticky (below the rail breakpoint the column is in the flow and the browser's scroll is right).
 */
export function useRailAnchor(id: string): void {
  useEffect(() => {
    if (window.location.hash !== `#${id}`) return
    let inner = 0
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        const target = document.getElementById(id)
        const sticky = target?.closest<HTMLElement>('[data-rail-sticky]')
        const aside = sticky?.closest('aside')
        if (!sticky || !aside || getComputedStyle(sticky).position !== 'sticky') return
        aside.scrollIntoView({ block: 'start', behavior: 'instant' })
      })
    })
    return () => {
      cancelAnimationFrame(outer)
      cancelAnimationFrame(inner)
    }
  }, [id])
}
