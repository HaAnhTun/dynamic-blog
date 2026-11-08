'use client'

import { useEffect } from 'react'
import { siteHeaderHeight } from '@/lib/scroll-ui'
import { activeHeadingId, activeLinePx, tocRootMargin } from '@/lib/toc'

/** The links of every table of contents nav (TocNav carries `data-toc`: the inline one and the rail one), so one observer marks both. */
const TOC_LINKS = 'nav[data-toc] a[href^="#"]'

/** The scrolling list of the rail TOC (TocNav variant "rail"); the inline TOC has none. */
const RAIL_LIST = 'ul[data-toc-list]'

/** The part after `#` of an href or of a URL → id; broken encoding (a reader typing `#%E0` by hand) gives null. */
function idOf(fragment: string): string | null {
  try {
    return decodeURIComponent(fragment.replace(/^#/, ''))
  } catch {
    return null
  }
}

type Item = { id: string; link: Element; heading: HTMLElement }

/**
 * Keeps the active link inside the visible part of the rail list: when it is outside [scrollTop, scrollTop + clientHeight] the LIST
 * (never the page) scrolls so the link is centred. No scrollIntoView: it would also scroll the window. A list that is not laid out
 * (the rail is display:none below its breakpoint, clientHeight 0) is left alone.
 */
function keepVisible(link: Element) {
  const list = link.closest<HTMLElement>(RAIL_LIST)
  if (!list || list.clientHeight === 0) return
  const box = link.getBoundingClientRect()
  const top = box.top - list.getBoundingClientRect().top + list.scrollTop
  if (top >= list.scrollTop && top + box.height <= list.scrollTop + list.clientHeight) return
  const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  list.scrollTo({ top: top - list.clientHeight / 2 + box.height / 2, behavior: reduced ? 'auto' : 'smooth' })
}

/**
 * Highlights the item being read: `aria-current="location"` on exactly one link per table of contents nav (inline and rail), by
 * scroll position and by hash, and keeps the active link visible in the rail list.
 * Draws nothing, no props: reads links and headings from the server HTML, so TocNav stays a server component.
 * Without IntersectionObserver nothing is highlighted; the table of contents stays links as before.
 */
export function TocSpy() {
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return

    const items: Item[] = []
    for (const link of document.querySelectorAll(TOC_LINKS)) {
      const id = idOf(link.getAttribute('href') ?? '')
      // getElementById, not querySelector('#' + id): an id may start with a digit or carry diacritics.
      const heading = id === null ? null : document.getElementById(id)
      if (id !== null && heading !== null) items.push({ id, link, heading })
    }
    if (items.length === 0) return
    // One heading per id even though each id has a link in every nav: observed and measured once.
    const headings = new Map<string, HTMLElement>()
    for (const { id, heading } of items) headings.set(id, heading)

    let marked: string | null = null
    function mark(active: string | null) {
      for (const { id, link } of items) {
        if (id === active) link.setAttribute('aria-current', 'location')
        else link.removeAttribute('aria-current')
      }
      // Only when the active item changes: a callback confirming the same item must not fight a reader who scrolls the list.
      if (active !== null && active !== marked) {
        for (const item of items) if (item.id === active) keepVisible(item.link)
      }
      marked = active
    }

    // The table of contents' own hash is marked at once. Another hash (#comments, a comment link) is not an
    // item: let the scroll position decide.
    function syncHash() {
      const id = idOf(window.location.hash)
      if (items.some((item) => item.id === id)) mark(id)
    }

    // The reading line sits below the sticky header : the header height comes from `--site-header-h` on <html>.
    let line = activeLinePx(siteHeaderHeight())
    let observer: IntersectionObserver | null = null

    // The callback is only a signal "a heading just crossed the line": recompute from the real position of every heading.
    function connect() {
      observer?.disconnect()
      observer = new IntersectionObserver(
        () => {
          const tops = [...headings].map(([id, heading]) => ({ id, top: heading.getBoundingClientRect().top }))
          mark(activeHeadingId(tops, line))
        },
        { rootMargin: tocRootMargin(line), threshold: 1 },
      )
      for (const heading of headings.values()) observer.observe(heading)
    }

    // rootMargin is fixed from the moment the observer is created. When the header changes height (device rotation, nav wrapping, header measured
    // after this island) the observer is recreated with the new line.
    const headerWatch = new MutationObserver(() => {
      const next = activeLinePx(siteHeaderHeight())
      if (next === line) return
      line = next
      connect()
    })

    connect()
    headerWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
    syncHash()
    window.addEventListener('hashchange', syncHash)
    window.addEventListener('popstate', syncHash)
    return () => {
      observer?.disconnect()
      headerWatch.disconnect()
      window.removeEventListener('hashchange', syncHash)
      window.removeEventListener('popstate', syncHash)
    }
  }, [])

  return null
}
