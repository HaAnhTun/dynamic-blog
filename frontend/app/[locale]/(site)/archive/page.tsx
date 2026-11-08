import type { Metadata } from 'next'
import { Link } from '@/i18n/navigation'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { postPath } from '@/components/site/ArticleJsonLd'
import { BrowseFrame } from '@/components/site/BrowseFrame'
import { Count } from '@/components/site/DiscoveryGrid'
import { CollectionPageJsonLd } from '@/components/site/JsonLd'
import { LanguageFallback } from '@/components/site/LanguageFallback'
import { readingMinutesOf } from '@/components/site/ReadingMeta'
import { FOCUS, TITLE_LINK, TRANSITION } from '@/components/site/SectionHeading'
import { formatDayMonth, formatMonth } from '@/lib/date'
import { bucketByMonth, type MonthBucket } from '@/lib/discovery'
import { otherLanguageWithPosts } from '@/lib/language-fallback'
import { metadataLocale } from '@/lib/locale-path'
import { pageMetadata } from '@/lib/metadata'
import { fetchAllPublishedPosts } from '@/lib/published-posts'
import { getSiteContent } from '@/lib/site-content'
import { pageDescription } from '@/lib/site-pages'
import type { Translator } from '@/i18n/translator'
import { setPageLocale } from '@/i18n/page-locale'
import { MEASURE } from '@/components/site/reader/reader-layout'

/*
 * No `dynamic` or `revalidate`: the page reads `searchParams`, so it is already rendered per request
 * (build shows `ƒ /archive`), and the 300-second cache sits on the fetch in lib/api.ts. See
 * app/(site)/writing/page.tsx.
 */

/**
 * Makes THIS FILE reject a hand-written `{ searchParams: … }`. Next's generated validator types
 * these exports as `{ … } & any`, which accepts any signature at all — including a synchronous
 * destructure that compiles, builds and renders the default year for every `?year`. Both exports
 * are checked; the route literal is double-quoted so a search-and-replace over the single-quoted
 * annotations below cannot rewrite it. See app/(site)/writing/page.tsx for the measured history.
 */
type AcceptsGeneratedProps<T extends (props: PageProps<'/[locale]/archive'>) => unknown> = T
export type _ArchiveAcceptsGeneratedProps = AcceptsGeneratedProps<typeof ArchivePage>
export type _ArchiveMetadataAcceptsGeneratedProps = AcceptsGeneratedProps<typeof generateMetadata>

type YearGroup = { year: number; count: number; months: MonthBucket[] }

/**
 * `?year`, shape checked before reading, for the same reason as `parsePage` on /writing: `parseInt` reads
 * '2026abc' as 2026 and '20.26' as 20. A year on this blog is always four digits.
 *
 * `undefined`: no `?year`, the page of the newest year. `null`: present but not a year,
 * so 404, decidable without asking the API. An empty `?year=` is also null: a parameter that is present but
 * names no year is not the default page, and letting it render would create one more URL with duplicate content.
 */
function parseYear(year: string | string[] | undefined): number | null | undefined {
  if (year === undefined) return undefined
  const raw = Array.isArray(year) ? (year[0] ?? '') : year
  return /^\d{4}$/.test(raw) ? Number.parseInt(raw, 10) : null
}

/** Months (grouped by UTC, newest first) arranged by year, newest year first. */
function groupByYear(months: MonthBucket[]): YearGroup[] {
  const years: YearGroup[] = []
  for (const bucket of months) {
    const last = years.at(-1)
    if (last && last.year === bucket.year) {
      last.months.push(bucket)
      last.count += bucket.count
    } else {
      years.push({ year: bucket.year, count: bucket.count, months: [bucket] })
    }
  }
  return years
}

/**
 * The newest year is the default page: its URL is `/archive`, with no `?year`. It is also
 * the canonical of that year page (archiveHead), so the year chip points at exactly the URL the target page declares for itself.
 * `newest` undefined (the newest year is unknown): every year keeps its own `?year`.
 */
function yearHref(year: number, newest: number | undefined): string {
  return year === newest ? '/archive' : `/archive?year=${year}`
}

/**
 * Title, description and canonical of a one-year page, built once for the two places that read them: generateMetadata
 * and the CollectionPage in the page body. `year` undefined is the page without `?year`.
 */
function archiveHead(year: number | undefined, newest: number | undefined, t: Translator, lead: string) {
  const isDefault = year === undefined || year === newest
  return {
    title: isDefault ? t('title') : t('yearTitle', { year: String(year) }),
    description: isDefault ? lead : t('yearDescription', { year: String(year) }),
    canonical: year === undefined ? '/archive' : yearHref(year, newest),
  }
}

