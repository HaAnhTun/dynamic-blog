import type { Metadata } from 'next'
import { Link } from '@/i18n/navigation'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { Pagination } from '@/components/Pagination'
import { ShuffleIcon } from '@/components/icons'
import { postPath } from '@/components/site/ArticleJsonLd'
import { BrowseFrame } from '@/components/site/BrowseFrame'
import { Count, DiscoveryGrid } from '@/components/site/DiscoveryGrid'
import { CollectionPageJsonLd } from '@/components/site/JsonLd'
import { LanguageFallback } from '@/components/site/LanguageFallback'
import { PostList } from '@/components/site/PostList'
import { FOCUS, INLINE_LINK, TAP_TARGET, TRANSITION } from '@/components/site/SectionHeading'
import { getPosts } from '@/lib/api'
import { VIEW_THRESHOLDS, countCategories, getDiscovery } from '@/lib/discovery'
import { otherLanguageWithPosts } from '@/lib/language-fallback'
import { metadataLocale } from '@/lib/locale-path'
import { pageMetadata } from '@/lib/metadata'
import { fetchAllPublishedPosts } from '@/lib/published-posts'
import { getStats } from '@/lib/stats'
import { getCategories } from '@/lib/taxonomy'
import type { Category, PostSummary, SiteStats } from '@/lib/types'
import { getSiteContent } from '@/lib/site-content'
import { pageDescription } from '@/lib/site-pages'
import { setPageLocale } from '@/i18n/page-locale'
import type { Translator } from '@/i18n/translator'
import { MEASURE } from '@/components/site/reader/reader-layout'

/**
 * Inert on this route as it stands, and kept deliberately rather than deleted — the
 * same reasoning app/page.tsx carried when this list lived at `/`. Reading
 * `searchParams` makes the route fully dynamic (the build prints `ƒ /writing`, not
 * `○ /writing`), so there is no page-level ISR window for this to set; the 300 seconds
 * that do apply come from the per-fetch `next: { revalidate: 300 }` in lib/api.ts and
 * lib/taxonomy.ts. It stays so the declaration is already right if this route ever
 * stops reading searchParams.
 */
export const revalidate = 300

const PAGE_SIZE = 10

/**
 * The backend binds `page` to a 32-bit `int`, so a value above 2^31-1 is a 500 and a
 * value above 2^63 is a 400 — a reader-typable URL answered with a server error. Rather
 * than guess at the boundary, refuse anything past a page count no blog will reach. It
 * also means the absurd values never reach the API at all.
 */
const MAX_PAGE = 10_000

/**
 * Makes THIS FILE reject a hand-written `{ searchParams: … }`.
 *
 * `PageProps<'/[locale]/writing'>` on its own is a tripwire, not a guard: Next's generated
 * validator types a page's default export as `{ params: Promise<…> } & any`, and
 * `X & any` collapses to `any`, so the framework accepts any signature at all —
 * including `(p: string) => string`. When the homepage carried this list, swapping its
 * annotation for a synchronous `{ searchParams }` shape put every resulting error in
 * page.test.tsx and none in the page: the guard lived entirely in the test fixture's
 * return type, one "simplify the fixture" refactor away from vanishing, with lint,
 * typecheck, tests and build all green. Measured against a stub after that swap,
 * `?page=1`, `?page=2` and `?page=99` all served page one, `?page=99` stopped being a
 * 404, and the route was silently marked Static.
 *
 * Both exports are checked, not just the default one — the post page learned that the
 * hard way. The route literal is double-quoted on purpose: a search-and-replace over
 * the single-quoted annotations below cannot rewrite it, which is how a first attempt
 * at this guard silently disarmed itself.
 */
type AcceptsGeneratedProps<T extends (props: PageProps<'/[locale]/writing'>) => unknown> = T
export type _WritingAcceptsGeneratedProps = AcceptsGeneratedProps<typeof WritingIndex>
export type _WritingMetadataAcceptsGeneratedProps = AcceptsGeneratedProps<typeof generateMetadata>

