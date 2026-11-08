import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { Container } from './Container'
import { CARD, CARD_PAGE } from './reader/reader-layout'
import { INLINE_LINK, PHONE_BUTTON, PHONE_PRIMARY, PHONE_SECONDARY } from './SectionHeading'

/**
 * The content part of the 404 page, shared by the two not-found files.
 *
 * Two files because Next has two paths to a 404, and they differ in the page frame:
 *   - app/(site)/not-found.tsx: a page inside the (site) group calls notFound() (a missing post, series, gallery
 *     page or archive year). Next renders it INSIDE app/(site)/layout.tsx, which already has the
 *     header, `<main id="main-content">` and the footer, so it may only carry this part.
 *   - app/not-found.tsx: a URL that matches no route. Next renders it in app/layout.tsx (only
 *     `<html>`/`<body>`), so it carries the page frame around this part itself.
 *
 * Before the first file existed, notFound() inside the group fell back to the second file and the page had two headers,
 * two footers, and a `<main>` nested in a `<main>` with a duplicate id (measured on the QA stack: main=2, main
 * navigation nav=2). One component for both keeps the two undated 404 pages from saying two different things.
 */
export function NotFoundContent() {
  const t = useTranslations('Site.notFound')
  return (
    <Container width="prose" className={CARD_PAGE}>
      <div className={CARD}>
        <p className="font-mono text-sm text-neutral-500 dark:text-neutral-400">404</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">{t('title')}</h1>
        <p className="mt-3 text-neutral-600 dark:text-neutral-400">{t('lead')}</p>
        <div className="mt-6 flex flex-col gap-3 text-sm sm:mt-8 sm:flex-row sm:flex-wrap sm:gap-x-6 sm:gap-y-2">
          <Link href="/" className={`${INLINE_LINK} ${PHONE_BUTTON} max-sm:justify-center ${PHONE_PRIMARY}`}>
            {t('home')}
          </Link>
          <Link href="/writing" className={`${INLINE_LINK} ${PHONE_BUTTON} max-sm:justify-center ${PHONE_SECONDARY}`}>
            {t('allPosts')}
          </Link>
          <Link href="/search" className={`${INLINE_LINK} ${PHONE_BUTTON} max-sm:justify-center ${PHONE_SECONDARY}`}>
            {t('search')}
          </Link>
        </div>
      </div>
    </Container>
  )
}
