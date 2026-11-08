import type { ComponentType } from 'react'
import { Link } from '@/i18n/navigation'
import type { IconProps } from '@/components/icons'
import { FOCUS_RING, TRANSITION } from '../SectionHeading'

/**
 * The parts both sidebars share: the post page's `LeftRail` and the BROWSE pages' `SiteSidebar`. Class constants, the row type
 * and the Explore group live here so the two sidebars cannot drift apart.
 */

export const EYEBROW =
  'flex min-w-0 items-center gap-1.5 text-xs font-semibold tracking-wide text-neutral-600 uppercase dark:text-neutral-400'

/** One row of the sidebar: 32px tall on a fine pointer, 44px on a coarse one. */
export const ROW =
  'flex min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-sm leading-snug pointer-coarse:min-h-11 pointer-coarse:py-2'
/** Hover is LIGHTER than the active fill, so hovering a neighbour never looks like a second current item. */
export const LINK = `${ROW} text-neutral-700 hover:bg-neutral-200/40 hover:text-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800/60 dark:hover:text-neutral-100 ${FOCUS_RING} ${TRANSITION}`
/** The only row with the strong fill AND the weight. */
export const ACTIVE = `${ROW} bg-neutral-200/70 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100`
export const NUMBER_BASE = 'w-5 shrink-0 text-xs tabular-nums'
/** Muted, yet AA on the hover and active fills. */
export const NUMBER = `${NUMBER_BASE} text-neutral-600 dark:text-neutral-400`
export const NUMBER_ACTIVE = `${NUMBER_BASE} text-neutral-700 dark:text-neutral-300`
/** Single line with an ellipsis; the full title stays in the DOM, so the accessible name is always the whole title. */
export const TEXT = 'min-w-0 flex-1 truncate'
/** Every list of the sidebar: the rows bleed 8px so labels and row text share one x. */
export const LIST = '-mx-2 min-w-0 list-none space-y-0.5'
export const ICON = 'shrink-0 text-neutral-500 dark:text-neutral-400'

/** The skip links of a sidebar: invisible until focused, then fixed in the corner (no grid cell, no layout shift). */
export const SKIP_LINK =
  'sr-only focus:not-sr-only focus:fixed focus:start-3 focus:top-3 focus:z-50 focus:rounded-md focus:border focus:border-brand focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-brand focus:outline-2 focus:outline-offset-2 focus:outline-brand dark:focus:bg-neutral-900'

export const EXPLORE_ID = 'rail-explore'

export type Section = { key: string; href: string; label: string; Icon: ComponentType<IconProps> }

/** The row of the Explore group that stands for the page being viewed. `exact` is the page itself (`page`), not a child of it (`true`). */
export type ExploreCurrent = { key: string; exact: boolean }

/**
 * The Explore group: an eyebrow and one icon link per section.
 *
 * Without `current` no row is marked (the post page is not one of these sections). With it, the matching row is the
 * current one: still a link (like the header's current item), with the `ACTIVE` fill, `aria-current="page"` when the page is
 * the section itself and `"true"` when it is one of its children.
 *
 * With `landmark` the list is wrapped in a `nav` named by the eyebrow (and the `ul` loses its own `aria-labelledby`, the
 * name sits on the landmark). Only the BROWSE sidebar asks for it: the post page keeps exactly one navigation per rail copy.
 */
export function ExploreGroup({
  title,
  links,
  suffix,
  current,
  landmark = false,
}: {
  title: string
  links: Section[]
  suffix: string
  current?: ExploreCurrent
  landmark?: boolean
}) {
  const id = `${EXPLORE_ID}${suffix}`
  const list = (
    <ul aria-labelledby={landmark ? undefined : id} className={`mt-1 ${LIST}`}>
      {links.map(({ key, href, label, Icon }) => {
        const isCurrent = current?.key === key
        return (
          <li key={key} className="min-w-0">
            <Link
              href={href}
              aria-current={isCurrent ? (current.exact ? 'page' : 'true') : undefined}
              className={isCurrent ? `${ACTIVE} ${FOCUS_RING} ${TRANSITION}` : LINK}
            >
              <Icon size={16} className={ICON} />
              <span className={TEXT}>{label}</span>
            </Link>
          </li>
        )
      })}
    </ul>
  )
  return (
    <div className="min-w-0">
      <p id={id} className={EYEBROW}>
        <span className="min-w-0 break-words">{title}</span>
      </p>
      {landmark ? <nav aria-labelledby={id}>{list}</nav> : list}
    </div>
  )
}
