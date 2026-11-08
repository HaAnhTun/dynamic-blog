import type { Metadata } from 'next'
import { Link } from '@/i18n/navigation'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { Pagination } from '@/components/Pagination'
import { postPath } from '@/components/site/ArticleJsonLd'
import { BrowseFrame } from '@/components/site/BrowseFrame'
import { CollectionPageJsonLd } from '@/components/site/JsonLd'
import { LanguageFallback } from '@/components/site/LanguageFallback'
import { PostList } from '@/components/site/PostList'
import { NotFoundError, getPosts } from '@/lib/api'
import type { Locale } from '@/i18n/config'
import { otherLanguageWithPosts } from '@/lib/language-fallback'
import { metadataLocale } from '@/lib/locale-path'
import { feedTitle, pageMetadata } from '@/lib/metadata'
import { categoryFeedPath } from '@/lib/site'
import { getCategory } from '@/lib/taxonomy'
import { normalizeSlug } from '@/lib/text'
import type { Category } from '@/lib/types'
import { setPageLocale } from '@/i18n/page-locale'
import type { Translator } from '@/i18n/translator'
import { MEASURE } from '@/components/site/reader/reader-layout'

export const revalidate = 300

const PAGE_SIZE = 10

/** See app/writing/page.tsx — the backend binds `page` to a 32-bit int, so an absurd
 *  value is a 500 or a 400 from a reader-typable URL. Refused before any API call. */
const MAX_PAGE = 10_000

/**
 * Makes THIS FILE reject a hand-written `{ params: { slug: string } }`.
 *
 * Next's generated validator types these exports as `{ params: Promise<…> } & any`, and
 * `X & any` is `any` — so the framework accepts any signature at all, including a
 * synchronous `{ params }` destructure that compiles, builds, renders empty and marks
 * the route static. Both exports are checked. The archive pages exist because the
 * project's own recorded mistake was fixing the post page's signature guard and not the
 * homepage's: a guard on one page and not its neighbour is no guard. The route literal
 * is double-quoted so a search-and-replace over the single-quoted annotations below
 * cannot silently rewrite it.
 */
type AcceptsGeneratedProps<T extends (props: PageProps<'/[locale]/categories/[slug]'>) => unknown> = T
export type _CategoryPageAcceptsGeneratedProps = AcceptsGeneratedProps<typeof CategoryArchive>
export type _CategoryMetadataAcceptsGeneratedProps = AcceptsGeneratedProps<typeof generateMetadata>

/** Identical to app/writing/page.tsx's copy; see the note there for why '1.5', '0x2',
 *  '2abc' and a 22-digit string must not reach `Number.parseInt` unchecked. */
function parsePage(page: string | string[] | undefined): number {
  const raw = Array.isArray(page) ? (page[0] ?? '') : (page ?? '')
  return /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : 0
}

/**
 * The slug the reader typed, settled.
 *
 * Route params are NOT url-decoded by Next (searchParams are), and the same Vietnamese
 * text arrives composed or decomposed depending on the client — lib/text.ts carries the
 * long version. It matters twice here: once for the `find` below, and once for the API
 * call, which must use the same string the comparison succeeded on.
 */
async function resolveCategory(params: Promise<{ slug: string }>, locale: Locale): Promise<Category | undefined> {
  const { slug } = await params
  const wanted = normalizeSlug(slug)
  if (wanted === '') return undefined

  // Only a 404 from the backend means "it is not there"; any other failure propagates, because turning a transport blip
  // into a 404 would hit every category archive at once and 404s get cached. The detail is visible whatever the
  // language of its posts, which is what lets an empty language show the fallback instead of a 404.
  try {
    const category = await getCategory(wanted, locale)
    return category.slug === wanted ? category : undefined
  } catch (error) {
    if (error instanceof NotFoundError) return undefined
    throw error
  }
}

/** Path of a category, by the slug the backend stores: the canonical and the pagination href share it. */
function categoryPath(slug: string): string {
  return `/categories/${encodeURIComponent(slug)}`
}

/**
 * Title, description and canonical of a category page, built once for the two places that read them:
 * generateMetadata (title, meta description, canonical, og:*) and the CollectionPage in the page
 * body. If each built its own, one day the JSON-LD would declare a URL the canonical tag does not recognize.
 */
function categoryHead(category: Category, page: number, t: Translator) {
  const base = categoryPath(category.slug)
  return {
    title: t('categoryTitle', { name: category.name }),
    description: category.description ?? t('categoryDescription', { name: category.name }),
    // Inherited from app/layout.tsx as '/' if this is omitted — verified live on
    // /posts/[slug], which once told crawlers its canonical URL was the homepage.
    // The page number is kept rather than collapsed to page one, so pages 2..N are not
    // asked to drop out of the index along with the posts that only appear on them.
    // lib/metadata.ts reuses this exact string as `og:url`, which this route was
    // getting from the homepage until now.
    canonical: page > 0 ? `${base}?page=${page}` : base,
  }
}

