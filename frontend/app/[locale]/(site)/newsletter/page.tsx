import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { Container } from '@/components/site/Container'
import { CARD, CARD_PAGE } from '@/components/site/reader/reader-layout'
import { metadataLocale } from '@/lib/locale-path'
import { pageMetadata } from '@/lib/metadata'
import { SignupForm } from './SignupForm'
import { getSiteContent } from '@/lib/site-content'
import { pageDescription } from '@/lib/site-pages'
import { setPageLocale } from '@/i18n/page-locale'

/**
 * /newsletter: the invitation, the signup form (client island, sends through /api/newsletter/subscribe) and the privacy sentence.
 * Static and indexable; the two pages carrying a token (confirm, unsubscribe) are not.
 */

export async function generateMetadata(props: PageProps<'/[locale]/newsletter'>): Promise<Metadata> {
  const locale = await metadataLocale(props.params)
  const t = await getTranslations({ locale, namespace: 'Site.newsletter' })
  const tDescriptions = await getTranslations({ locale, namespace: 'Site.pageDescriptions' })
  const { site, profile } = await getSiteContent(locale)
  return pageMetadata({
    locale,
    title: t('page.title'),
    description: pageDescription('/newsletter', tDescriptions, { siteName: site.name, galleryLead: profile.galleryLead }),
    canonical: '/newsletter',
  })
}

const PRIVACY_HEADING_ID = 'rieng-tu'

export default async function NewsletterPage(props: PageProps<'/[locale]/newsletter'>) {
  await setPageLocale(props.params)
  const t = await getTranslations('Site.newsletter')
  return (
    // No <main> here: app/(site)/layout.tsx holds the single `<main id="main-content">`.
    <Container width="prose" className={CARD_PAGE}>
      <div className={CARD}>
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{t('page.title')}</h1>
        <p className="mt-3 text-neutral-600 dark:text-neutral-400">{t('page.intro')}</p>

        <SignupForm />

        <section aria-labelledby={PRIVACY_HEADING_ID} className="mt-12 border-t border-neutral-200 pt-8 dark:border-neutral-800">
          <h2 id={PRIVACY_HEADING_ID} className="text-lg font-semibold tracking-tight">
            {t('page.privacyHeading')}
          </h2>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-neutral-700 marker:text-neutral-400 dark:text-neutral-300 dark:marker:text-neutral-600">
            <li>{t('page.privacyStored')}</li>
            <li>{t('page.privacyDoubleOptIn')}</li>
            <li>{t('page.privacyUnsubscribeLink')}</li>
            <li>{t('page.privacyNoTracking')}</li>
            <li>{t('page.privacyDeletion')}</li>
          </ul>
        </section>
      </div>
    </Container>
  )
}
