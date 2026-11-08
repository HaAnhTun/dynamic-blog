import { getTranslations } from 'next-intl/server'
import type { ReactNode } from 'react'
import { ChevronRightIcon, ListIcon, StarIcon } from '@/components/icons'
import { FOCUS_INSET } from '../SectionHeading'
import { WRITING_SECTIONS } from '../writing-sections'
import { ExploreGroup, SKIP_LINK, type ExploreCurrent, type Section } from './rail-parts'
import { RailTipHost } from './RailTipHost'
import { BROWSE_SIDE, LEFT_STICKY } from './reader-layout'

/** The id of the main column of a BROWSE page (`BrowseFrame`): the target of the sidebar's skip link. */
export const PAGE_CONTENT_ID = 'page-content'

/** The label of the closed card below `lg`: one line, 15px, medium. */
const SUMMARY_LABEL = 'flex min-w-0 items-center gap-2 text-[0.9375rem] font-medium text-neutral-800 dark:text-neutral-200'

/** The rows of the Explore group, by key: the four ways to view posts plus the best posts. */
export type ExploreKey = 'latest' | 'series' | 'topics' | 'archive' | 'best'

/** The Explore row that stands for the page: `exact` is the section's own page (`aria-current="page"`), else one of its children (`"true"`). */
export type SidebarCurrent = ExploreCurrent & { key: ExploreKey }

/**
 * The groups of one copy: Explore (a navigation landmark named by its eyebrow), then the page's own group, if it brings one.
 * No empty box: a missing `extra` renders nothing, not an empty wrapper.
 */
function SidebarGroups({
  exploreTitle,
  links,
  suffix,
  current,
  extra,
}: {
  exploreTitle: string
  links: Section[]
  suffix: string
  current: SidebarCurrent | undefined
  extra: ReactNode
}) {
  return (
    <div className="min-w-0 space-y-6">
      <ExploreGroup title={exploreTitle} links={links} suffix={suffix} current={current} landmark />
      {extra ? <div className="min-w-0">{extra}</div> : null}
    </div>
  )
}

/**
 * The left sidebar of every BROWSE page (spec 4): the Explore group with the current section marked, plus an optional
 * page-specific group (`extra`, for example the case studies). It is the shared sibling of the post page's `LeftRail` and
 * builds on the same parts (`rail-parts`), so the two look alike.
 *
 * Like `LeftRail` the groups are in the HTML twice, CSS-switched: a closed card (`details[data-rail-phone]`) below `lg`, a
 * sticky scrolling column from `lg`. The hidden copy is `display:none`, so it is out of the accessibility tree and the tab
 * order, and the ids of the phone copy carry the `-m` suffix. `extra` is rendered once per copy, so it must not carry an `id`
 * of its own. Each copy sits in a `RailTipHost`, the tooltip island for truncated titles.
 *
 * One `aside` (complementary) named `Site.frame.sidebarLabel`; inside it the `nav` named by the Explore eyebrow. The skip link
 * is the first sibling, OUTSIDE the aside, named for what it skips (the sidebar), and targets the main column of the page.
 */
export async function SiteSidebar({ current, extra }: { current?: SidebarCurrent; extra?: ReactNode }) {
  const [t, reader, listing, footer] = await Promise.all([
    getTranslations('Site.frame'),
    getTranslations('Site.reader'),
    getTranslations('Site.listing'),
    getTranslations('Site.footer.links'),
  ])

  const links: Section[] = [
    ...WRITING_SECTIONS.map(({ key, href, labelKey, Icon }) => ({ key, href, label: listing(labelKey), Icon })),
    { key: 'best', href: '/start-here', label: footer('startHere'), Icon: StarIcon },
  ]
  const exploreTitle = reader('exploreTitle')
  const currentLabel = current ? links.find((link) => link.key === current.key)?.label : undefined
  const summary = currentLabel ? t('summary', { current: currentLabel }) : exploreTitle

  return (
    <>
      <a href={`#${PAGE_CONTENT_ID}`} className={SKIP_LINK}>
        {t('skipSidebar')}
      </a>
      <aside aria-label={t('sidebarLabel')} className={BROWSE_SIDE}>
        <details data-rail-phone="" className="group rounded-card border border-neutral-200 lg:hidden dark:border-neutral-800">
          {/* The whole row is the click area (>= 44px) and the focus ring is drawn inward because <summary> fills the
              bordered box. `flex` and `list-none` remove ::marker; Safari needs its marker hidden separately. */}
          <summary
            data-rail-phone=""
            className={`flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-card px-4 py-2 [&::-webkit-details-marker]:hidden ${FOCUS_INSET}`}
          >
            {/* Sentence case at 15px, not the 12px uppercase eyebrow: the closed card is the first thing under the header and has to read as
                "Explore · Latest", not as a code. */}
            <span className={SUMMARY_LABEL}>
              <ListIcon size={16} className="shrink-0 text-neutral-500 dark:text-neutral-400" />
              <span className="min-w-0 truncate">{summary}</span>
            </span>
            <ChevronRightIcon
              size={14}
              className="shrink-0 rotate-90 text-neutral-500 group-open:-rotate-90 dark:text-neutral-400"
            />
          </summary>
          <div className="min-w-0 px-4 pt-1 pb-4">
            <RailTipHost>
              <SidebarGroups exploreTitle={exploreTitle} links={links} suffix="-m" current={current} extra={extra} />
            </RailTipHost>
          </div>
        </details>
        <div data-rail-sticky="" className={`hidden lg:block ${LEFT_STICKY}`}>
          <RailTipHost>
            <SidebarGroups exploreTitle={exploreTitle} links={links} suffix="" current={current} extra={extra} />
          </RailTipHost>
        </div>
      </aside>
    </>
  )
}
