import type { Metadata } from 'next'
import Image from 'next/image'
import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import type { ReactNode } from 'react'
import { BrandIcon, type BrandName } from '@/components/BrandIcon'
import { BriefcaseIcon, GraduationCapIcon, LinkIcon, MailIcon } from '@/components/icons'
import { githubLabel, githubUrl } from '@/components/site/ContactSection'
import { CodeTabsView } from '@/components/site/blocks/CodeTabsView'
import { Container } from '@/components/site/Container'
import { GallerySection } from '@/components/site/GallerySection'
import { ArticleBody } from '@/components/site/ArticleView'
import { EntryLogo, HighlightList, OrgName, TechPills, joinFacts, textOf } from '@/components/site/entry-parts'
import { ProfilePageJsonLd } from '@/components/site/JsonLd'
import { MEASURE_CARD, MEASURE_LEAD } from '@/components/site/reader/reader-layout'
import { FOCUS_RING, SectionHeading, TRANSITION } from '@/components/site/SectionHeading'
import { plainLead } from '@/lib/about-body'
import { getGallery } from '@/lib/gallery'
import { renderMarkdown } from '@/lib/markdown'
import type { GalleryPhoto } from '@/lib/types'
import { metadataLocale } from '@/lib/locale-path'
import { pageMetadata } from '@/lib/metadata'
import { getSiteContent } from '@/lib/site-content'
import type { Contact, SkillGroup, TimelineEntry } from '@/lib/site-content-types'
import { setPageLocale } from '@/i18n/page-locale'

/**
 * Rendered per request, not prerendered at build time, for the same reason and in the same way as the home page.
 *
 * This page used to be fully static, built only from the site content. The "Photos" section reads the
 * gallery from the API, and during `docker build` there is no API: prerendering would bake in a page
 * without photos and serve it until the first revalidate. With `force-dynamic` the page is right from the first request;
 * the 300-second cache sits on the fetch (lib/gallery.ts), so the number of backend calls is unchanged. No
 * `revalidate` either: next to `force-dynamic` it has no effect (see the note in app/(site)/page.tsx).
 */
export const dynamic = 'force-dynamic'

/** Like the home page: one row of the 6-column band. */
const PHOTOS_ON_ABOUT = 6

/** Secondary block: an API failure is an empty array, and empty means no section. The rest of the page
 *  does not depend on the backend at all, and must not turn into a 500 because of the gallery. */
async function photosForAbout(): Promise<GalleryPhoto[]> {
  try {
    const { items } = await getGallery({ page: 0, size: PHOTOS_ON_ABOUT })
    return items
  } catch {
    return []
  }
}

/**
 * The About page, built only from data the site already has (site content: `about`, `profile`, `contact`, `skills`, `timeline`,
 * plus the gallery for the photos band). Bands, top to bottom: the hero (photo and contact icons left, title and intro right),
 * the skills as tabs of tiles, the experience as a timeline of cards, the education as cards, then the Markdown body, the legacy
 * section cards (only when there is no body), the photos and "Read next". A band with no data is not rendered at all.
 */

/**
 * Through lib/metadata.ts. This page used to write its own `openGraph` block, and that is
 * precisely why it was the one route measured emitting NO `og:locale` and NO
 * `og:site_name`: a segment's `openGraph` replaces the inherited object whole, so
 * restating four fields silently dropped the two it did not restate.
 *
 * `canonical` is not optional: metadata is merged down the tree, so without it the page
 * would inherit the root's and declare itself a duplicate of the homepage.
 */
export async function generateMetadata(props: PageProps<'/[locale]/about'>): Promise<Metadata> {
  const locale = await metadataLocale(props.params)
  const t = await getTranslations({ locale, namespace: 'Site.about' })
  const { about } = await getSiteContent(locale)
  return pageMetadata({
    locale,
    title: t('title'),
    // The intro, or the first plain sentence of the body when the intro is empty.
    description: about.intro.trim() !== '' ? about.intro : plainLead(about.body ?? ''),
    canonical: '/about',
  })
}

/**
 * Every band is a `Container width="reader"` with the same vertical rhythm as the home page, so every text edge lines up with the
 * header logo.
 */
const BAND = 'py-8 sm:py-14'

/** Two columns from lg: the person on the left (a fixed track), the title and intro on the right; one column below, in DOM order. */
const HERO_GRID = 'grid gap-8 lg:grid-cols-[13rem_minmax(0,1fr)] lg:items-start lg:gap-x-16'

/** The legacy section cards: two columns from lg (row-major, so DOM order = visual order); a lone last card spans the row. */
const CARDS = 'grid items-start gap-6 lg:grid-cols-2 lg:[&>:last-child:nth-child(odd)]:col-span-2'

