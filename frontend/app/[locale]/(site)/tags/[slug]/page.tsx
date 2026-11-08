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
import { tagFeedPath } from '@/lib/site'
import { getTag } from '@/lib/taxonomy'
import { normalizeSlug } from '@/lib/text'
import type { Tag } from '@/lib/types'
import { setPageLocale } from '@/i18n/page-locale'
import type { Translator } from '@/i18n/translator'

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
 * the route static. Both exports are checked, and this file carries the same guard as
 * its neighbour app/categories/[slug]/page.tsx on purpose: the project's own recorded
 * mistake was fixing the post page's signature guard and leaving the homepage's off.
 * The route literal is double-quoted so a search-and-replace over the single-quoted
 * annotations below cannot silently rewrite it.
 */
type AcceptsGeneratedProps<T extends (props: PageProps<'/[locale]/tags/[slug]'>) => unknown> = T
export type _TagPageAcceptsGeneratedProps = AcceptsGeneratedProps<typeof TagArchive>
export type _TagMetadataAcceptsGeneratedProps = AcceptsGeneratedProps<typeof generateMetadata>

/** Identical to app/writing/page.tsx's copy; see the note there for why '1.5', '0x2',
 *  '2abc' and a 22-digit string must not reach `Number.parseInt` unchecked. */
function parsePage(page: string | string[] | undefined): number {
  const raw = Array.isArray(page) ? (page[0] ?? '') : (page ?? '')
  return /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : 0
}

/**
 * Matched on `slug`, which is the whole point of this route existing.
 *
 * For all of Sprint 3a the API returned tag names only, and lib/types.ts documented at
 * length that a chip could therefore only link to `?tag=<name>` — which the backend
 * matches against `tags.slug` (PostSpecifications), so it matched nothing. The two
 * strings differ for most real tags: a name with diacritics/"bai-hoc", "CI/CD"/"ci-cd",
 * "Spring Boot"/"spring-boot". Comparing a route param against `tag.name` here would
 * reintroduce that bug in the other direction, with every chip 404ing instead of
 * showing an empty list.
 *
 * `normalizeSlug` because route params are not url-decoded by Next and Vietnamese text
 * arrives composed or decomposed; lib/text.ts carries the long version.
 */
async function resolveTag(params: Promise<{ slug: string }>, locale: Locale): Promise<Tag | undefined> {
  const { slug } = await params
  const wanted = normalizeSlug(slug)
  if (wanted === '') return undefined

  // Only a 404 from the backend means "it is not there"; any other failure propagates (a blip must not become a cached 404).
  // The detail is visible whatever the language of its posts, so an empty language can show the fallback instead of a 404.
  try {
    const tag = await getTag(wanted, locale)
    return tag.slug === wanted ? tag : undefined
  } catch (error) {
    if (error instanceof NotFoundError) return undefined
    throw error
  }
}

/** Path of a tag, by SLUG (not name): the canonical and the pagination href share it. */
function tagPath(slug: string): string {
  return `/tags/${encodeURIComponent(slug)}`
}

/**
 * Title, description and canonical of a tag page, built once for the two places that read them:
 * generateMetadata (title, meta description, canonical, og:*) and the CollectionPage in the page
 * body, like the neighboring category page, so that the two pages do not drift apart.
 */
function tagHead(tag: Tag, page: number, t: Translator) {
  const base = tagPath(tag.slug)
  return {
    title: t('tagTitle', { name: tag.name }),
    description: t('tagDescription', { name: tag.name }),
    // Inherited from app/layout.tsx as '/' if omitted — verified live on /posts/[slug],
    // which once declared the homepage as its canonical URL. The page number is kept
    // rather than collapsed to page one. lib/metadata.ts reuses this string as `og:url`.
    canonical: page > 0 ? `${base}?page=${page}` : base,
  }
}

export async function generateMetadata(props: PageProps<'/[locale]/tags/[slug]'>): Promise<Metadata> {
  const locale = await metadataLocale(props.params)
  const t = await getTranslations({ locale, namespace: 'Site.taxonomy' })
  const { page } = await props.searchParams
  const current = parsePage(page)

  // Wrapped, unlike the page body: a metadata throw is an unrecoverable 500 for a page
  // whose body might have rendered fine, and the body below does its own 404.
  const tag = await resolveTag(props.params, locale).catch(() => undefined)
  if (!tag) return { title: t('tagNotFoundTitle') }

  return pageMetadata({
    ...tagHead(tag, current, t),
    // The own feed, promoted next to the general feed on every page of it.
    feed: { path: tagFeedPath(tag.slug), title: await feedTitle(locale, tag.name) },
    locale,
  })
}

export default async function TagArchive(props: PageProps<'/[locale]/tags/[slug]'>) {
  const locale = await setPageLocale(props.params)
  const t = await getTranslations({ locale, namespace: 'Site.taxonomy' })
  const { page } = await props.searchParams
  const current = parsePage(page)

  // First, and before any network call: an absurd page does not exist, which is
  // knowable without asking. Neither getTag nor getPosts is reached.
  if (current > MAX_PAGE) notFound()

  // A slug that matches nothing is a 404, NOT an empty list. The API answers an empty
  // page for an unknown tag, so an archive that trusted it would render
  // "no posts yet" under a heading naming a tag that does not exist, with HTTP 200 on it —
  // a soft 404 that search engines index.
  const tag = await resolveTag(props.params, locale)
  if (!tag) notFound()

  // `tag.slug` on the wire, never `tag.name`: `getPosts({ tag })` filters on
  // `tags.slug`, and the comparison above succeeded against the canonical value.
  const { items, meta } = await getPosts({ page: current, size: PAGE_SIZE, tag: tag.slug, language: locale })

  // `current > 0`, not `meta.totalPages > 0` — see app/writing/page.tsx.
  if (current > 0 && current >= meta.totalPages) notFound()

  const basePath = tagPath(tag.slug)
  const fallbackLanguage =
    meta.totalElements === 0
      ? await otherLanguageWithPosts(
          locale,
          async (language) => (await getPosts({ page: 0, size: 1, tag: tag.slug, language })).meta.totalElements,
        )
      : null
  const head = tagHead(tag, current, t)

  return (
    <>
      {/* Like the category page: the posts of exactly this page, in the order shown, numbered continuing
          after the previous pages. No BreadcrumbList: "← All posts" is a back link, the page
          has no visible breadcrumb. A tag with no posts renders nothing from the component. */}
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
            {t('tagEyebrow')}
          </p>
          {/* The h1 names what is being filtered. One h1 per page; PostList's rows are h2. */}
          <h1 className="mt-1 text-3xl font-bold tracking-tight sm:text-4xl">{tag.name}</h1>

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
          <PostList
            posts={items}
            emptyMessage={t('tagEmpty')}
            emptyFallback={fallbackLanguage ? <LanguageFallback path={basePath} language={fallbackLanguage} /> : undefined}
          />
          <Pagination meta={meta} basePath={basePath} />
        </section>
      </BrowseFrame>
    </>
  )
}
