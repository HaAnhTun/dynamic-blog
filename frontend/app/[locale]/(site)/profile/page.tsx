import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { Container } from '@/components/site/Container'
import { CARD, CARD_PAGE } from '@/components/site/reader/reader-layout'
import { ProfileCard } from '@/components/site/ProfileCard'
import { metadataLocale } from '@/lib/locale-path'
import { pageMetadata } from '@/lib/metadata'
import { AuthorApplicationSection } from './AuthorApplication'
import { setPageLocale } from '@/i18n/page-locale'

/**
 * /profile: the GitHub account profile of the current reader.
 *
 * A static frame, identical for everyone: the page reads no cookie (reading one makes it a dynamic page),
 * so the HTML is prerendered and the cache never carries anyone's data. ProfileCard (client) asks
 * /api/session after hydration and then fills in the profile, or invites the reader to sign in.
 *
 * noindex: to a crawler this page is only "You are not signed in.", nothing to find.
 */

/**
 * Deliberately static. `'error'` rather than the default: a `cookies()` or `headers()` added later
 * makes `next build` stop with an error, instead of silently turning the page dynamic, and then a "while I am here" fix
 * that reads the session on the server would put one person's data into the HTML of the page.
 */
export const dynamic = 'error'

export async function generateMetadata(props: PageProps<'/[locale]/profile'>): Promise<Metadata> {
  const locale = await metadataLocale(props.params)
  const t = await getTranslations({ locale, namespace: 'Site.profile' })
  return {
    ...(await pageMetadata({
      locale,
      title: t('page.title'),
      description: t('page.metaDescription'),
      canonical: '/profile',
    })),
    // follow: false like /login: the only link here is the start route (nofollow, /api is blocked by robots.txt).
    robots: { index: false, follow: false },
  }
}

export default async function ProfilePage(props: PageProps<'/[locale]/profile'>) {
  await setPageLocale(props.params)
  const t = await getTranslations('Site.profile')
  return (
    // No <main> here: app/(site)/layout.tsx holds the single `<main id="main-content">`.
    <Container width="prose" className={CARD_PAGE}>
      <div className={CARD}>
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{t('page.title')}</h1>
        <ProfileCard />
        {/* The author application: also a client island, loaded after the session answers. */}
        <AuthorApplicationSection />
      </div>
    </Container>
  )
}
