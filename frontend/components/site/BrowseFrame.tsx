import type { ReactNode } from 'react'
import { BROWSE_GRID, BROWSE_MAIN } from './reader/reader-layout'
import { PAGE_CONTENT_ID, SiteSidebar, type SidebarCurrent } from './reader/SiteSidebar'

/**
 * The skeleton of every BROWSE page (spec 3.2): the sidebar and the main column in the post page's two-column grid. One
 * component owns it, so no page can forget the skip-link target, the `flex-1` that stretches the sidebar tint to the footer or
 * the gutters. The page keeps its JSON-LD blocks and discovery band as siblings of the frame and passes only its own header
 * and sections as children.
 *
 * `current` marks the Explore row of the page (`exact`: the section's own page, else one of its children); `extra` is the
 * page's own sidebar group, if any. The main column is the skip link's target and has NO tabindex: browsers move the
 * sequential focus start point to a fragment target without one, and a permanent `tabindex="-1"` would make a mouse click on
 * any text focus the column, so the next Tab would restart at its first control (WCAG 2.4.3; components/site/BackToTop.tsx
 * `focusMain` documents the same trap). The sidebar is first in the DOM, so focus order and reading order are the visual order at every width.
 */
export function BrowseFrame({ current, extra, children }: { current?: SidebarCurrent; extra?: ReactNode; children: ReactNode }) {
  return (
    <div className={BROWSE_GRID}>
      <SiteSidebar current={current} extra={extra} />
      <div id={PAGE_CONTENT_ID} className={BROWSE_MAIN}>
        {children}
      </div>
    </div>
  )
}