/** Id of a month section. Does not start with a digit, so that `#thang-2026-10` is a valid selector. */
function monthId({ year, month }: MonthBucket): string {
  return `thang-${year}-${String(month).padStart(2, '0')}`
}

/**
 * Wrapped, unlike the page body: a metadata throw is an unrecoverable 500 for a page whose body
 * might have rendered fine, and the body does its own 404. Same shape as the category archive.
 *
 * The canonical is `/archive` for the newest year (even when the URL explicitly says `?year=2026`) and
 * `/archive?year=YYYY` for any other year. If the posts cannot be read, the newest year is unknown,
 * so `?year` keeps its own canonical.
 */
export async function generateMetadata(props: PageProps<'/[locale]/archive'>): Promise<Metadata> {
  const locale = await metadataLocale(props.params)
  const t = await getTranslations({ locale, namespace: 'Site.archive' })
  const descriptions = await getTranslations({ locale, namespace: 'Site.pageDescriptions' })
  const { site, profile } = await getSiteContent(locale)
  const { year } = await props.searchParams
  const wanted = parseYear(year)
  if (wanted === null) return { title: t('notFoundTitle') }

  const newest =
    wanted === undefined
      ? undefined
      : await fetchAllPublishedPosts(locale)
          .then((posts) => bucketByMonth(posts)[0]?.year)
          .catch(() => undefined)

  return pageMetadata({
    ...archiveHead(
      wanted,
      newest,
      t,
      pageDescription('/archive', descriptions, { siteName: site.name, galleryLead: profile.galleryLead }),
    ),
    locale,
  })
}

/**
 * Archive by year: one year per page, one section per month. One year per page keeps
 * the page on a phone at a few dozen rows even if the blog has 500 posts; a page per month would be too thin.
 *
 * Grouped by UTC month (lib/discovery.ts), matching the date printed on each post (lib/date.ts).
 *
 * The full post list is the primary content and does NOT catch errors: swallowing a failure into [] would turn every `?year` into a
 * 404 while the API is down, and 404s get cached. Throwing gives a 500, which is the truth.
 */
