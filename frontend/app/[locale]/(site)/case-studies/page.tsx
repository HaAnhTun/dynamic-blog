import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { BrowseFrame } from '@/components/site/BrowseFrame'
import { CaseStudiesGroup } from '@/components/site/reader/CaseStudiesGroup'
import { TITLE_LINK } from '@/components/site/SectionHeading'
import { metadataLocale } from '@/lib/locale-path'
import { pageMetadata } from '@/lib/metadata'
import { getSiteContent } from '@/lib/site-content'
import { formatDate } from '@/lib/date'
import { pageDescription } from '@/lib/site-pages'
import { setPageLocale } from '@/i18n/page-locale'
import { MEASURE } from '@/components/site/reader/reader-layout'

/**
 * Read from the `case_studies` site content (`getSiteContent`, cached by Next under the `site-content` tag).
 *
 * Why a route of its own rather than a section on /about: the brief of the /about page
 * says plainly that it "must not become a CV dump", and a five-part case study of 300-500
 * words is exactly what would turn it into a CV. One surface, not two.
 *
 * Why NOT `/projects`: that path was removed in commit `f26ef8f` together with all the
 * company project data, and the removal was a privacy decision, not a structural one.
 * Rebuilding the exact old URL would make that decision look like a temporary cleanup.
 * This page only contains projects the author owns entirely.
 */

export async function generateMetadata(props: PageProps<'/[locale]/case-studies'>): Promise<Metadata> {
  const locale = await metadataLocale(props.params)
  const t = await getTranslations({ locale, namespace: 'Site.caseStudies' })
  const descriptions = await getTranslations({ locale, namespace: 'Site.pageDescriptions' })
  const { site, profile } = await getSiteContent(locale)
  return pageMetadata({
    locale,
    title: t('title'),
    description: pageDescription('/case-studies', descriptions, { siteName: site.name, galleryLead: profile.galleryLead }),
    canonical: '/case-studies',
  })
}

export default async function CaseStudiesPage(props: PageProps<'/[locale]/case-studies'>) {
  const locale = await setPageLocale(props.params)
  const t = await getTranslations({ locale, namespace: 'Site.caseStudies' })
  const descriptions = await getTranslations({ locale, namespace: 'Site.pageDescriptions' })
  const { site, profile, caseStudies } = await getSiteContent(locale)
  // One study (the shipped default) is one card across the whole column; a second column only exists when there are two cards
  // to put in it, otherwise a lone half-width card would leave an empty right half.
  const grid = caseStudies.length >= 2 ? ' lg:grid-cols-2' : ''
  return (
    <BrowseFrame extra={<CaseStudiesGroup locale={locale} />}>
      <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{t('title')}</h1>
      <p className={`mt-4 ${MEASURE} leading-relaxed text-neutral-600 dark:text-neutral-400`}>
        {pageDescription('/case-studies', descriptions, { siteName: site.name, galleryLead: profile.galleryLead })}
      </p>
      <p className={`mt-4 ${MEASURE} leading-relaxed text-neutral-600 dark:text-neutral-400`}>
        {t.rich('intro', { b: (chunks) => <strong>{chunks}</strong> })}
      </p>

      {/*
        <ul> rather than a series of loose <article>s: this is a short list, and a list announced as a list lets screen
        reader users know in advance how long it is before entering it.

        Each study is a card (the same `rounded-card border` as the other cards of the site), not a hairline row with the name on
        the left and the text on the right: the sidebar already uses the left of the frame, and a card reads as one unit.
      */}
      <ul className={`mt-8 grid grid-cols-1 gap-6 sm:mt-10${grid}`}>
        {caseStudies.map((study) => (
          <li key={study.slug} className="min-w-0 rounded-card border border-neutral-200 p-4 sm:p-6 dark:border-neutral-800">
            <h2 className="text-xl font-semibold tracking-tight">
              <Link href={`/case-studies/${study.slug}`} className={TITLE_LINK}>
                {study.title}
              </Link>
            </h2>
            <p className={`mt-2 ${MEASURE} leading-relaxed text-neutral-700 dark:text-neutral-300`}>{study.summary}</p>
            {/*
              The number of measurements, not their values. A concrete number here would be a
              second number to keep correct, and it would drift from the detail page the very
              first time someone edits one side; "n measurements" is derived from the array itself.
            */}
            <p className="mt-3 text-sm text-neutral-500 dark:text-neutral-400">
              {t('resultsMeta', {
                count: study.results.length,
                date: formatDate(study.lastVerified, 'long', locale) ?? study.lastVerified,
              })}
            </p>
          </li>
        ))}
      </ul>
    </BrowseFrame>
  )
}
