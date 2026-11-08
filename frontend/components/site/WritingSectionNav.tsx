import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { FOCUS, TAP_TARGET, TRANSITION } from './SectionHeading'
import { WRITING_SECTIONS, type WritingSection } from './writing-sections'

/** The icon takes the text color (`currentColor`): gray like the label on a normal item, brand blue on the current item
 *  and on hover. The icon goes with the color of its text, not split into a separate color layer. */
const LINK = `inline-flex items-center gap-2 ${FOCUS} ${TRANSITION} ${TAP_TARGET} hover:text-brand`

/**
 * @deprecated Replaced by the Explore group of `SiteSidebar`; the pages are moving over and the final cleanup ticket deletes
 * this component with `Site.listing.sectionNav.label`.
 *
 * The "view posts by" row under the h1 of /writing, /series, /topics, /archive: the four
 * pages are all "Writing" in the header, and this row lets the reader change how they view without going back
 * to the header.
 *
 * A server component, no `usePathname`: the page knows which item it is, so it passes it straight in —
 * no client component spent just to re-read the URL the page just rendered.
 *
 * The current item is still a link (like the header): `aria-current="page"` is the contract with screen
 * readers, `text-brand font-medium` is the mark for the eye. No solid-background pill: this row is a reading
 * path, not the tab set of an app. It wraps when out of room, no horizontal scroll — an item
 * outside the scroll frame is an item a phone reader does not know exists.
 *
 * The icons here are a deliberate exception to the "no icon on nav labels" rule: that rule
 * is about the main nav; the design assigns Newspaper/Layers/Tags/Archive specifically to these four items, the same
 * glyphs that the Series, Tags and Archive blocks use elsewhere, so the reader recognizes them.
 *
 * Gap `gap-x-4`, `gap-x-6` from 640px: at 390px the four items (82 + 66 + 71 + 71px) plus three 24px gaps are
 * 362px in 358px, and the archive item drops alone onto a new line (measured on the QA stack); a 16px gap fits on one
 * line. The links are 20px tall, the tap area enlarged with TAP_TARGET.
 *
 * `className` lets the page set the spacing above: what comes before the nav differs between
 * pages (the stats line at /writing, a lead on other pages).
 */
export function WritingSectionNav({ current, className }: { current: WritingSection; className?: string }) {
  const t = useTranslations('Site.listing')
  return (
    <nav aria-label={t('sectionNav.label')} className={className}>
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm sm:gap-x-6">
        {WRITING_SECTIONS.map(({ key, href, labelKey, Icon }) => {
          const isCurrent = key === current
          return (
            <li key={key}>
              <Link
                href={href}
                // `undefined` removes the attribute entirely; aria-current="false" is a string, and some
                // assistive technologies read it as the attribute being present.
                aria-current={isCurrent ? 'page' : undefined}
                className={`${LINK} ${isCurrent ? 'font-medium text-brand' : 'text-neutral-600 dark:text-neutral-400'}`}
              >
                <Icon />
                {t(labelKey)}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