/**
 * Shape-checked before parsing, not after.
 *
 * `Number.parseInt` is lenient in ways that all end up as a bad request: it reads
 * '1.5' as 1, '0x2' as 2 and '2abc' as 2, and on a long digit string it returns a
 * float, so '9999999999999999999999' becomes 1e22 and `String()` ships the API
 * `page=1e+22` as an integer parameter — which the API answered with a 500. A frontend
 * that sends garbage and lets the server sort it out breaks as soon as anything else
 * reads the same URL, so only a run of digits counts and everything else is page 0.
 *
 * `Array.isArray` first: `?page=2&page=5` arrives as `['2','5']`, and
 * `Number.parseInt(page ?? '', 10)` on that is TS2345, not a runtime surprise.
 *
 * Duplicated in app/categories/[slug]/page.tsx and app/tags/[slug]/page.tsx rather
 * than shared, because the only module all three could share is lib/*, which belongs
 * to another agent this run. Each copy is covered by its own test.
 */
function parsePage(page: string | string[] | undefined): number {
  const raw = Array.isArray(page) ? (page[0] ?? '') : (page ?? '')
  return /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : 0
}

/**
 * "12 posts · 2 series", plus "· N views" once the threshold is reached.
 *
 * The post count is the `meta.totalElements` of the list below, not the `publishedPosts` of
 * /stats: two numbers saying the same thing but taken from two responses can disagree at times (caches of different
 * age), and the reader would see "12 posts" over a pagination that counts 13. From /stats only take what the
 * list does not know. A part equal to zero is dropped, "0 series" says nothing; views only show from the
 * site-wide threshold (below it the number only makes the site look empty). `stats` is null when /stats fails: the line
 * falls back exactly to how it was before there were statistics.
 */
function statsLine(totalPosts: number, stats: SiteStats | null, t: Translator): string {
  const hasSeries = stats !== null && stats.seriesCount > 0
  const hasViews = stats !== null && stats.totalViews >= VIEW_THRESHOLDS.siteTotal
  const parts = hasSeries ? (hasViews ? 'postsSeriesViews' : 'postsSeries') : hasViews ? 'postsViews' : 'posts'
  return t('statsLine', { parts, posts: totalPosts, series: stats?.seriesCount ?? 0, views: stats?.totalViews ?? 0 })
}

/**
 * A row of the category filter strip: with a post count when counts are available (and then a category with no posts is dropped),
 * otherwise every category, without a number, like the filter strip before counts existed. It does not guess
 * which category is empty when there is no data to know.
 */
function categoryRows(categories: Category[], published: PostSummary[] | null): { category: Category; count: number | null }[] {
  if (!published) return categories.map((category) => ({ category, count: null }))
  return countCategories(published, categories)
}

/**
 * Title, description and canonical of a list page, built once for the two places that read them:
 * generateMetadata (title, meta description, canonical, og:*) and the CollectionPage in the page
 * body. The URL in the JSON-LD and the canonical of the page are ONE string going through one construction, not
 * two expressions that happen to match (see JsonLdLink in components/site/JsonLd.tsx).
 */
function writingHead(page: number, title: string, description: string) {
  return {
    title,
    description,
    // The same string becomes `og:url`, which is the half this route was getting wrong:
    // with no `openGraph` block of its own it inherited the homepage's, so every
    // paginated view advertised `og:url = http://localhost:3000` and `og:title =
    // "<owner name>"` while its own canonical said otherwise.
    canonical: page > 0 ? `/writing?page=${page}` : '/writing',
  }
}

/**
 * `alternates.canonical` is not optional here, and not cosmetic.
 *
 * app/layout.tsx sets `alternates: { canonical: '/' }`, and Next INHERITS that into
 * every page that does not override it — verified live on /posts/[slug], which emits
 * `<link rel="canonical" href="http://localhost:3000"/>`. Without this block the
 * writing index would declare itself a duplicate of the homepage and be dropped from
 * the index.
 *
 * The page number is carried into the canonical rather than collapsed to `/writing`.
 * Pointing `?page=3` at `/writing` is the "canonicalise pagination to page one"
 * mistake: it asks the crawler to drop pages 2..N, and the posts that only appear on
 * those pages go with them. Each paginated view is its own canonical URL.
 */
export async function generateMetadata(props: PageProps<'/[locale]/writing'>): Promise<Metadata> {
  const locale = await metadataLocale(props.params)
  const t = await getTranslations({ locale, namespace: 'Site.writing' })
  const descriptions = await getTranslations({ locale, namespace: 'Site.pageDescriptions' })
  const { site, profile } = await getSiteContent(locale)
  const { page } = await props.searchParams
  const current = parsePage(page)

  return pageMetadata({
    ...writingHead(
      current,
      t('title'),
      pageDescription('/writing', descriptions, { siteName: site.name, galleryLead: profile.galleryLead }),
    ),
    locale,
  })
}

