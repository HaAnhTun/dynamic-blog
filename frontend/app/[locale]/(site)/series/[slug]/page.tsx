import type { Metadata } from 'next'
import { Link } from '@/i18n/navigation'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { postPath } from '@/components/site/ArticleJsonLd'
import { SeriesBreadcrumb, seriesBreadcrumbTrail } from '@/components/site/Breadcrumb'
import { BrowseFrame } from '@/components/site/BrowseFrame'
import type { SidebarCurrent } from '@/components/site/reader/SiteSidebar'
import { BreadcrumbJsonLd, CollectionPageJsonLd } from '@/components/site/JsonLd'
import { ListRow } from '@/components/site/ListRow'
import { readingMinutesOf } from '@/components/site/ReadingMeta'
import { SeriesMeta } from '@/components/site/SeriesMeta'
import { LanguageFallback } from '@/components/site/LanguageFallback'
import { INLINE_LINK, PHONE_BUTTON, PHONE_PRIMARY, SectionHeading, TITLE_LINK } from '@/components/site/SectionHeading'
import { NotFoundError } from '@/lib/api'
import { otherLanguageWithPosts } from '@/lib/language-fallback'
import { metadataLocale } from '@/lib/locale-path'
import { feedTitle, pageMetadata } from '@/lib/metadata'
import { getSeries, getSeriesList } from '@/lib/series'
import { seriesFeedPath } from '@/lib/site'
import { normalizeSlug } from '@/lib/text'
import type { SeriesDetail, SeriesSummary } from '@/lib/types'
import type { Locale } from '@/i18n/config'
import { setPageLocale } from '@/i18n/page-locale'
import type { Translator } from '@/i18n/translator'
import { MEASURE_LEAD } from '@/components/site/reader/reader-layout'

/**
 * One series, its parts in reading order.
 *
 * No `generateStaticParams`, so the route renders per request and `next build` does not call
 * the API for it; the cache sits at the fetch layer (lib/series.ts, 300 seconds, tags `series` + `posts`). No
 * `loading.tsx`, pinned by a test: a streamed shell would turn the notFound() below into HTTP 200.
 */

/**
 * Makes THIS VERY FILE reject a handwritten signature `{ params: { slug: string } }`; see
 * categories/[slug]/page.tsx: the validator Next generates types these two exports as `{...} & any`, that is, it
 * accepts any signature. Both exports are checked; the route literal uses double quotes so that a
 * find-and-replace over the single-quoted comments below does not silently edit it away.
 */
type AcceptsGeneratedProps<T extends (props: PageProps<'/[locale]/series/[slug]'>) => unknown> = T
export type _SeriesPageAcceptsGeneratedProps = AcceptsGeneratedProps<typeof SeriesPage>
export type _SeriesMetadataAcceptsGeneratedProps = AcceptsGeneratedProps<typeof generateMetadata>

/** "More series" at the bottom of the page: enough to keep going, not a copy of /series. */
const OTHER_SERIES = 5

/** Path of a series, by the slug the backend stores: the canonical, the JSON-LD and every href share it. */
function seriesPath(slug: string): string {
  return `/series/${encodeURIComponent(slug)}`
}

/**
 * Title, description and canonical of the series page, built once for generateMetadata and for the
 * CollectionPage in the page body, like the other list pages: the JSON-LD `name` is exactly the
 * og:title, and `description` exactly the meta description.
 */
function seriesHead(series: SeriesDetail, t: Translator) {
  return {
    title: t('pageTitle', { title: series.title }),
    description: series.description ?? t('defaultDescription', { title: series.title }),
    // The slug the backend stores, not the slug in the URL: the two differ when the reader arrives with
    // a decomposed spelling, and the canonical must be exactly one spelling.
    canonical: seriesPath(series.slug),
  }
}

/**
 * Route params are NOT decoded by Next (searchParams are), and the same Vietnamese text arrives
 * precomposed or decomposed depending on the client; normalizeSlug handles both, like the post page.
 */
async function slugOf(params: Promise<{ slug: string }>): Promise<string> {
  const { slug } = await params
  return normalizeSlug(slug)
}

export async function generateMetadata(props: PageProps<'/[locale]/series/[slug]'>): Promise<Metadata> {
  const locale = await metadataLocale(props.params)
  const t = await getTranslations({ locale, namespace: 'Site.series' })
  // Wrapped again, unlike the page body: a throwing metadata is a 500 that cannot be rescued for a page whose body may
  // have rendered fine, whereas the page body returns its own 404/500. Same shape as the category page.
  try {
    const series = await getSeries(await slugOf(props.params), locale)
    return await pageMetadata({
      ...seriesHead(series, t),
      feed: { path: seriesFeedPath(series.slug), title: await feedTitle(locale, series.title) },
      locale,
    })
  } catch {
    return { title: t('notFoundTitle') }
  }
}

/**
 * The series list for "More series", or null when it cannot be read. A secondary block: an error only hides
 * the block, with one log line so that an API incident is not swallowed silently.
 */
async function seriesListOrNull(locale: Locale): Promise<SeriesSummary[] | null> {
  try {
    return await getSeriesList(locale)
  } catch (error) {
    console.warn(
      `[series] Could not read the series list (${error instanceof Error ? error.message : String(error)}). Hiding the other-series block.`,
    )
    return null
  }
}

/** Series detail is a child of the Series section: the Explore row is marked `aria-current="true"`. */
const SERIES_CURRENT: SidebarCurrent = { key: 'series', exact: false }

const META = 'text-sm text-neutral-600 dark:text-neutral-400'

