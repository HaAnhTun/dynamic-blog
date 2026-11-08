import { Link } from '@/i18n/navigation'

/**
 * The homepage is eight stacked sections written in one file plus five components, so
 * the heading row and the link treatments live here rather than being re-typed per
 * section. The hazard is the same one Container was built for: five hands spelling the
 * focus ring by hand agree until one of them forgets `focus-visible:outline-brand`, and
 * then one link on one section has no visible focus state — a defect no test and no type
 * error catches.
 *
 * Exported as class strings, not as components. A `<SectionLink>` wrapper would have to
 * re-expose `href`, `className`, `rel`, `target` and `children` and would still be
 * bypassed the first time someone needed `prefetch={false}`. A string composes with
 * anything and stays greppable.
 *
 * Every class name below appears as literal text in this file on purpose: Tailwind finds
 * utilities by scanning source, so a name assembled at runtime (`text-${colour}`) is
 * never generated. Template literals that splice whole constants are safe — the literal
 * substrings are all still here — and that is the only interpolation used.
 */
export const FOCUS = 'rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand'

/**
 * The same focus ring, without `rounded-sm`: for elements that already round their own corners (the `rounded-md` of a button with a
 * border) or have a straight left border (the part row of SeriesBlock). With two corner-radius classes on one element,
 * which one wins depends on the order of the generated CSS, not on the order in the class string.
 */
export const FOCUS_RING = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand'

/**
 * The focus ring is drawn INSIDE the element's edge (a negative offset equal to the ring width). For a button sitting flush against the edge of an
 * `overflow-hidden` frame: the ring normally sits 4px outside and is clipped by the frame — measured on the close button of the
 * image viewer, where focus lands right on open, only the left and bottom edges of the ring could be seen.
 */
export const FOCUS_INSET = 'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand'

/**
 * A tap area larger than the text without changing what is visible: a transparent `::after` extending 10px past the text above
 * and below, 6px on each side — a tap there is a tap on the link. For small text links on a phone: measured
 * on the QA stack, the nav links in the header, the "read posts by" row, the category strip and the footer are only
 * 17–20px tall, the breadcrumb 16px, far from the ~44px recommended for a site read mostly on a phone.
 *
 * 6px is half the `gap-x-3` gap, the narrowest gap between links using this constant, so two adjacent tap areas
 * do not overlap. 10px above and below: when a row of links wraps with `gap-y-2`, the tap areas of
 * the two rows meet in the gap between the two lines of text, not covering each other's text.
 */
export const TAP_TARGET = 'relative after:absolute after:-inset-x-1.5 after:-inset-y-2.5'

/**
 * A 44px tap area for the header's 36px icon slots: the search slot, theme button, notification bell, account
 * button. The same way as TAP_TARGET — a transparent `::after`, absolute so it takes no room — extending 4px on each
 * side: 36 + 8 = 44px, while the visible slot stays 36px. A bigger slot would make the header's first row wrap at 320px (it already
 * uses 281.7 of 288px, Header.test.tsx records the numbers).
 *
 * 4px is half the `gap-2` gap of the button group: the tap areas of two adjacent slots meet in the gap, without overlapping
 * each other. A slot that is already `relative` (the bell, because of the count badge) is unchanged by the repeated class.
 */
export const ICON_TAP_TARGET = 'relative after:absolute after:-inset-1'

/**
 * The visible size of a header icon slot: a 44px square on a phone (the thumb-sized minimum), the compact 36px slot from `md`,
 * where the header is one row and a mouse is the usual pointer. ICON_TAP_TARGET stays on top of both: on a phone the hit
 * area is simply a little larger than the slot.
 */
export const ICON_SLOT = 'h-11 w-11 md:h-9 md:w-9'

/**
 * A text link that lives alone on its line (a section action, a call to action, a row of a link list): the row itself is
 * 44px tall below `sm` so a thumb cannot miss it. From `sm` nothing changes (the link stays a plain inline box, so a space
 * before an arrow is still a space). Links inside running text are exempt (they use TAP_TARGET or nothing).
 */
export const TOUCH_ROW = 'max-sm:inline-flex max-sm:min-h-11 max-sm:items-center max-sm:gap-1'