export default async function WritingIndex(props: PageProps<'/[locale]/writing'>) {
  const locale = await setPageLocale(props.params)
  const t = await getTranslations({ locale, namespace: 'Site.writing' })
  const descriptions = await getTranslations({ locale, namespace: 'Site.pageDescriptions' })
  const { site, profile } = await getSiteContent(locale)
  // searchParams is a Promise in Next 16. Destructuring it synchronously compiles,
  // builds, and renders an empty value — PageProps is what makes that a type error.
  const { page } = await props.searchParams
  const current = parsePage(page)

  // Before any API call: `current` can still be enormous, and the point is that such a
  // page does not exist, which is knowable without asking anyone.
  if (current > MAX_PAGE) notFound()

  // Parallel, because none of these depends on another. The taxonomy call is NOT
  // wrapped in a catch: a categories outage that silently rendered an index with no
  // filter strip is the kind of green-but-broken this project keeps paying for. A
  // throw reaches app/error.tsx and says 500, which is true.
  //
  // The remaining three sources are secondary and each catches its own errors: stats, the Discovery block and
  // all posts for counting categories. One failing only loses its own part: the stats line keeps the post
  // count, the filter strip keeps categories without numbers, Discovery disappears, and the post list is still complete.
  // getDiscovery catches the errors of each source itself and does not throw; `.catch` here is for itself, so that a
  // programming error inside it does not become a 500 page. fetchAllPublishedPosts has the same URL as the call
  // inside getDiscovery, so Next merges them into one request.
  const [{ items, meta }, categories, stats, discovery, published] = await Promise.all([
    getPosts({ page: current, size: PAGE_SIZE, language: locale }),
    getCategories(locale),
    getStats().catch(() => null),
    getDiscovery({ context: 'writing', language: locale }).catch(() => null),
    fetchAllPublishedPosts(locale).catch(() => null),
  ])

  // Decided here, not in Pagination. The backend echoes the requested page back —
  // PageRequest.of(Math.max(page, 0), …) — so ?page=99 against six pages answers with
  // an empty list and meta.page = 99. Pagination clamps its own display, so without
  // this the reader gets a blank page under a pager that reads "Trang 6 / 6": a URL
  // that does not exist, answered 200 with a lie on it.
  //
  // `current > 0` rather than `meta.totalPages > 0`: page 0 always exists, including on
  // a blog that has published nothing, where totalPages is 0 and "No posts yet." is the right answer,
  // while ?page=1 on that same blog is still a page that is
  // not there. A ?page that is not a run of digits is already 0 by the shape check, so
  // ?page=abc renders the first page rather than 404ing.
  if (current > 0 && current >= meta.totalPages) notFound()

  const fallbackLanguage =
    meta.totalElements === 0
      ? await otherLanguageWithPosts(
          locale,
          async (language) => (await getPosts({ page: 0, size: 1, language })).meta.totalElements,
        )
      : null
  // The series count follows the language of the page (the site-wide figure of /stats would count the other language too).
  const shownStats = stats && { ...stats, seriesCount: discovery?.seriesTotal ?? 0 }
  const rows = categoryRows(categories, published)
  const head = writingHead(
    current,
    t('title'),
    pageDescription('/writing', descriptions, { siteName: site.name, galleryLead: profile.galleryLead }),
  )

  return (
    <>
      {/* The post list of exactly this page, in the order shown, numbered continuing after the previous
          pages. The Discovery block at the end of the page is not part of it: it is a way onward, not something this page
          lists. No BreadcrumbList: the page has no visible breadcrumb for it to describe. Empty
          (blog with no posts) means the component renders nothing. */}
      <CollectionPageJsonLd
        locale={locale}
        name={head.title}
        description={head.description}
        url={head.canonical}
        offset={current * PAGE_SIZE}
        items={items.map((post) => ({ name: post.title, url: postPath(post.slug) }))}
      />

      {/* No <main> here. app/layout.tsx owns the document's single
          `<main id="main-content">`; a second one makes the skip link ambiguous. */}
      <BrowseFrame current={{ key: 'latest', exact: true }}>
        <header className="pb-6">
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{head.title}</h1>
          <p className={`mt-3 ${MEASURE} text-neutral-600 dark:text-neutral-400`}>{head.description}</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-neutral-600 dark:text-neutral-400">
            <p>{statsLine(meta.totalElements, shownStats, t)}</p>
            {/* `<a>`, not `<Link>`: /random is a route handler that returns a 307 to a different post each time;
              the client-side router would prefetch and pin one target. See Footer.tsx. */}
            <a href="/random" rel="nofollow" className={`inline-flex items-center gap-1.5 max-sm:min-h-11 ${INLINE_LINK}`}>
              <ShuffleIcon size={14} />
              {t('random')}
            </a>
          </div>
        </header>

        {/*
        The filter strip. `aria-labelledby` on the group rather than `aria-label`, so
        the visible heading and the accessible name are the same string and cannot
        drift apart. Two <nav>s inside the page is fine — they are named, so a screen
        reader's landmark list distinguishes them from the header's nav.

        Only categories remain, with post counts. The tag strip left here, down to the Discovery block
        and the /topics page: with 16 tags it pushes the first post more than halfway down a phone screen,
        and with 150 tags it becomes a wall.

        The strip sits directly in the main column (a plain section, no Container), so its rules are exactly as long as the
        post rows right below.
      */}
        {rows.length > 0 && (
          <section>
            <div className="border-y border-neutral-200 py-5 dark:border-neutral-800">
              <h2 className="sr-only">{t('filterHeading')}</h2>

              <nav aria-labelledby="writing-filter-categories">
                <h3
                  id="writing-filter-categories"
                  className="text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400"
                >
                  {t('categories')}
                </h3>
                <ul className="mt-2 flex gap-2 text-sm max-sm:-mx-4 max-sm:scroll-px-4 max-sm:snap-x max-sm:overflow-x-auto max-sm:px-4 max-sm:py-1 max-sm:[scrollbar-width:none] sm:flex-wrap sm:gap-x-4 sm:gap-y-2">
                  {rows.map(({ category, count }) => (
                    <li key={category.id} className="max-sm:shrink-0 max-sm:snap-start">
                      <Link
                        href={`/categories/${encodeURIComponent(category.slug)}`}
                        // Text 17px tall in the strip: TAP_TARGET widens the touch target without making the strip taller. Below sm
                        // each category is a 36px pill (4px of hit area above and below make it 44px): a plain word was a 17px target.
                        className={`${FOCUS} ${TRANSITION} ${TAP_TARGET} hover:text-brand hover:underline max-sm:inline-flex max-sm:min-h-9 max-sm:items-center max-sm:gap-1.5 max-sm:rounded-full max-sm:border max-sm:border-neutral-200 max-sm:px-3 max-sm:after:-inset-y-[5px] dark:max-sm:border-neutral-800`}
                      >
                        {category.name}
                        {count === null ? null : (
                          <>
                            {' '}
                            <Count value={count} />
                          </>
                        )}
                      </Link>
                    </li>
                  ))}
                </ul>
              </nav>
            </div>
          </section>
        )}

        {/*
        No heading on this section, deliberately. An sr-only "All posts" here
        would make every post title its SIBLING rather than its child — PostList's rows
        are h2, so the outline would read h1, h2(label), h2(post), h2(post)… and a
        screen-reader user navigating by heading would hear a label that owns nothing.
        Demoting the rows to h3 instead would break PostList on any page that uses it
        without a section heading. The section's own name is carried by the h1 above.
      */}
        <section>
          <PostList
            posts={items}
            emptyFallback={fallbackLanguage ? <LanguageFallback path="/writing" language={fallbackLanguage} /> : undefined}
          />
          <Pagination meta={meta} basePath="/writing" />
        </section>
      </BrowseFrame>

      {/* End of the page, after the pagination: the reader reaching here has seen the whole list page. It returns
          null by itself when every block is empty; null here is when getDiscovery itself fails. */}
      {discovery ? (
        <div className="border-t border-neutral-200 empty:hidden dark:border-neutral-800 print:hidden">
          <DiscoveryGrid id="kham-pha" title={t('discoverTitle')} data={discovery} variant="writing" width="reader" />
        </div>
      ) : null}
    </>
  )
}
