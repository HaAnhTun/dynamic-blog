import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import type { ReactNode } from 'react'
import { FolderIcon } from '@/components/icons'
import { postPath } from '@/components/site/ArticleJsonLd'
import { BrowseFrame } from '@/components/site/BrowseFrame'
import { CollectionPageJsonLd } from '@/components/site/JsonLd'
import { LanguageFallback } from '@/components/site/LanguageFallback'
import { ListRow, SeriesKicker } from '@/components/site/ListRow'
import { META_ICON } from '@/components/site/ReadingMeta'
import { INLINE_LINK, SectionHeading } from '@/components/site/SectionHeading'
import { SeriesEntry } from '@/components/site/SeriesEntry'
import type { Locale } from '@/i18n/config'
import { getPosts } from '@/lib/api'
import { otherLanguageWithPosts } from '@/lib/language-fallback'
import { countCategories, type CategoryCount } from '@/lib/discovery'
import { pageMetadata } from '@/lib/metadata'
import { fetchAllPublishedPosts } from '@/lib/published-posts'
import { getSeriesList } from '@/lib/series'
import { getCategories } from '@/lib/taxonomy'
import type { PostSummary, SeriesSummary } from '@/lib/types'
import { getSiteContent } from '@/lib/site-content'
import { pageDescription } from '@/lib/site-pages'
import { setPageLocale } from '@/i18n/page-locale'
import { MEASURE_LEAD, MEASURE_SMALL } from '@/components/site/reader/reader-layout'

/**
 * Rendered per request, not prerendered at build time: the Docker build has no API,
 * and a prerender would bake in an empty page, for the same reason as the home page. The cache sits at the
 * fetch layer (300 seconds). NO `revalidate` alongside: `force-dynamic` sets it to 0 at build time, so a
 * `revalidate = 300` next to it is a promise nobody keeps.
 */
export const dynamic = 'force-dynamic'

const CANONICAL = '/start-here'

export async function generateMetadata(props: PageProps<'/[locale]/start-here'>): Promise<Metadata> {
  const locale = await setPageLocale(props.params)
  const t = await getTranslations({ locale, namespace: 'Site.startHere' })
  const descriptions = await getTranslations({ locale, namespace: 'Site.pageDescriptions' })
  const { site, profile } = await getSiteContent(locale)
  return pageMetadata({
    title: t('title'),
    description: pageDescription('/start-here', descriptions, { siteName: site.name, galleryLead: profile.galleryLead }),
    canonical: CANONICAL,
    locale,
  })
}

/**
 * The whole curated list in one request: the backend accepts at most 50 ranked posts
 * (`PUT /admin/posts/featured-order`), so 50 is the complete list.
 */
const CURATED_LIMIT = 50

/**
 * Secondary blocks: on failure null, the block is hidden, the page still renders. One log line per failing block,
 * so that a vanishing block does not mean an API incident nobody sees.
 */
async function optional<T>(what: string, load: () => Promise<T>): Promise<T | null> {
  try {
    return await load()
  } catch (error) {
    console.warn(
      `[start-here] Could not read ${what} (${error instanceof Error ? error.message : String(error)}). Hiding this block.`,
    )
    return null
  }
}

/** Post count per category, counted from the published posts, same source and same rule as /topics. */
async function categoryCounts(locale: Locale): Promise<CategoryCount[]> {
  const [posts, categories] = await Promise.all([fetchAllPublishedPosts(locale), getCategories(locale)])
  return countCategories(posts, categories)
}

/**
 * Kicker of a curated post: the dimmed ordinal number `01`, then the series kicker if the post belongs to a series.
 *
 * The number is `aria-hidden`: the `<ol>` already carries the order for screen readers, and reading an extra "zero one" before
 * every title is only noise. The number follows POSITION in the list, not `featuredRank`:
 * unselecting a post leaves a gap in the rank, while the reader needs 01, 02, 03 contiguous.
 *
 * `text-neutral-500`, no lighter: the text is still text to the eyes, and 500 is the lightest gray that still
 * passes 4.5:1 contrast on a white background.
 */
function rankKicker(rank: number, post: PostSummary): ReactNode {
  return (
    <>
      <span aria-hidden="true" className="shrink-0 tabular-nums text-neutral-500 dark:text-neutral-400">
        {String(rank).padStart(2, '0')}
      </span>
      {post.series ? <SeriesKicker series={post.series} /> : null}
    </>
  )
}

const META = 'text-sm text-neutral-600 dark:text-neutral-400'

/** One rhythm per section: SectionHeading draws its own hairline above the heading. */
const SECTION = 'pb-10'

