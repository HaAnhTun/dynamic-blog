import type { ReactNode } from 'react'
import type { SidebarCurrent } from '@/components/site/reader/SiteSidebar'

/**
 * The one stand-in for `BrowseFrame` in every BROWSE page test:
 *
 *   vi.mock('@/components/site/BrowseFrame', () => import('@/test/browse-frame-mock'))
 *
 * The real frame renders the sidebar twice (the phone copy and the desktop copy are BOTH in the DOM under jsdom, no CSS hides
 * one), which would give a page test duplicate `link` and `heading` matches. The frame itself is tested once, in
 * `BrowseFrame.test.tsx`; here it is a plain `div` that shows the children and records what the page asked for.
 *
 * `data-current` is the Explore key the page marked (absent when none) and `data-exact` is "true" for the section's own page,
 * "false" for a child of it. `browseFrameCalls` keeps the `current` and `extra` props of every render, so a test can assert on
 * the page's own sidebar group (`extra`) without rendering it.
 */
export type BrowseFrameCall = { current: SidebarCurrent | undefined; extra: ReactNode }

export const browseFrameCalls: BrowseFrameCall[] = []

/** The props of the latest render of the frame, or `undefined` when the page has not rendered it. */
export function lastBrowseFrameCall(): BrowseFrameCall | undefined {
  return browseFrameCalls.at(-1)
}

export function resetBrowseFrameCalls(): void {
  browseFrameCalls.length = 0
}

export function BrowseFrame({ current, extra, children }: { current?: SidebarCurrent; extra?: ReactNode; children: ReactNode }) {
  browseFrameCalls.push({ current, extra })
  return (
    <div data-testid="browse-frame" data-current={current?.key} data-exact={current ? String(current.exact) : undefined}>
      {children}
    </div>
  )
}