/** A bordered card of the timeline and the education list. */
const ENTRY_CARD = 'rounded-card border border-neutral-200 p-4 sm:p-5 dark:border-neutral-800'

/** A round bordered icon link of the hero; 44 px square on a phone, 36 px from `md`, the name is its `aria-label`. */
const ICON_LINK = `inline-flex h-11 w-11 items-center md:h-9 md:w-9 justify-center rounded-full border border-neutral-200 text-neutral-700 hover:border-brand hover:text-brand dark:border-neutral-800 dark:text-neutral-300 ${TRANSITION} ${FOCUS_RING}`

/** "Read next": editorial entry first, then the project evidence, all posts, photos. */
const READ_NEXT = [
  { href: '/start-here', labelKey: 'startHere' },
  { href: '/case-studies', labelKey: 'caseStudies' },
  { href: '/writing', labelKey: 'writing' },
  { href: '/gallery', labelKey: 'gallery' },
] as const

type IconLinkData = { href: string; label: string; rel?: string; icon: ReactNode }

/** The brand mark of a social link by its host, or null when the host is not one of the marks the site has. */
function brandOf(url: string): BrandName | null {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    if (host === 'linkedin.com') return 'linkedin'
    if (host === 'x.com' || host === 'twitter.com') return 'x'
    if (host === 'facebook.com') return 'facebook'
  } catch {
    // Not an absolute URL: it gets the generic link icon.
  }
  return null
}

/** Email and GitHub first (built like ContactSection), then the contact social links; a repeated address appears once. */
function contactLinks(contact: Contact): IconLinkData[] {
  const links: IconLinkData[] = []
  if (contact.email) links.push({ href: `mailto:${contact.email}`, label: contact.email, icon: <MailIcon /> })
  if (contact.github) {
    links.push({
      href: githubUrl(contact.github),
      label: githubLabel(contact.github),
      rel: 'me noreferrer',
      icon: <BrandIcon name="github" />,
    })
  }
  for (const social of contact.social) {
    if (links.some((link) => link.href === social.url)) continue
    const brand = brandOf(social.url)
    const mail = social.url.startsWith('mailto:')
    links.push({
      href: social.url,
      label: social.label,
      rel: mail ? undefined : 'me noreferrer',
      icon: brand ? <BrandIcon name={brand} /> : mail ? <MailIcon /> : <LinkIcon />,
    })
  }
  return links
}