export default async function StartHere(props: PageProps<'/[locale]/start-here'>) {
  const locale = await setPageLocale(props.params)
  const t = await getTranslations({ locale, namespace: 'Site.startHere' })
  // The curated list is the main content and does NOT catch errors: "No posts have been picked yet." while the
  // API is down is a green page that is wrong; throw so that app/error.tsx says 500, like /writing. The two secondary
  // blocks already catch their own errors, so Promise.all can only reject with the error of the curated list.
  const [curated, series, categories] = await Promise.all([
    getPosts({ page: 0, size: CURATED_LIMIT, featured: true, language: locale }),
    optional('the series list', () => getSeriesList(locale)),
    optional('the post counts per category', () => categoryCounts(locale)),
  ])

  // Backend order: `featured_rank ASC NULLS LAST, published_at DESC`. The page keeps it,
  // does not re-sort: the order is an editorial choice of the site owner, not of the page.
  const posts = curated.items
  const fallbackLanguage =
    posts.length === 0
      ? await otherLanguageWithPosts(
          locale,
          async (language) => (await getPosts({ page: 0, size: 1, featured: true, language })).meta.totalElements,
        )
      : null
  const seriesList: SeriesSummary[] = series ?? []
  const categoryList: CategoryCount[] = categories ?? []

  return (
    <>
      {/* A list ordered by a person's choice: exactly the case ItemList is for. When empty the
          component renders nothing. */}
      <CollectionPageJsonLd
        name={t('title')}
        url={CANONICAL}
        items={posts.map((post) => ({ name: post.title, url: postPath(post.slug) }))}
      />

      <BrowseFrame current={{ key: 'best', exact: true }}>
        <header className="pb-6 sm:pb-8">
          <p className="text-xs font-semibold tracking-wide text-neutral-600 uppercase dark:text-neutral-400">{t('eyebrow')}</p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight sm:text-4xl">{t('title')}</h1>
          <p className={`mt-3 ${MEASURE_LEAD} text-lg text-neutral-600 dark:text-neutral-400`}>{t('lead')}</p>
        </header>

        <section aria-labelledby="nen-doc-truoc" className={SECTION}>
          <SectionHeading id="nen-doc-truoc" title={t('readFirst')} />
          {posts.length === 0 ? (
            <div className="mt-6 text-neutral-600 dark:text-neutral-400">
              {fallbackLanguage ? <LanguageFallback path={CANONICAL} language={fallbackLanguage} /> : <p>{t('empty')}</p>}
              <p className="mt-2 text-sm font-medium">
                <Link href="/writing" className={INLINE_LINK}>
                  {t('allPosts')} <span aria-hidden="true">→</span>
                </Link>
              </p>
            </div>
          ) : (
            <ol className="mt-6">
              {posts.map((post, index) => (
                <li
                  key={post.id}
                  className="border-b border-neutral-200 py-5 first:pt-0 last:border-0 last:pb-0 sm:py-6 dark:border-neutral-800"
                >
                  {/* h3: right below the section h2. */}
                  <ListRow post={post} headingLevel={3} kicker={rankKicker(index + 1, post)} />
                </li>
              ))}
            </ol>
          )}
        </section>

        {seriesList.length > 0 ? (
          <section aria-labelledby="doc-theo-series" className={SECTION}>
            <SectionHeading id="doc-theo-series" title={t('bySeries')} />
            {/* A row of /series (text left, cover art right), like the "Read these first" list right above:
              the whole page has one rhythm, filling the wide frame. Every part, in reading order: this page is a signpost
              for newcomers, and a series read half way is exactly what it exists to avoid. */}
            <ul className="mt-6">
              {seriesList.map((item) => (
                <li
                  key={item.id}
                  className="border-b border-neutral-200 py-5 first:pt-0 last:border-0 last:pb-0 sm:py-6 dark:border-neutral-800"
                >
                  <SeriesEntry series={item} headingLevel={3} partsShown={Number.POSITIVE_INFINITY} phonePartsShown={3} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {categoryList.length > 0 ? (
          <section aria-labelledby="theo-chuyen-muc" className={SECTION}>
            <SectionHeading id="theo-chuyen-muc" title={t('byCategory')} />
            {/* A grid, not one column: category names are short, and one column leaves most of the frame width empty. */}
            <ul className="mt-4 grid gap-x-12 gap-y-2 sm:mt-6 sm:grid-cols-2 sm:gap-y-4 lg:grid-cols-3">
              {categoryList.map(({ category, count }) => (
                <li key={category.id}>
                  {/* The number sits inside the link: the accessible name is "Architecture 7 posts", the eyes see "Architecture 7".
                    The icon is aria-hidden so it does not enter the name. */}
                  {/* INLINE_LINK (underlined), like the series part links right above on the same page:
                    with two kinds of link on a page and only one underlined, the other reads as
                    plain text. */}
                  <Link
                    href={`/categories/${encodeURIComponent(category.slug)}`}
                    className={`inline-flex items-center gap-1.5 font-medium max-sm:min-h-11 ${INLINE_LINK}`}
                  >
                    <FolderIcon size={16} className={META_ICON} />
                    {category.name}{' '}
                    <span className="font-normal tabular-nums text-neutral-600 dark:text-neutral-400">
                      {/* The space is OUTSIDE the sr-only span: the accessible name computation (dom-accessibility-api,
                        measured in the test) trims the leading whitespace of the span and yields "2posts". */}
                      {count} <span className="sr-only">{t('postsUnit', { count })}</span>
                    </span>
                  </Link>
                  {category.description ? <p className={`mt-1 ${MEASURE_SMALL} ${META}`}>{category.description}</p> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* The closing sentence only when there is a list: it talks about how the list was chosen. */}
        {posts.length > 0 ? (
          <div>
            <p className={`border-t border-neutral-200 pt-6 ${META} dark:border-neutral-800`}>{t('closing')}</p>
          </div>
        ) : null}
      </BrowseFrame>
    </>
  )
}
