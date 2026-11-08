import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { Pagination } from '@/components/Pagination'
import { BrowseFrame } from '@/components/site/BrowseFrame'
import { GalleryGrid } from '@/components/site/GalleryGrid'
import { GalleryLightbox } from '@/components/site/GalleryLightbox'
import { getGallery } from '@/lib/gallery'
import { metadataLocale } from '@/lib/locale-path'
import { pageMetadata } from '@/lib/metadata'
import { getSiteContent } from '@/lib/site-content'
import { pageDescription } from '@/lib/site-pages'
import { setPageLocale } from '@/i18n/page-locale'
import { MEASURE } from '@/components/site/reader/reader-layout'

/**
 * Photos: the whole gallery, 24 photos per page, a 3-column grid (4 from xl), a photo viewer.
 *
 * Reads `searchParams`, so the route always renders per request; no `revalidate` here because it has no
 * effect (the 300-second cache sits on the fetch, lib/gallery.ts). No `loading.tsx`: a test pins that, because a
 * streamed shell turns the notFound() of the pagination rule below into HTTP 200.
 */

/** See app/(site)/writing/page.tsx: both exports are checked, the double-quoted literal is deliberate. */
type AcceptsGeneratedProps<T extends (props: PageProps<'/[locale]/gallery'>) => unknown> = T
export type _GalleryAcceptsGeneratedProps = AcceptsGeneratedProps<typeof GalleryPage>
export type _GalleryMetadataAcceptsGeneratedProps = AcceptsGeneratedProps<typeof generateMetadata>

/** 24 = 8 rows of the 3-column grid: evenly divisible, every page ends with a full row. */
const PAGE_SIZE = 24

/** Like /writing: an absurd page number does not exist, knowable without asking anyone. */
const MAX_PAGE = 10_000

/** Copy of parsePage in app/(site)/writing/page.tsx; see the note there about '1.5', '0x2',
 *  '2abc' and the 22-digit string. */
function parsePage(page: string | string[] | undefined): number {
  const raw = Array.isArray(page) ? (page[0] ?? '') : (page ?? '')
  return /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : 0
}

export async function generateMetadata(props: PageProps<'/[locale]/gallery'>): Promise<Metadata> {
  const locale = await metadataLocale(props.params)
  const t = await getTranslations({ locale, namespace: 'Site.gallery' })
  const descriptions = await getTranslations({ locale, namespace: 'Site.pageDescriptions' })
  const { site, profile } = await getSiteContent(locale)
  const { page } = await props.searchParams
  const current = parsePage(page)

  return pageMetadata({
    locale,
    title: t('title'),
    // The lead sentence when the site owner has filled it in, otherwise a sentence that only says who posts these photos.
    description: pageDescription('/gallery', descriptions, { siteName: site.name, galleryLead: profile.galleryLead }),
    // Keep the page number instead of folding into the first page, like /writing: photos that exist only on page 2 must not be
    // told to leave the index.
    canonical: current > 0 ? `/gallery?page=${current}` : '/gallery',
  })
}

export default async function GalleryPage(props: PageProps<'/[locale]/gallery'>) {
  const locale = await setPageLocale(props.params)
  const t = await getTranslations({ locale, namespace: 'Site.gallery' })
  const { profile } = await getSiteContent(locale)
  const { page } = await props.searchParams
  const current = parsePage(page)

  // Before any API call: an absurd page does not exist.
  if (current > MAX_PAGE) notFound()

  // Errors are not caught: photos are the main content of this page. "No photos yet." while the API is down is
  // a green page that is wrong; throw so that app/error.tsx says 500, like /writing.
  const { items, meta } = await getGallery({ page: current, size: PAGE_SIZE })

  // `current > 0`, not `totalPages > 0`: the first page always exists (an empty one shows
  // "No photos yet."), whereas ?page=1 of an empty gallery does not, like /writing.
  if (current > 0 && current >= meta.totalPages) notFound()

  return (
    <>
      {/* No <main> here. app/layout.tsx owns the document's single `<main id="main-content">`. */}
      <BrowseFrame>
        <header className="pb-6">
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{t('title')}</h1>
          {/* Only when the site owner has filled it in (`profile.galleryLead`): no invented lead sentence stands in. */}
          {profile.galleryLead ? (
            <p className={`mt-3 ${MEASURE} text-neutral-600 dark:text-neutral-400`}>{profile.galleryLead}</p>
          ) : null}
          {meta.totalElements > 0 ? (
            <p className="mt-2 text-sm tabular-nums text-neutral-600 dark:text-neutral-400">
              {t('count', { count: meta.totalElements })}
            </p>
          ) : null}
        </header>

        <div>
          {items.length === 0 ? (
            <p className="py-6 text-neutral-600 dark:text-neutral-400">{t('empty')}</p>
          ) : (
            // The photo viewer cycles through the photos of this page: the next page is a different URL.
            // `eager={3}`: the grid is the first content of every /gallery page, the first row (3 cells) is in
            // the first screen and the first cell is the LCP element; if left lazy the browser discovers it late.
            <GalleryLightbox photos={items}>
              <GalleryGrid photos={items} eager={3} columns={4} width="browse" layout="justified" />
            </GalleryLightbox>
          )}
          <Pagination meta={meta} basePath="/gallery" />
        </div>
      </BrowseFrame>
    </>
  )
}
