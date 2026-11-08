import { useTranslations } from 'next-intl'
import type { ReactNode } from 'react'
import type { TocEntry } from '@/lib/markdown'
import { MIN_TOC_ENTRIES, TocNav } from '../TocNav'
import { TocSpy } from '../TocSpy'
import { RAIL_SLOT, RAIL_STICKY } from './reader-layout'
import { ReadingProgress } from './ReadingProgress'

/**
 * The reading rail of a post: below the `rail:` breakpoint only the actions toolbar (drawn after the article, with the
 * progress bar fixed to the top of the viewport); from it a sticky column with the progress meter, the table of contents
 * and the actions.
 *
 * The sticky div is a flex column in which ONLY the TOC list scrolls (`TocNav variant="rail"`): the progress meter and the
 * actions are `shrink-0`, so like, save and share are always inside the visible part of the rail, however long the list is.
 * The sticky div carries no overflow itself. Placement and stickiness come from reader-layout.ts; there is no heading here
 * (the aside is named, the TOC has its own eyebrow). TocSpy is rendered once, here, and marks the link in both TOC navs.
 *
 * Renders nothing when there is nothing to show: fewer than MIN_TOC_ENTRIES entries and no actions (a post that is not published).
 */
export function ReadingRail({ toc, actions }: { toc: TocEntry[]; actions: ReactNode | null }) {
  const t = useTranslations('Site.reader')
  const article = useTranslations('Site.article')
  const hasToc = toc.length >= MIN_TOC_ENTRIES
  if (!hasToc && !actions) return null

  return (
    <aside aria-label={t('railLabel')} className={`${RAIL_SLOT} print:hidden`}>
      <div data-rail-sticky="" className={RAIL_STICKY}>
        <ReadingProgress />
        <TocNav variant="rail" toc={toc} t={article} />
        {hasToc ? <TocSpy /> : null}
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </div>
    </aside>
  )
}
