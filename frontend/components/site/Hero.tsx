import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { BrandIcon } from '@/components/BrandIcon'
import type { Hero as HeroContent } from '@/lib/site-content-types'
import { Container } from './Container'
import { githubUrl } from './ContactSection'
import { INLINE_LINK, PHONE_BUTTON, PHONE_PRIMARY, PHONE_SECONDARY } from './SectionHeading'

/**
 * Two, and they are text links. The brief rules out the centred full-viewport hero with
 * two large buttons, and the reason holds beyond taste: a button pair implies a product
 * with a primary action, and the primary action here is reading.
 */
const CALLS_TO_ACTION = [
  { href: '/writing', labelKey: 'readPosts' },
  { href: '/about', labelKey: 'about' },
] as const

/**
 * The page's single `<h1>` is the headline — what the author does — not the greeting and
 * not the name. The name is already the first thing in the header and in the document
 * title; spending the h1 on it would repeat it a third time and say nothing about the
 * site. The greeting runs above as a small eyebrow, which is what it is.
 *
 * `github` is a prop, filled from the site content, so both sides of the conditional are
 * reachable from a test. Either side can be the live one: the owner may clear the field. Hence the
 * layout has to look finished with two links as well as three, and the links row is a
 * wrapping flex list rather than a three-column grid.
 *
 * No GitHub statistics, no follower counts, no "X years of experience". There is no data
 * behind any of those numbers in this repository and inventing one is forbidden.
 */
export function Hero({
  hero,
  github,
  seeking,
  location,
  bare = false,
}: {
  hero: HeroContent
  github: string | null
  seeking: string | null
  location: string
  /** No Container and no vertical padding: the page places the header in a grid cell of a band it owns. */
  bare?: boolean
}) {
  const t = useTranslations('Site.hero')
  const content = (
    <>
      <p className="text-sm font-medium text-neutral-600 dark:text-neutral-400">{hero.greeting}</p>

      <h1 className="mt-3 max-w-3xl text-3xl font-bold tracking-tight text-balance max-sm:leading-tight sm:text-4xl">
        {hero.headline}
      </h1>

      <p className="mt-4 max-w-2xl text-[1.0625rem] text-neutral-600 max-sm:leading-relaxed sm:mt-5 sm:text-lg dark:text-neutral-400">
        {hero.subline}
      </p>

      {/*
        Location and the job direction being sought — one of the three things that the opening of a
        portfolio must answer, along with "who are you" and "main stack".

        Only rendered when `profile.seeking` has a value. Today it is `null`, so this line
        does not appear, and that is intentional: the empty slot lives in the content file, visible,
        instead of being an invisible omission on the page. No placeholder, no
        "looking for a suitable opportunity" — a sentence like that says nothing yet takes up room.

        Not a badge, not an "Open to work" pill: this hero is deliberately not a
        product landing page hero. A small line of text, on the same scale as the rest.
      */}
      {seeking && (
        <p className="mt-3 text-[0.9375rem] text-neutral-600 sm:text-sm dark:text-neutral-400">
          {location} · {seeking}
        </p>
      )}

      <ul className="mt-6 flex flex-wrap gap-3 text-sm sm:mt-7 sm:gap-x-6 sm:gap-y-2">
        {CALLS_TO_ACTION.map((cta, index) => (
          <li key={cta.href}>
            <Link href={cta.href} className={`${INLINE_LINK} ${PHONE_BUTTON} ${index === 0 ? PHONE_PRIMARY : PHONE_SECONDARY}`}>
              {/* The arrow is aria-hidden so the accessible name stays the read-post link text. */}
              {t(cta.labelKey)} <span aria-hidden="true">→</span>
            </Link>
          </li>
        ))}

        {github ? (
          <li>
            {/*
              The GitHub mark says before the text is read that this link leaves the site. It is
              aria-hidden, so the link name stays "GitHub". The text and arrow are wrapped in one span
              so that `inline-flex` only inserts spacing between the mark and the text: the gap between "GitHub" and
              "→" is still a single space, like the two invitations beside it.
            */}
            <a
              href={githubUrl(github)}
              className={`inline-flex items-center gap-2 ${INLINE_LINK} ${PHONE_BUTTON} ${PHONE_SECONDARY}`}
              rel="me noreferrer"
            >
              <BrandIcon name="github" />
              <span>
                GitHub <span aria-hidden="true">→</span>
              </span>
            </a>
          </li>
        ) : null}
      </ul>
    </>
  )

  // `header` and not `main`: app/layout.tsx owns the document's only <main>.
  // A <header> that is not a child of <body> is not a banner landmark, so this does
  // not compete with components/site/Header.tsx for the banner role.
  if (bare) return <header>{content}</header>
  return (
    <Container as="header" className="pt-12 pb-10 sm:pt-16">
      {content}
    </Container>
  )
}
