import { useTranslations } from 'next-intl'
import type { ReactNode } from 'react'
import { BrandIcon } from '@/components/BrandIcon'
import { MailIcon } from '@/components/icons'
import type { Contact } from '@/lib/site-content-types'
import { Container } from './Container'
import { ContactForm } from './ContactForm'
import { BAND } from './reader/reader-layout'
import { INLINE_LINK, SectionHeading } from './SectionHeading'

/**
 * `contact.github` is documented as "a URL or a username", so a bare
 * username has to be turned into an absolute URL — `href="octocat"` is a relative path on
 * this site and would 404 silently.
 *
 * Exported because Hero and Footer need the same normalisation for the same field, and
 * two copies of a regex that decides whether a link leaves the site is one copy too many.
 * The right home for it is a shared `lib/contact.ts`; that file is not mine to create this
 * run, so it lives next to the data it describes and is imported from there.
 */
export function githubUrl(github: string): string {
  return /^https?:\/\//i.test(github) ? github : `https://github.com/${github.replace(/^@/, '')}`
}

/** The visible text for a GitHub link: a username, whichever of the two forms the data
 *  used. Falls back to 'GitHub' rather than rendering an empty link. */
export function githubLabel(github: string): string {
  return github.replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\/+$/, '') || 'GitHub'
}

function InfoCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-card border border-neutral-200 bg-neutral-50 p-4 sm:p-5 dark:border-neutral-800 dark:bg-neutral-900">
      <h3 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">{title}</h3>
      <div className="mt-2 text-[0.9375rem] text-neutral-700 sm:text-sm dark:text-neutral-300">{children}</div>
    </div>
  )
}

/**
 * `email` and `github` are filled in by the owner, and either may
 * be null — the file's own rule is that an invented address is worse than no address. So
 * prose with no links at all is a real state for this section, and the layout is built
 * for it rather than degrading into it: the blurb sits in a panel at a size that reads as
 * the intended end of the page, and the list of links is absent rather than empty.
 *
 * `data` is a prop (the page passes the site content) so that both branches are reachable from a test
 * without mocking the content module.
 */
export function ContactSection({
  data,
  bare = false,
}: {
  data: Contact
  /** No Container and no vertical padding: the page places the section in a band it owns. */
  bare?: boolean
}) {
  const t = useTranslations('Site.contact')
  // `rel` is per-link, not blanket: `rel="me"` on a profile URL is the IndieWeb claim
  // that the two identities are the same person, and it says nothing useful on a mailto.
  //
  // One leading icon per channel (Mail/GitHub added to the contact section), aria-hidden: the link name
  // stays the address itself, which is what a screen reader user needs to hear.
  const links: { href: string; label: string; rel?: string; icon: ReactNode }[] = []
  if (data.email) links.push({ href: `mailto:${data.email}`, label: data.email, icon: <MailIcon /> })
  if (data.github) {
    links.push({
      href: githubUrl(data.github),
      label: githubLabel(data.github),
      rel: 'me noreferrer',
      icon: <BrandIcon name="github" />,
    })
  }

  const content = (
    <>
      <SectionHeading id="lien-he" title={t('title')} />

      {/* The card keeps its box. From lg the blurb sits left and the links right on one line, so a 1350px band is not
          one short sentence with an empty right half; below lg it stacks as before. */}
      <div className="mt-6 rounded-card border border-neutral-200 bg-neutral-50 p-4 sm:p-8 lg:flex lg:items-center lg:justify-between lg:gap-x-12 dark:border-neutral-800 dark:bg-neutral-900">
        <p className="max-w-2xl text-base text-neutral-800 sm:text-lg dark:text-neutral-200">{data.blurb}</p>

        {links.length > 0 && (
          <ul className="mt-4 flex flex-wrap gap-x-6 gap-y-0 text-[0.9375rem] sm:mt-6 sm:gap-y-2 sm:text-sm lg:mt-0 lg:shrink-0">
            {links.map((link) => (
              <li key={link.href}>
                <a href={link.href} className={`inline-flex items-center gap-2 max-sm:min-h-11 ${INLINE_LINK}`} rel={link.rel}>
                  {link.icon}
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* The form on the left, two small cards on the right from lg; below lg everything stacks, cards after the form. */}
      <div className="mt-6 grid gap-6 sm:mt-8 sm:gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start">
        <ContactForm />
        <div className="space-y-4">
          <InfoCard title={t('info.expectTitle')}>
            <p>{t('info.expectReply')}</p>
            <p className="mt-2">{t('info.expectWelcome')}</p>
          </InfoCard>
          <InfoCard title={t('info.responseTitle')}>
            <p>{t('info.responseBody')}</p>
          </InfoCard>
        </div>
      </div>
    </>
  )

  if (bare) return <section aria-labelledby="lien-he">{content}</section>
  return (
    <Container as="section" labelledBy="lien-he" className={BAND}>
      {content}
    </Container>
  )
}
