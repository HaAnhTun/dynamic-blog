import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { BrowseFrame } from '@/components/site/BrowseFrame'
import { FOCUS } from '@/components/site/SectionHeading'
import { metadataLocale } from '@/lib/locale-path'
import { pageMetadata } from '@/lib/metadata'
import { BookmarkList } from './BookmarkList'
import { setPageLocale } from '@/i18n/page-locale'

/**
 * /bookmarks: static frame like /notifications, identical for everyone; BookmarkList (client) asks for the
 * session after hydration and then loads the saved posts through the no-store BFF route. noindex, outside the sitemap, NOT blocked in
 * robots.txt: a crawler must be able to read the page to see the noindex.
 */

/** Deliberately static: a `cookies()` or `headers()` added later makes `next build` stop with an error. */
export const dynamic = 'error'

/** Id of the heading: unbookmarking the last post or "Try again" moves focus here. */
const HEADING_ID = 'bai-da-luu-heading'

export async function generateMetadata(props: PageProps<'/[locale]/bookmarks'>): Promise<Metadata> {
  const locale = await metadataLocale(props.params)
  const t = await getTranslations({ locale, namespace: 'Site.bookmarks' })
  return {
    ...(await pageMetadata({
      locale,
      title: t('page.title'),
      description: t('page.metaDescription'),
      canonical: '/bookmarks',
    })),
    // follow: false like /notifications: the only link for guests is the start route (nofollow, /api is blocked by robots.txt).
    robots: { index: false, follow: false },
  }
}

export default async function BookmarksPage(props: PageProps<'/[locale]/bookmarks'>) {
  await setPageLocale(props.params)
  const t = await getTranslations('Site.bookmarks')
  return (
    // No <main> here: app/(site)/layout.tsx holds the single `<main id="main-content">`.
    <BrowseFrame>
      <h1 id={HEADING_ID} tabIndex={-1} className={`text-3xl font-bold tracking-tight sm:text-4xl ${FOCUS}`}>
        {t('page.title')}
      </h1>
      <BookmarkList headingId={HEADING_ID} />
    </BrowseFrame>
  )
}