/**
 * "Start at part 1": the underlined text link of before from `sm`; on a phone the one call to action of the page, a 44px filled button
 * (the shared phone button recipe of SectionHeading.tsx, the same as the hero of the home page).
 */
const START_LINK = `${INLINE_LINK} ${PHONE_BUTTON} ${PHONE_PRIMARY}`

export default async function SeriesPage(props: PageProps<'/[locale]/series/[slug]'>) {
  const locale = await setPageLocale(props.params)
  const t = await getTranslations({ locale, namespace: 'Site.series' })
  const breadcrumb = await getTranslations({ locale, namespace: 'Site.breadcrumb' })
  const slug = await slugOf(props.params)

  // In parallel: the series list does not depend on the detail. The list branch already catches its own errors, so
  // Promise.all can only reject with the error of getSeries.
  let series: SeriesDetail
  let all: SeriesSummary[] | null
  try {
    ;[series, all] = await Promise.all([getSeries(slug, locale), seriesListOrNull(locale)])
  } catch (error) {
    // 404 only when the backend SAYS there is no such series. Any other error is rethrown as a 500: if "could not
    // ask" returned 404, the 404 would be cached, and one backend hiccup would erase every series from the index.
    if (error instanceof NotFoundError) notFound()
    throw error
  }

  // The backend already returns 404 for a series with no published part. Checked again here because the
  // price of trusting it wrongly is an empty series page with HTTP 200, exactly the soft 404 that every other
  // archive page of the site has refused.
  if (series.posts.length === 0) {
    // The series exists in another language only: say so instead of a 404.
    const other = await otherLanguageWithPosts(locale, async (language) => (await getSeries(slug, language)).posts.length)
    if (!other) notFound()
    return (
      <BrowseFrame current={SERIES_CURRENT}>
        <header>
          <SeriesBreadcrumb />
          <h1 className="mt-3 text-3xl font-bold tracking-tight break-words sm:text-4xl">{series.title}</h1>
          <LanguageFallback path={seriesPath(series.slug)} language={other} />
        </header>
      </BrowseFrame>
    )
  }

  const head = seriesHead(series, t)
  const minutes = series.posts.reduce((sum, post) => sum + (readingMinutesOf(post) ?? 0), 0)
  const first = series.posts[0]!
  const others = (all ?? []).filter((other) => other.slug !== series.slug).slice(0, OTHER_SERIES)

  return (
    <>
      {/* The reading order is the main content of the page, so the ItemList follows exactly that order. */}
      <CollectionPageJsonLd
        locale={locale}
        name={head.title}
        description={head.description}
        url={head.canonical}
        items={series.posts.map((post) => ({ name: post.title, url: postPath(post.slug) }))}
      />
      {/* The steps come from exactly the function that builds the visible breadcrumb right below, then the series itself is added at the
          end, like the post page: a BreadcrumbList describes a path the page really shows. */}
      <BreadcrumbJsonLd
        locale={locale}
        items={[...seriesBreadcrumbTrail(breadcrumb), { name: series.title, url: head.canonical }]}
      />

      <BrowseFrame current={SERIES_CURRENT}>
        <header className="pb-6">
          <SeriesBreadcrumb />

          <h1 className="mt-3 text-3xl leading-[1.2] font-bold tracking-tight break-words sm:text-4xl sm:leading-10">
            {series.title}
          </h1>

          {series.description ? (
            <p
              className={`mt-3 ${MEASURE_LEAD} text-[1.0625rem] leading-relaxed text-neutral-600 sm:text-lg sm:leading-7 dark:text-neutral-400`}
            >
              {series.description}
            </p>
          ) : null}

          <SeriesMeta parts={series.posts.length} minutes={minutes} className="mt-3" />

          <p className="mt-4 text-sm font-medium">
            <Link href={postPath(first.slug)} className={START_LINK}>
              {t('startAtPart1')} <span aria-hidden="true">→</span>
            </Link>
          </p>
        </header>

        <div className="pb-10">
          {/* <ol>: the order is the meaning of the page. The h2 row right below the h1, like the list pages.
            The "Part i" kicker replaces the default series kicker: on the series page itself, the series name
            link on each row would only point back to the page being read. `i` is the position among the
            published parts, the meaning of `partNumber`, not the stored `position` (which may have gaps). */}
          <ol className="border-t border-neutral-200 dark:border-neutral-800">
            {series.posts.map((post, index) => (
              <li key={post.id} className="border-b border-neutral-200 py-5 last:border-0 sm:py-6 dark:border-neutral-800">
                <ListRow post={post} headingLevel={2} kicker={t('part', { number: index + 1 })} />
              </li>
            ))}
          </ol>
        </div>

        {others.length > 0 ? (
          <section aria-labelledby="cac-series-khac">
            <SectionHeading id="cac-series-khac" title={t('otherSeries')} />
            {/* On a phone the rows are separated by a hairline and the title link is a 44px row; from `sm` the plain list of before. */}
            <ul className="mt-4 divide-y divide-neutral-200 sm:mt-6 sm:space-y-4 sm:divide-y-0 dark:divide-neutral-800">
              {others.map((other) => (
                <li key={other.id} className="max-sm:py-2 max-sm:first:pt-0 max-sm:last:pb-0">
                  <Link href={seriesPath(other.slug)} className={`${TITLE_LINK} font-medium max-sm:inline-block max-sm:py-2.5`}>
                    {other.title}
                  </Link>
                  <p className={`mt-1 max-sm:-mt-1 ${META}`}>
                    {t('otherMeta', { parts: other.postCount, minutes: other.readingMinutes })}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </BrowseFrame>
    </>
  )
}
