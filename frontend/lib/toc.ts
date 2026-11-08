import type { TocEntry } from './markdown'

/** An item of the nested table of contents: a heading with its child headings. */
export type TocNode = TocEntry & { children: TocNode[] }

/**
 * `scroll-margin-top` of h2–h4 in the post (app/globals.css; globals.test.ts keeps the two places equal):
 * breathing room above the heading just jumped to. It adds on top of the `scroll-padding-top` of <html>
 * (the sticky header height), so the heading stops at `header + 32px`.
 */
export const HEADING_SCROLL_MARGIN_PX = 32

/**
 * The "currently reading" line, measured from the top edge of the screen: under the header (measured height, even while the header is hidden),
 * 8px lower than the scroll-margin. A heading just jumped to (top edge at `header + scroll-margin`, off by
 * rounding) has passed the line, so it is the item being read.
 */
export function activeLinePx(headerPx: number): number {
  return headerPx + HEADING_SCROLL_MARGIN_PX + 8
}

/**
 * The rootMargin of the IntersectionObserver in TocSpy: the part of the screen below the reading line, extended down by 100 screens.
 * Any heading crossing the line, even in a long jump (Home, End, a #section link), changes its "fully inside the root" state.
 */
export function tocRootMargin(linePx: number): string {
  return `-${linePx}px 0px 10000% 0px`
}

/**
 * The table of contents tree from the flat list of renderMarkdown, same order, same ids. The children of an item are
 * the deeper items right after it. A level jump (h2 → h4) nests only one step; an item deeper than h2 with no
 * shallower item before it (a post opening with h3) sits at the top level.
 */
export function nestToc(entries: readonly TocEntry[]): TocNode[] {
  const roots: TocNode[] = []
  const open: TocNode[] = []
  for (const entry of entries) {
    const node: TocNode = { ...entry, children: [] }
    while (open.length > 0 && open[open.length - 1].depth >= node.depth) open.pop()
    ;(open.length > 0 ? open[open.length - 1].children : roots).push(node)
    open.push(node)
  }
  return roots
}

/** The href of an item: the encoded id, because the id keeps accented letters. TocSpy decodes it back to find the heading. */
export function tocHref(id: string): string {
  return `#${encodeURIComponent(id)}`
}

/**
 * The item being read: the last heading (in post order) whose top edge has fully passed the line `line`. Before the
 * first heading (reading the intro) it is null: no item of the table of contents is the place being read. FULLY past
 * (`<`): a heading exactly on the line is still "fully inside the root" of the IntersectionObserver in TocSpy.
 */
export function activeHeadingId(tops: readonly { id: string; top: number }[], line: number): string | null {
  let active: string | null = null
  for (const { id, top } of tops) {
    if (top < line) active = id
  }
  return active
}
