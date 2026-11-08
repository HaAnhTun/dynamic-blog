import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { Container } from '@/components/site/Container'
import { CARD, CARD_PAGE } from '@/components/site/reader/reader-layout'
import { NotificationsCenter } from '@/components/site/notifications/NotificationsCenter'
import { FOCUS } from '@/components/site/SectionHeading'
import { metadataLocale } from '@/lib/locale-path'
import { pageMetadata } from '@/lib/metadata'
import { setPageLocale } from '@/i18n/page-locale'

/**
 * /notifications: every notification of the current reader: who liked or commented on their post, who replied to or
 * liked their comment.
 *
 * A static frame like /profile, identical for everyone: the page reads no cookie, so the HTML is
 * prerendered and the cache never carries anyone's data. NotificationsCenter (client) asks for the session after
 * hydration and then loads the notifications through the no-store BFF route, or invites the reader to sign in.
 *
 * noindex, not in the sitemap: to a crawler this page is only a sign-in invitation.
 */

/**
 * Deliberately static, for the same reason as /profile: a `cookies()` or `headers()` added later makes `next
 * build` stop with an error, instead of silently turning the page dynamic and putting one person's notifications into the HTML.
 */
export const dynamic = 'error'

/** Id of the heading: after the last notification of the list is deleted, focus returns here. */
const HEADING_ID = 'thong-bao-heading'

export async function generateMetadata(props: PageProps<'/[locale]/notifications'>): Promise<Metadata> {
  const locale = await metadataLocale(props.params)
  const t = await getTranslations({ locale, namespace: 'Site.notifications' })
  return {
    ...(await pageMetadata({
      locale,
      title: t('page.title'),
      description: t('page.metaDescription'),
      canonical: '/notifications',
    })),
    // follow: false like /profile: the only link for guests is the start route (nofollow, /api is blocked by robots.txt).
    robots: { index: false, follow: false },
  }
}

export default async function NotificationsPage(props: PageProps<'/[locale]/notifications'>) {
  await setPageLocale(props.params)
  const t = await getTranslations('Site.notifications')
  return (
    // No <main> here: app/(site)/layout.tsx holds the single `<main id="main-content">`.
    <Container width="prose" className={CARD_PAGE}>
      <div className={CARD}>
        <h1 id={HEADING_ID} tabIndex={-1} className={`text-3xl font-bold tracking-tight sm:text-4xl ${FOCUS}`}>
          {t('page.title')}
        </h1>
        <NotificationsCenter headingId={HEADING_ID} />
      </div>
    </Container>
  )
}
