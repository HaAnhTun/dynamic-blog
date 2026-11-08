import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { Pagination } from '@/components/Pagination'
import { BrowseFrame } from '@/components/site/BrowseFrame'
import { CollectionPageJsonLd } from '@/components/site/JsonLd'
import { SeriesEntry, seriesPath } from '@/components/site/SeriesEntry'
import { LanguageFallback } from '@/components/site/LanguageFallback'
import { otherLanguageWithPosts } from '@/lib/language-fallback'
import { metadataLocale } from '@/lib/locale-path'
import { pageMetadata } from '@/lib/metadata'
import { getSeriesList } from '@/lib/series'
import { getSiteContent } from '@/lib/site-content'
import { pageDescription } from '@/lib/site-pages'
import { setPageLocale } from '@/i18n/page-locale'
import { MEASURE } from '@/components/site/reader/reader-layout'

/**
 * Every series, the series with the newest post first; the order is decided by the backend
 * (`latestPublishedAt DESC, title ASC`), and the page keeps it.
 *
 * Reads `searchParams`, so the route always renders per request; no `revalidate` here because it would have
 * no effect (the cache sits on the fetch, lib/series.ts). No `loading.tsx`: pinned by a test, because a
 * streamed shell turns the notFound() of the pagination rule below into HTTP 200.
 */

/** See categories/[slug]/page.tsx: both exports are checked, the double-quoted literal is deliberate. */
type AcceptsGeneratedProps<T extends (props: PageProps<'/[locale]/series'>) => unknown> = T
export type _SeriesIndexAcceptsGeneratedProps = AcceptsGeneratedProps<typeof SeriesIndex>
export type _SeriesIndexMetadataAcceptsGeneratedProps = AcceptsGeneratedProps<typeof generateMetadata>

/** 20 series per page: the backend returns the whole list, the page cuts it itself. */
const PAGE_SIZE = 20

/** Like /writing: an absurd page number does not exist, knowable without asking anyone. */
const MAX_PAGE = 10_000

/** Copy of parsePage in app/(site)/writing/page.tsx; see the note there about '1.5', '0x2',
 *  '2abc' and the 22-digit string. */
function parsePage(page: string | string[] | undefined): number {
  const raw = Array.isArray(page) ? (page[0] ?? '') : (page ?? '')
  return /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : 0
}

/**
 * Title, description and canonical of a series index page, built once for generateMetadata
 * and for the CollectionPage in the page body, like /writing: the URL in the JSON-LD and the canonical tag are
 * one string, not two expressions that happen to match.
 */
function seriesIndexHead(page: number, title: string, description: string) {
  return {
    title,
    description,
    // Keep the page number instead of folding into the first page, like /writing: a series that exists only on page 2 must not
    // be told to leave the index.
    canonical: page > 0 ? `/series?page=${page}` : '/series',
  }
}

export async function generateMetadata(props: PageProps<'/[locale]/series'>): Promise<Metadata> {
  const locale = await metadataLocale(props.params)
  const t = await getTranslations({ locale, namespace: 'Site.series' })
  const descriptions = await getTranslations({ locale, namespace: 'Site.pageDescriptions' })
  const { site, profile } = await getSiteContent(locale)
  const { page } = await props.searchParams
  return pageMetadata({
    ...seriesIndexHead(
      parsePage(page),
      t('title'),
      pageDescription('/series', descriptions, { siteName: site.name, galleryLead: profile.galleryLead }),
    ),
    locale,
  })
}

export default async function SeriesIndex(props: PageProps<'/[locale]/series'>) {
  const locale = await setPageLocale(props.params)
  const t = await getTranslations({ locale, namespace: 'Site.series' })
  const descriptions = await getTranslations({ locale, namespace: 'Site.pageDescriptions' })
  const { site, profile } = await getSiteContent(locale)
  const { page } = await props.searchParams
  const current = parsePage(page)

  // Before any API call: an absurd page does not exist.
  if (current > MAX_PAGE) notFound()

  // Errors are not caught: this is the main content. "No series yet." while the API is down is a
  // green page that is wrong; throw so that app/error.tsx says 500, like /writing.
  const all = await getSeriesList(locale)

  const totalPages = Math.ceil(all.length / PAGE_SIZE)
  // `current > 0`, not `totalPages > 0`: the first page always exists (an empty one shows
  // "No series yet."), whereas ?page=1 of an empty list does not, like /writing.
  if (current > 0 && current >= totalPages) notFound()

  const fallbackLanguage =
    all.length === 0 ? await otherLanguageWithPosts(locale, async (language) => (await getSeriesList(language)).length) : null
  const items = all.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)
  const head = seriesIndexHead(
    current,
    t('title'),
    pageDescription('/series', descriptions, { siteName: site.name, galleryLead: profile.galleryLead }),
  )

  return (
    <>
      {/* This page lists series, not posts: the ItemList is the series pages of exactly this page,
          in the order shown, numbered continuing after the previous pages. The parts printed under each series
          are shortcuts, not part of the list. No BreadcrumbList: the page has no visible
          breadcrumb. With no series yet the component renders nothing. */}
      <CollectionPageJsonLd
        locale={locale}
        name={head.title}
        description={head.description}
        url={head.canonical}
        offset={current * PAGE_SIZE}
        items={items.map((series) => ({ name: series.title, url: seriesPath(series.slug) }))}
      />

      <BrowseFrame current={{ key: 'series', exact: true }}>
        <header className="pb-6">
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{head.title}</h1>
          <p className={`mt-3 ${MEASURE} text-neutral-600 dark:text-neutral-400`}>{head.description}</p>
        </header>

        {/* No heading for this block, like /writing: the series name is the h2 right below the page h1. */}
        <div>
          {items.length === 0 ? (
            fallbackLanguage ? (
              <LanguageFallback path="/series" language={fallbackLanguage} />
            ) : (
              <p className="py-6 text-neutral-600 dark:text-neutral-400">{t('empty')}</p>
            )
          ) : (
            <ul className="border-t border-neutral-200 dark:border-neutral-800">
              {items.map((series) => (
                <li key={series.id} className="border-b border-neutral-200 py-8 last:border-0 dark:border-neutral-800">
                  <SeriesEntry series={series} />
                </li>
              ))}
            </ul>
          )}
          <Pagination meta={{ page: current, size: PAGE_SIZE, totalElements: all.length, totalPages }} basePath="/series" />
        </div>
      </BrowseFrame>
    </>
  )
}