/**
 * On a phone a call to action that is a text link on a desktop (the home page hero, the 404 page) is a 44px button (the first filled, the others outlined) in a wrapping row, because a 21px
 * underlined link in a thumb's reach is easy to miss; from `sm` they are the underlined links they have always been (every
 * utility here is `max-sm:`, so nothing changes at 640px and up).
 */
export const PHONE_BUTTON =
  'max-sm:inline-flex max-sm:h-11 max-sm:items-center max-sm:gap-1.5 max-sm:rounded-lg max-sm:border max-sm:px-4 max-sm:font-medium max-sm:no-underline'
export const PHONE_PRIMARY =
  'max-sm:border-neutral-900 max-sm:bg-neutral-900 max-sm:text-white dark:max-sm:border-neutral-100 dark:max-sm:bg-neutral-100 dark:max-sm:text-neutral-900'
export const PHONE_SECONDARY = 'max-sm:border-neutral-300 dark:max-sm:border-neutral-700'

/**
 * The anchor of a one-line row title (a post or a series in a list) is an inline box as tall as its text (about 25px). Below `sm` it
 * becomes an inline-block with 10px of padding above and below, cancelled by an equal negative margin, so the hit area grows to
 * 45px while the row does not move by a pixel.
 */
export const TITLE_TOUCH = 'max-sm:-my-2.5 max-sm:inline-block max-sm:py-2.5'

/** 120ms, the ceiling the brief sets, and nothing at all for a reader who asked for
 *  reduced motion. */
export const TRANSITION = 'transition-colors duration-[120ms] motion-reduce:transition-none'

/** Body-copy and call-to-action links: underlined, because an unmarked link inside a
 *  paragraph is only discoverable by hovering it. */
export const INLINE_LINK = `${FOCUS} ${TRANSITION} underline decoration-neutral-300 underline-offset-4 hover:text-brand hover:decoration-brand dark:decoration-neutral-700`

/** Card and article titles: no underline at rest (a grid of underlined headings reads
 *  as noise), and it inherits its colour from the heading rather than setting one. */
export const TITLE_LINK = `${FOCUS} ${TRANSITION} hover:text-brand hover:underline hover:underline-offset-4`

/** The "see the rest" link in a section heading row. */
const ACTION_LINK = `${FOCUS} ${TRANSITION} ${TOUCH_ROW} text-sm font-medium text-brand hover:underline hover:underline-offset-4`

export type SectionAction = { href: string; label: string }

/**
 * `id` lands on the `<h2>` rather than on a wrapping element so that `/#chang-duong` scrolls
 * to the heading itself and a screen reader announces the heading it jumped to.
 *
 * The rule is drawn ABOVE the heading, inside the Container, so it starts at the same
 * left edge as the text. A full-bleed divider would need a wrapper element around every
 * Container with its own width — a second layout owner, which is what Container exists
 * to prevent.
 *
 * It renders a plain `<div>`, not a `<header>`. Inside `<main>` a `<header>` is not a
 * banner landmark, so it would be harmless — but it would also be the second thing on
 * the page called a header, and this element carries no semantics the `<h2>` does not.
 */
export function SectionHeading({
  id,
  title,
  lead,
  action,
}: {
  id: string
  title: string
  lead?: string
  action?: SectionAction
}) {
  return (
    <div className="border-t border-neutral-200 pt-5 sm:pt-6 dark:border-neutral-800">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-0 sm:items-baseline sm:gap-y-1">
        <h2 id={id} className="text-xl font-semibold tracking-tight">
          {title}
        </h2>
        {action ? (
          <Link href={action.href} className={ACTION_LINK}>
            {/* aria-hidden on the arrow, so the accessible name is the label alone.
                Without it the link announces as "<link text> right arrow". */}
            {action.label} <span aria-hidden="true">→</span>
          </Link>
        ) : null}
      </div>
      {/* Rendered conditionally rather than always: an empty <p> still takes its
          margin, which would put a 12px hole under every heading that has no lead. */}
      {lead ? <p className="mt-3 max-w-2xl text-neutral-600 dark:text-neutral-400">{lead}</p> : null}
    </div>
  )
}