export default async function AboutPage(props: PageProps<'/[locale]/about'>) {
  const locale = await setPageLocale(props.params)
  const t = await getTranslations({ locale, namespace: 'Site.about' })
  const { about, profile, contact, skills, timeline } = await getSiteContent(locale)
  const photos = await photosForAbout()
  // The body is Markdown with the same blocks as an article, drawn by the one renderer. A level-1 heading in it becomes a level 2: the
  // page title above is the only h1. `renderMarkdown` throwing is a real error that reaches error.tsx, as on the post page.
  const body = (about.body ?? '').trim() === '' ? null : await renderMarkdown(about.body as string, { demoteTopHeading: true })
  const links = contactLinks(contact)
  const heroPhoto = about.photo || profile.avatar
  const groups = skills.filter((group) => group.items.length > 0)
  const experience = timeline.entries.filter((entry) => entry.kind === 'experience')
  const education = timeline.entries.filter((entry) => entry.kind === 'education')

  return (
    <>
      {/* This page is one person's profile, which is the case Google documents this type
          for. Every property it claims is rendered below: name, role and GitHub in the hero. */}
      <ProfilePageJsonLd name={profile.name} role={profile.role} github={contact.github} locale={locale} />

      {/* Hero band: the person on the left (photo only when there is one, then name, role, location, icon links), the h1 and the
          intro on the right. Below lg one column in DOM order. No card border around the left column. */}
      <Container width="reader" className={BAND}>
        <div className={HERO_GRID}>
          <div className="min-w-0">
            {/* Below `lg` the photo (80px) sits beside the name, role and location, one block of three lines; from `lg` it is the 176px
                picture above them in the left column. */}
            <div className="flex items-center gap-4 lg:block">
              {/* The photo of the About page, else the profile avatar. Neither: no fake face or initial letter in a circle stands in for a
                  missing image. Decorative, the name follows. */}
              {heroPhoto ? (
                <Image
                  src={heroPhoto}
                  alt=""
                  width={176}
                  height={176}
                  unoptimized
                  className="h-20 w-20 shrink-0 rounded-full border border-neutral-200 object-cover lg:mb-5 lg:h-44 lg:w-44 dark:border-neutral-800"
                />
              ) : null}
              <div className="min-w-0">
                {/* Label rows, not paragraphs: <div>, so they do not eat into the "not a CV" <p> budget. */}
                <div className="text-lg font-semibold tracking-tight">{profile.name}</div>
                <div className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">{profile.role}</div>
                <div className="mt-0.5 text-sm text-neutral-600 dark:text-neutral-400">{profile.location}</div>
              </div>
            </div>
            {links.length > 0 ? (
              <ul className="mt-4 flex flex-wrap gap-2">
                {links.map((link) => (
                  <li key={link.href}>
                    <a href={link.href} rel={link.rel} aria-label={link.label} className={ICON_LINK}>
                      {link.icon}
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <div className="min-w-0">
            <h1 className="text-3xl leading-[1.2] font-bold tracking-tight sm:text-4xl sm:leading-10">{t('title')}</h1>
            {about.intro.trim() !== '' ? (
              <p
                className={`mt-4 ${MEASURE_LEAD} text-[1.0625rem] leading-relaxed text-neutral-600 sm:text-lg dark:text-neutral-400`}
              >
                {about.intro}
              </p>
            ) : null}
          </div>
        </div>
      </Container>

      {/* Skills: one underline tab per group (the tabs of the article `tabs` block: arrow keys, Home and End), a grid of tiles in each
          panel with the name and, when there is one, its note. No logos. */}
      {groups.length > 0 ? (
        <Container as="section" labelledBy="about-skills" width="reader" className={BAND}>
          <SectionHeading id="about-skills" title={t('skillsTitle')} />
          <div className="mt-6">
            <CodeTabsView
              groupLabel={t('skillsTitle')}
              labels={groups.map((group) => group.title)}
              panels={groups.map((group) => (
                <SkillTiles key={group.id} group={group} />
              ))}
              panelClass="p-3 sm:p-4"
            />
          </div>
        </Container>
      ) : null}

      {/* Experience: a vertical timeline, a dot on the rail for each bordered card. */}
      {experience.length > 0 ? (
        <Container as="section" labelledBy="about-experience" width="reader" className={BAND}>
          <SectionHeading id="about-experience" title={t('experienceTitle')} />
          {/* The rail and its dots are from `sm`: on a phone the card takes the whole width (text at the 16px gutter plus the card padding,
              not 46px further in) and the cards are separated by their own spacing. */}
          <ol className="mt-6 space-y-4 sm:space-y-6 sm:border-s sm:border-neutral-200 sm:ps-6 dark:sm:border-neutral-800">
            {experience.map((entry) => (
              <li key={`${entry.title}-${entry.org}-${entry.period}`} className="relative">
                <span
                  aria-hidden="true"
                  className="absolute top-6 -start-[calc(1.5rem+0.25rem+0.5px)] hidden h-2 w-2 rounded-full bg-brand sm:block"
                />
                <EntryCard entry={entry} icon={<BriefcaseIcon size={14} />} />
              </li>
            ))}
          </ol>
        </Container>
      ) : null}

      {/* Education: stacked bordered cards. */}
      {education.length > 0 ? (
        <Container as="section" labelledBy="about-education" width="reader" className={BAND}>
          <SectionHeading id="about-education" title={t('educationTitle')} />
          <ul className="mt-6 space-y-4">
            {education.map((entry) => (
              <li key={`${entry.title}-${entry.org}-${entry.period}`}>
                <EntryCard entry={entry} icon={<GraduationCapIcon size={14} />} />
              </li>
            ))}
          </ul>
        </Container>
      ) : null}

      {/* The body band: what the owner wrote as Markdown with blocks (`about.body`), in the article prose styling. */}
      {body !== null ? (
        <Container width="reader" className={BAND}>
          <ArticleBody
            content={body.content}
            className="mt-0 border-t border-neutral-200 pt-6 sm:mt-8 sm:border-t-0 sm:pt-0 dark:border-neutral-800"
          />
        </Container>
      ) : null}

      {/*
        Legacy section cards, only for a page that has no body: the body replaces them. Rendered straight from `about.sections`, in
        array order: the content file decides the order. The `id` on each <section> is the content file's own id, so
        `/about#stack` is a stable deep link.

        Each body element is a finished paragraph and becomes one <p>. `.prose` is what
        gives Vietnamese text its taller line-height (globals.css sets 1.8 on it,
        because the default lets tone marks collide with the line above).
      */}
      {body === null && about.sections.length > 0 ? (
        <Container width="reader" className={BAND}>
          <div className={CARDS}>
            {about.sections.map((section) => (
              <section
                key={section.id}
                id={section.id}
                className="min-w-0 rounded-card border border-neutral-200 p-6 dark:border-neutral-800"
              >
                <h2 className="text-xl font-semibold tracking-tight">{section.title}</h2>
                <div className={`prose prose-neutral mt-3 ${MEASURE_CARD} dark:prose-invert`}>
                  {section.body.map((paragraph) => (
                    <p key={paragraph}>{paragraph}</p>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </Container>
      ) : null}

      {/* Photos band: full frame, 6 columns. With no photos or an API failure nothing renders (not even a band). */}
      <GallerySection id="anh" photos={photos} headingLevel={2} />

      {/*
        A nav landmark inside <main>, so it needs its own accessible name: the site
        header already contributes "Main navigation" and two unnamed navs are
        indistinguishable in a landmark list.

        "Photos →" is there even when the gallery is empty, like the footer's "Photos": /gallery is
        then still a 200 that says "No photos yet.", not a dead link.

        The aria-hidden arrow, like every other "… →" link on the site (SectionHeading, AuthorBox,
        "See all photos →"): the accessible name is the label, not "label right arrow".
      */}
      <Container width="reader" className={BAND}>
        <nav
          aria-label={t('readNext')}
          className="grid grid-cols-2 gap-x-4 border-t border-neutral-200 pt-4 text-[0.9375rem] sm:flex sm:flex-wrap sm:gap-x-6 sm:gap-y-3 sm:pt-6 sm:text-sm dark:border-neutral-800"
        >
          {READ_NEXT.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-sm py-3 text-brand transition-colors duration-[120ms] hover:underline sm:py-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand motion-reduce:transition-none"
            >
              {t(`readNextLinks.${item.labelKey}`)} <span aria-hidden="true">→</span>
            </Link>
          ))}
        </nav>
      </Container>
    </>
  )
}

/** One panel of the skills tabs: small rounded bordered tiles with the skill name and, when there is one, its note below it. */
function SkillTiles({ group }: { group: SkillGroup }) {
  return (
    <ul className="grid grid-cols-2 items-start gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
      {group.items.map((skill) => (
        // On a phone the tile is a tint, not a fourth hairline box inside the frame, the panel and the tab row; from `sm` the hairline tile.
        <li
          key={skill.name}
          className="min-w-0 rounded-lg border border-transparent bg-neutral-50 px-3 py-2.5 sm:border-neutral-200 sm:bg-transparent dark:bg-neutral-900 dark:sm:border-neutral-800 dark:sm:bg-transparent"
        >
          <span className="block text-[0.9375rem] font-medium [overflow-wrap:anywhere] sm:text-sm">{skill.name}</span>
          {skill.note ? (
            <span className="mt-0.5 block text-[0.8125rem] text-neutral-600 [overflow-wrap:anywhere] sm:text-xs dark:text-neutral-400">
              {skill.note}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

/**
 * A card of the experience timeline or the education list, like the reference About pages: the company or school is the heading (a
 * link when the entry has an https address) with the logo at the top right, then the role or degree, the period and location, the
 * department, the blurb, the bullet highlights and the technology pills. An entry without a company or school (the neutral defaults)
 * is headed by its role or degree alone. Every detail that is not set leaves nothing behind, not even an empty line.
 */
function EntryCard({ entry, icon }: { entry: TimelineEntry; icon: ReactNode }) {
  const org = textOf(entry.org)
  const title = textOf(entry.title)
  const when = joinFacts([entry.period, entry.location])
  const department = textOf(entry.department)
  const summary = textOf(entry.summary)
  return (
    <div className={ENTRY_CARD}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="flex items-start gap-2 text-lg font-semibold [overflow-wrap:anywhere]">
            {/* items-start and 7px: the icon stays beside the FIRST line of a name that wraps, instead of floating between two lines. */}
            <span aria-hidden="true" className="mt-[7px] shrink-0 text-neutral-500 dark:text-neutral-400">
              {icon}
            </span>
            <span className="min-w-0">{org !== '' ? <OrgName name={org} url={entry.url} /> : title}</span>
          </h3>
          {org !== '' && title !== '' ? <div className="mt-1 text-base font-medium [overflow-wrap:anywhere]">{title}</div> : null}
          {when !== '' ? <div className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">{when}</div> : null}
          {department !== '' ? <div className="mt-0.5 text-sm text-neutral-600 dark:text-neutral-400">{department}</div> : null}
        </div>
        <EntryLogo src={entry.logo} className="h-12 w-12 sm:h-14 sm:w-14" />
      </div>
      {summary !== '' ? <p className={`mt-3 ${MEASURE_CARD} text-neutral-700 dark:text-neutral-300`}>{summary}</p> : null}
      <HighlightList items={entry.highlights} className="mt-3" collapse />
      <TechPills items={entry.tech} className="mt-4" />
    </div>
  )
}