export async function generateMetadata(props: PageProps<'/[locale]/categories/[slug]'>): Promise<Metadata> {
  const locale = await metadataLocale(props.params)
  const t = await getTranslations({ locale, namespace: 'Site.taxonomy' })
  const { page } = await props.searchParams
  const current = parsePage(page)

  // Wrapped, unlike the page body: a metadata throw is an unrecoverable 500 for a page
  // whose body might have rendered fine, and the body below does its own 404. The post
  // page takes the same shape.
  const category = await resolveCategory(props.params, locale).catch(() => undefined)
  if (!category) return { title: t('categoryNotFoundTitle') }

  return pageMetadata({
    ...categoryHead(category, current, t),
    // The own feed, promoted next to the general feed on every page of it.
    feed: { path: categoryFeedPath(category.slug), title: await feedTitle(locale, category.name) },
    locale,
  })
}

export default async function CategoryArchive(props: PageProps<'/[locale]/categories/[slug]'>) {
  const locale = await setPageLocale(props.params)
  const t = await getTranslations({ locale, namespace: 'Site.taxonomy' })
  const { page } = await props.searchParams
  const current = parsePage(page)

  // First, and before any network call at all: an absurd page does not exist, which is
  // knowable without asking. Neither getCategory nor getPosts is reached.
  if (current > MAX_PAGE) notFound()

  // A slug that matches nothing is a 404, NOT an empty list. The API answers
  // `{"data":[],"pagination":{…,"totalElements":0}}` for an unknown category — measured
  // — so an archive page that trusted it would render "No posts yet." under a
  // heading naming a category that does not exist, with HTTP 200 on it. That is a soft
  // 404, and search engines index it. The only way to tell the two apart is to ask for
  // the list of categories, which is why this fetch exists.
  const category = await resolveCategory(props.params, locale)
  if (!category) notFound()

  // `category.slug`, not the reader's raw param: the comparison above succeeded against
  // the canonical value, so that is what goes on the wire and into every href.
  const { items, meta } = await getPosts({
    page: current,
    size: PAGE_SIZE,
    category: category.slug,
    language: locale,
  })

  // `current > 0`, not `meta.totalPages > 0` — a category with no posts yet is a real
  // page whose first page is empty, while ?page=1 of it is not. See app/writing/page.tsx.
  if (current > 0 && current >= meta.totalPages) notFound()

  const basePath = categoryPath(category.slug)
  const fallbackLanguage =
    meta.totalElements === 0
      ? await otherLanguageWithPosts(
          locale,
          async (language) => (await getPosts({ page: 0, size: 1, category: category.slug, language })).meta.totalElements,
        )
      : null
  const head = categoryHead(category, current, t)

  return (
    <>
      {/* The posts of exactly this page, in the order shown, numbered continuing after the previous pages.
          No BreadcrumbList: the top of the page only has the "← All posts" back link, with no
          visible breadcrumb (components/site/Breadcrumb.tsx) for the structured data to describe.
          A category with no posts renders nothing from the component. */}
      <CollectionPageJsonLd
        locale={locale}
        name={head.title}
        description={head.description}
        url={head.canonical}
        offset={current * PAGE_SIZE}
        items={items.map((post) => ({ name: post.title, url: postPath(post.slug) }))}
      />

      <BrowseFrame current={{ key: 'topics', exact: false }}>
        <header className="pb-6">
          <Link
            href="/writing"
            className="text-sm text-neutral-600 transition-colors duration-[120ms] hover:text-brand hover:underline motion-reduce:transition-none max-sm:inline-flex max-sm:min-h-11 max-sm:items-center dark:text-neutral-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
          >
            {t('backToAll')}
          </Link>

          <p className="mt-4 text-xs font-semibold uppercase sm:mt-6 tracking-wide text-neutral-600 dark:text-neutral-400">
            {t('categoryEyebrow')}
          </p>
          {/* The h1 names what is being filtered. One h1 per page; PostList's rows are h2. */}
          <h1 className="mt-1 text-3xl font-bold tracking-tight sm:text-4xl">{category.name}</h1>

          {category.description && (
            <p className={`mt-3 ${MEASURE} text-neutral-600 dark:text-neutral-400`}>{category.description}</p>
          )}

          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">{t('postCount', { count: meta.totalElements })}</p>
        </header>

        {/*
        No heading on this section, deliberately. An sr-only "All posts" here
        would make every post title its SIBLING rather than its child — PostList's rows
        are h2, so the outline would read h1, h2(label), h2(post), h2(post)… and a
        screen-reader user navigating by heading would hear a label that owns nothing.
        Demoting the rows to h3 instead would break PostList on any page that uses it
        without a section heading. The section's own name is carried by the h1 above.
      */}
        <section>
          {/* `showCategory={false}`: the h1 is already the category name, so the category link on each row
            would only be a link to this same page. */}
          <PostList
            posts={items}
            emptyMessage={t('categoryEmpty')}
            emptyFallback={fallbackLanguage ? <LanguageFallback path={basePath} language={fallbackLanguage} /> : undefined}
            showCategory={false}
          />
          <Pagination meta={meta} basePath={basePath} />
        </section>
      </BrowseFrame>
    </>
  )
}
