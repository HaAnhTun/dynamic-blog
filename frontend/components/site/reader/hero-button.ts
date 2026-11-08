import { FOCUS_RING, TRANSITION } from '../SectionHeading'

/**
 * The one button recipe of the post hero (Subscribe, Copy link, Share, Next): a hairline-bordered control, 44px tall on a phone
 * (the touch target) and 40px from `sm`. It lives in its own module so that ArticleHero, CopyLink and ShareMenu can all import it
 * without a cycle (CopyLink would import the hero and the hero import CopyLink). Icons inside it are 16px and decorative.
 */
export const HERO_BUTTON = `inline-flex h-11 items-center gap-2 sm:h-10 rounded-lg border border-neutral-200 px-3.5 text-sm font-medium text-neutral-800 hover:border-brand hover:text-brand dark:border-neutral-800 dark:text-neutral-200 ${FOCUS_RING} ${TRANSITION}`

/**
 * Below `sm` the Copy link and Share buttons are 44px squares with the icon alone (the label stays for screen readers, see
 * HERO_LABEL), so the whole action row of a phone is one line: two icons and the wide Next button.
 */
export const HERO_ICON_ONLY = 'max-sm:w-11 max-sm:justify-center max-sm:gap-0 max-sm:px-0'

/** The visible label of an icon-only hero button: text from `sm`, screen-reader text below it. */
export const HERO_LABEL = 'max-sm:sr-only'
