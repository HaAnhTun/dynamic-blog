import { getLocale, getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import type { ReactNode } from 'react'
import { BrandIcon } from '@/components/BrandIcon'
import { MailIcon, RssIcon, ShuffleIcon } from '@/components/icons'
import { asLocale } from '@/lib/format'
import { getSiteContent } from '@/lib/site-content'
import type { Contact } from '@/lib/site-content-types'
import { FEED_PATH } from '@/lib/site'
import { githubLabel, githubUrl } from './ContactSection'
import { Container } from './Container'
import { BAR_FRAME } from './reader/reader-layout'
import { INLINE_LINK, TAP_TARGET } from './SectionHeading'

/**
 * A SERVER component, deliberately, and it must stay one.
 *
 * `new Date().getFullYear()` in a client component is evaluated twice — once on the
 * server at render, once in the browser at hydration — and the two can disagree, both
 * across a New Year boundary and for any reader whose machine clock or timezone puts
 * them in a different year than the server. React then reports a hydration mismatch
 * on a footer. Evaluated here it is computed once, baked into the HTML, and refreshed
 * whenever the page is revalidated.
 */
/** The single version of the footer link style, built from INLINE_LINK so the focus ring and color
 *  change never drift from the rest of the site. `inline-flex` so a leading icon (if any)
 *  sits in the middle of the line of text; the underline only falls on the text, not the icon. Below sm every link is a 44px
 *  row (`max-sm:min-h-11`, the list has no gap), and the TAP_TARGET ::after is off there; from sm links are 20px tall, 8px apart and
 *  TAP_TARGET widens the touch area without stretching the list. */
const FOOTER_LINK = `inline-flex items-center gap-2 ${INLINE_LINK} ${TAP_TARGET} max-sm:min-h-11 max-sm:min-w-11 max-sm:no-underline max-sm:after:hidden text-neutral-700 dark:text-neutral-300`

type FooterLink = {
  href: string
  /** Already translated, or the contact address, which is data. */
  label: string
  icon?: ReactNode
  rel?: string
  /**
   * A route handler and not a page: it renders a plain `<a>` tag instead of `<Link>`.
   *
   * - /random returns a 307 to a different post each time. Through `<Link>`, the client-side router prefetches
   *   it and keeps one target in its cache, so every later press goes to the same post — "random" only
   *   once. `nofollow` because robots.ts disallows /random: the target post already has its real URL.
   * - /feed.xml returns XML: there is no page for the client-side router to build. `FEED_PATH` is imported
   *   rather than typed as a string: lib/site.ts keeps the single copy, and app/layout.tsx and
   *   lib/metadata.ts use it too.
   */
  plain?: true
}

/**
 * Two groups: "Read" is every way to read the blog, "About me" is the writer and the follow channels.
 * It does not depend on site owner data, so a reader who reaches the bottom of any page still has a way onward.
 *
 * RSS is here because it is the only channel on the site that machines see and people do not: /feed.xml
 * returns 200 and every page declares <link rel="alternate">, but before this footer existed no
 * <a> tag pointed to it.
 */
type FooterLabel =
  | 'writing'
  | 'startHere'
  | 'series'
  | 'topics'
  | 'archive'
  | 'random'
  | 'about'
  | 'caseStudies'
  | 'gallery'
  | 'rss'
  | 'newsletter'

type FooterGroupSpec = {
  id: string
  title: 'readTitle' | 'aboutTitle'
  links: readonly { href: string; label: FooterLabel; icon?: ReactNode; rel?: string; plain?: true }[]
}

const FOOTER_GROUPS: readonly FooterGroupSpec[] = [
  {
    id: 'footer-doc',
    title: 'readTitle',
    links: [
      { href: '/writing', label: 'writing' },
      { href: '/start-here', label: 'startHere' },
      { href: '/series', label: 'series' },
      { href: '/topics', label: 'topics' },
      { href: '/archive', label: 'archive' },
      { href: '/random', label: 'random', icon: <ShuffleIcon />, rel: 'nofollow', plain: true },
    ],
  },
  {
    id: 'footer-ve-toi',
    title: 'aboutTitle',
    links: [
      { href: '/about', label: 'about' },
      { href: '/case-studies', label: 'caseStudies' },
      { href: '/gallery', label: 'gallery' },
      { href: FEED_PATH, label: 'rss', icon: <RssIcon />, plain: true },
      // The second follow channel, so it sits next to RSS.
      { href: '/newsletter', label: 'newsletter' },
    ],
  },
]

function FooterAnchor({ link }: { link: FooterLink }) {
  const content = (
    <>
      {link.icon}
      {link.label}
    </>
  )
  return link.plain ? (
    <a href={link.href} rel={link.rel} className={FOOTER_LINK}>
      {content}
    </a>
  ) : (
    <Link href={link.href} rel={link.rel} className={FOOTER_LINK}>
      {content}
    </Link>
  )
}

/**
 * An async server component that reads the site content itself (`getSiteContent` of the request locale), so its two callers
 * (the site layout and the not-found page) need no props. `data` is an optional override of the contact block, so both
 * branches are reachable from tests without mocking the content module.
 *
 * Still exactly three `<p>` (name, tagline, copyright): the two group labels are `<h2>`, because they name
 * a list of links — and `aria-labelledby` gives each list that same name.
 */
export async function Footer({ data }: { data?: Contact } = {}) {
  const t = await getTranslations('Site.footer')
  const content = await getSiteContent(asLocale(await getLocale()))
  const { site, contact } = content
  const owner = data ?? contact
  const year = new Date().getFullYear()

  // The owner may clear either field: the
  // content rule is that an invented address is worse than no address. So this list
  // is conditional, and with both fields null it does not render at all — the name block
  // above it still reads as finished.
  //
  // `rel` per link, like ContactSection: `me noreferrer` only on GitHub. `rel="me"` is the
  // IndieWeb claim "this profile is me", the same claim that Hero, the contact section and `sameAs`
  // in JSON-LD already make from the same data cell; on a mailto it says nothing.
  const contacts: FooterLink[] = []
  if (owner.email) {
    contacts.push({ href: `mailto:${owner.email}`, label: owner.email, icon: <MailIcon />, plain: true })
  }
  if (owner.github) {
    contacts.push({
      href: githubUrl(owner.github),
      label: githubLabel(owner.github),
      icon: <BrandIcon name="github" />,
      rel: 'me noreferrer',
      plain: true,
    })
  }

  return (
    // print:hidden: the printout is the post, not the frame of the site.
    // The footer element has no margin or padding: the frame hairlines of its Container must touch its top and bottom edges, so
    // the vertical padding (py-10) is on the Container, and the space above the footer is each page's own bottom padding.
    <footer className="border-t border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900 print:hidden">
      <Container width="reader" className={`${BAR_FRAME} py-8 sm:py-10`}>
        {/* One column on a phone; from 640px, the name block on the left and the two link groups on the right. */}
        <div className="grid gap-8 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-x-16">
          <div>
            <p className="text-base font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">{site.name}</p>
            {site.positioning && (
              <p className="mt-2 max-w-2xl text-[0.9375rem] text-neutral-600 sm:text-sm dark:text-neutral-400">
                {site.positioning}
              </p>
            )}

            {contacts.length > 0 && (
              <ul className="mt-3 grid gap-0 text-[0.9375rem] sm:mt-4 sm:gap-2 sm:text-sm">
                {contacts.map((link) => (
                  <li key={link.href}>
                    <FooterAnchor link={link} />
                  </li>
                ))}
              </ul>
            )}
          </div>

          <nav aria-label={t('navLabel')} className="grid grid-cols-2 gap-x-6 sm:gap-x-16">
            {FOOTER_GROUPS.map((group) => (
              <div key={group.id}>
                <h2
                  id={group.id}
                  className="text-xs font-semibold tracking-wide text-neutral-600 uppercase dark:text-neutral-400"
                >
                  {t(group.title)}
                </h2>
                <ul aria-labelledby={group.id} className="mt-2 grid gap-0 text-[0.9375rem] sm:mt-3 sm:gap-2 sm:text-sm">
                  {group.links.map((link) => (
                    <li key={link.href}>
                      {/* The icon of a link (random, RSS) is drawn from sm only: below it, one link with an icon and its neighbours without
                          would start its label 24px to the right of the others in the column. */}
                      <FooterAnchor
                        link={{
                          ...link,
                          icon: link.icon ? <span className="hidden sm:contents">{link.icon}</span> : undefined,
                          label: t(`links.${link.label}`),
                        }}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </div>

        <p className="mt-6 text-sm text-neutral-600 sm:mt-8 dark:text-neutral-400">
          {t('copyright', { year: String(year), name: site.name })}
        </p>
      </Container>
    </footer>
  )
}