export default async function ArchivePage(props: PageProps<'/[locale]/archive'>) {
  const locale = await setPageLocale(props.params)
  const t = await getTranslations({ locale, namespace: 'Site.archive' })
  const descriptions = await getTranslations({ locale, namespace: 'Site.pageDescriptions' })
  const { site, profile } = await getSiteContent(locale)
  const lead = pageDescription('/archive', descriptions, { siteName: site.name, galleryLead: profile.galleryLead })
  const { year } = await props.searchParams
  const wanted = parseYear(year)
  // Before any API call: a year that is not a year does not exist, no need to ask anyone.
  if (wanted === null) notFound()

  const years = groupByYear(bucketByMonth(await fetchAllPublishedPosts(locale)))
  const newest = years[0]?.year
  const selected = wanted === undefined ? years[0] : years.find((group) => group.year === wanted)

  // A year with no posts is a page that does not exist, even on a blog with no posts at all. Only
  // `/archive` with no parameter is the always-present page (notice below).
  if (wanted !== undefined && !selected) notFound()

  const fallbackLanguage = selected
    ? null
    : await otherLanguageWithPosts(locale, async (language) => (await fetchAllPublishedPosts(language)).length)
  const head = archiveHead(selected?.year, newest, t, lead)

  return (
    <>
      {/* The posts of the year being viewed, in exactly the page order: newest month first, newest post first within a
          month. Position counts from 1 for each year: each year is a page with its own canonical, not the
          nth page of a paginated list. No BreadcrumbList: the page has no visible
          breadcrumb. A blog with no posts renders nothing from the component. */}
      <CollectionPageJsonLd
        locale={locale}
        name={head.title}
        description={head.description}
        url={head.canonical}
        items={(selected?.months ?? []).flatMap((bucket) =>
          bucket.posts.map((post) => ({ name: post.title, url: postPath(post.slug) })),
        )}
      />

      {/* No <main> here. app/layout.tsx owns the document's single `<main id="main-content">`. */}
      <BrowseFrame current={{ key: 'archive', exact: true }}>
        <header className="pb-6">
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{t('title')}</h1>
          <p className={`mt-3 ${MEASURE} text-neutral-600 dark:text-neutral-400`}>{lead}</p>
          {selected ? (
            <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
              {t('yearSummary', { count: selected.count, year: String(selected.year) })}
            </p>
          ) : null}

          {/* Only when there are two or more years: a single chip is a picker with nothing to pick. */}
          {years.length >= 2 && selected && newest !== undefined ? (
            <nav aria-label={t('byYear')} className="mt-6">
              <ul className="flex flex-wrap gap-2 text-sm">
                {years.map((group) => {
                  const isCurrent = group.year === selected.year
                  return (
                    <li key={group.year}>
                      <Link
                        href={yearHref(group.year, newest)}
                        aria-current={isCurrent ? 'page' : undefined}
                        // Current item: brand text, no solid pill background.
                        className={`relative inline-flex min-h-9 items-center gap-1.5 rounded-full bg-neutral-100 px-3 tabular-nums after:absolute after:inset-x-0 after:-inset-y-1 hover:text-brand sm:min-h-0 sm:py-1 sm:after:hidden dark:bg-neutral-800 ${FOCUS} ${TRANSITION} ${
                          isCurrent ? 'font-medium text-brand' : 'text-neutral-700 dark:text-neutral-300'
                        }`}
                      >
                        {group.year} <Count value={group.count} />
                      </Link>
                    </li>
                  )
                })}
              </ul>
            </nav>
          ) : null}

          {/* Month jump row, only when the year has two or more months: with one month, that section is right below. */}
          {selected && selected.months.length >= 2 ? (
            <nav aria-label={t('byMonth')} className="mt-3 sm:mt-4">
              <ul className="flex flex-wrap gap-x-4 gap-y-0 text-sm sm:gap-y-1">
                {selected.months.map((bucket) => (
                  <li key={monthId(bucket)}>
                    <a
                      href={`#${monthId(bucket)}`}
                      className={`text-neutral-600 hover:text-brand hover:underline hover:underline-offset-4 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center dark:text-neutral-400 ${FOCUS} ${TRANSITION}`}
                    >
                      {t('monthLink', { month: bucket.month })}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}
        </header>

        {/* The months: two columns from xl only when the year has 4 or more of them (two columns of 1 to 3 months would leave one half
          empty); below that one column, capped at a readable width. Spacing by gap, never margins, so a grid item never
          carries its own offset. DOM order is data order (newest month first), so reading and focus order are the same. */}
        <div
          className={
            selected && selected.months.length >= 4
              ? 'grid items-start gap-x-12 gap-y-10 xl:grid-cols-2'
              : 'grid max-w-3xl gap-y-10'
          }
        >
          {selected ? (
            selected.months.map((bucket) => {
              const id = monthId(bucket)
              return (
                <section key={id} aria-labelledby={id} className="min-w-0">
                  {/* Heading row like SectionHeading, handwritten because the h2 needs `first-letter:uppercase`:
                    formatMonth returns lowercase so that it can sit mid-sentence. */}
                  <div className="flex items-baseline justify-between gap-4 border-t border-neutral-200 pt-6 dark:border-neutral-800">
                    <h2 id={id} className="text-xl font-semibold tracking-tight first-letter:uppercase">
                      {formatMonth(bucket.year, bucket.month, locale)}
                    </h2>
                    <p className="shrink-0 text-sm tabular-nums text-neutral-500 dark:text-neutral-400">
                      {t('monthPosts', { count: bucket.count })}
                    </p>
                  </div>
                  <ol className="mt-2 divide-y divide-neutral-200 sm:mt-4 sm:space-y-2 sm:divide-y-0 dark:divide-neutral-800">
                    {bucket.posts.map((post) => {
                      const minutes = readingMinutesOf(post)
                      return (
                        <li
                          key={post.id}
                          className="grid grid-cols-[3rem_minmax(0,1fr)] items-baseline gap-x-3 sm:grid-cols-[3rem_minmax(0,1fr)_auto]"
                        >
                          {/* Every post in the bucket has a readable date: bucketByMonth drops posts
                            without one. The heading already says month and year, so the row only needs the day. */}
                          <time
                            dateTime={post.publishedAt ?? undefined}
                            className="text-sm tabular-nums text-neutral-500 dark:text-neutral-400"
                          >
                            {formatDayMonth(post.publishedAt)}
                          </time>
                          {/* postPath, like the ItemList above: the href and the URL in the JSON-LD are one construction. */}
                          <Link href={postPath(post.slug)} className={`break-words max-sm:py-2.5 ${TITLE_LINK}`}>
                            {post.title}
                          </Link>
                          {minutes !== null ? (
                            <span className="hidden text-sm tabular-nums text-neutral-500 sm:block dark:text-neutral-400">
                              {t('minutes', { minutes })}
                            </span>
                          ) : null}
                        </li>
                      )
                    })}
                  </ol>
                </section>
              )
            })
          ) : fallbackLanguage ? (
            <LanguageFallback path="/archive" language={fallbackLanguage} />
          ) : (
            <p className="py-6 text-neutral-600 dark:text-neutral-400">{t('empty')}</p>
          )}
        </div>
      </BrowseFrame>
    </>
  )
}
