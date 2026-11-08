import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { FolderIcon } from '@/components/icons'
import { BrowseFrame } from '@/components/site/BrowseFrame'
import { TagCountChips } from '@/components/site/DiscoveryGrid'
import { CollectionPageJsonLd } from '@/components/site/JsonLd'
import { LanguageFallback } from '@/components/site/LanguageFallback'
import { META_ICON } from '@/components/site/ReadingMeta'
import { SectionHeading, TITLE_LINK } from '@/components/site/SectionHeading'
import { countCategories, countTags } from '@/lib/discovery'
import { otherLanguageWithPosts } from '@/lib/language-fallback'
import { metadataLocale } from '@/lib/locale-path'
import { pageMetadata } from '@/lib/metadata'
import { fetchAllPublishedPosts } from '@/lib/published-posts'
import { getCategories } from '@/lib/taxonomy'
import { getSiteContent } from '@/lib/site-content'
import { pageDescription } from '@/lib/site-pages'
import { setPageLocale } from '@/i18n/page-locale'
import { MEASURE, MEASURE_SMALL } from '@/components/site/reader/reader-layout'

/**
 * Rendered per request, not prerendered at build time.
 *
 * The page reads no params or searchParams, so nothing else makes it dynamic: `next build` would
 * prerender it, and in the Docker build there is no API: the page would either fail the build or be baked
 * from a failed call. Same reason as the home page and app/sitemap.ts. No `revalidate` alongside:
 * `force-dynamic` sets it to 0 at build time, so a `revalidate = 300` next to it is dead text.
 * The 300-second cache still exists, on each fetch (lib/taxonomy.ts, lib/api.ts).
 */
export const dynamic = 'force-dynamic'

const CANONICAL = '/topics'

export async function generateMetadata(props: PageProps<'/[locale]/topics'>): Promise<Metadata> {
  const locale = await metadataLocale(props.params)
  const t = await getTranslations({ locale, namespace: 'Site.topics' })
  const descriptions = await getTranslations({ locale, namespace: 'Site.pageDescriptions' })
  const { site, profile } = await getSiteContent(locale)
  return pageMetadata({
    locale,
    title: t('title'),
    description: pageDescription('/topics', descriptions, { siteName: site.name, galleryLead: profile.galleryLead }),
    // Cannot be dropped: without it the page inherits the canonical '/' of app/layout.tsx and declares itself a
    // copy of the home page (see app/(site)/writing/page.tsx).
    canonical: CANONICAL,
  })
}

/** Page of a category, by slug: the visible link and the ItemList entry share it. */
function categoryPath(slug: string): string {
  return `/categories/${encodeURIComponent(slug)}`
}

/**
 * Page of a tag, by slug: exactly the string TagCountChips (components/site/DiscoveryGrid.tsx)
 * builds for the chip. Two expressions in two files, so the page test compares the URL in the ItemList with the href of
 * each visible chip: a mismatch is red, not a false claim sitting quietly.
 */
function tagPath(slug: string): string {
  return `/tags/${encodeURIComponent(slug)}`
}

/**
 * The topic index: categories (name, post count, description) then tags (chips with counts). The target of
 * "All topics →" in the Discovery block and of the `/tags`, `/categories` redirects.
 *
 * Post counts are counted from all published posts (same source as the sitemap and feed), so a topic with 0 posts
 * never shows: a link to an empty category page or tag page is not a topic.
 * That is why the page does not ask the backend tag list: a tag that has posts is already found in the posts.
 *
 * Both sources are the main content and do NOT catch errors: swallowing a failure here gives "No topics yet."
 * with HTTP 200 when the API is down, a page that looks real and is wrong. Throwing reaches app/error.tsx, which is a 500.
 */
export default async function TopicsPage(props: PageProps<'/[locale]/topics'>) {
  const locale = await setPageLocale(props.params)
  const t = await getTranslations({ locale, namespace: 'Site.topics' })
  const descriptions = await getTranslations({ locale, namespace: 'Site.pageDescriptions' })
  const { site, profile } = await getSiteContent(locale)
  const lead = pageDescription('/topics', descriptions, { siteName: site.name, galleryLead: profile.galleryLead })
  const [categories, posts] = await Promise.all([getCategories(locale), fetchAllPublishedPosts(locale)])

  const categoryCounts = countCategories(posts, categories)
  const tagCounts = countTags(posts, locale)
  const isEmpty = categoryCounts.length === 0 && tagCounts.length === 0

  const fallbackLanguage = isEmpty
    ? await otherLanguageWithPosts(locale, async (language) => (await fetchAllPublishedPosts(language)).length)
    : null

  return (
    <>
      {/* This page lists topics, not posts: the ItemList is the category pages and then the tag
          pages, in exactly the order the two sections below show them, only topics that have posts. No
          BreadcrumbList: the page has no visible breadcrumb. With no topics the component
          renders nothing. */}
      <CollectionPageJsonLd
        name={t('title')}
        description={lead}
        url={CANONICAL}
        locale={locale}
        items={[
          ...categoryCounts.map(({ category }) => ({ name: category.name, url: categoryPath(category.slug) })),
          ...tagCounts.map(({ tag }) => ({ name: tag.name, url: tagPath(tag.slug) })),
        ]}
      />

      {/* No <main> here. app/layout.tsx owns the document's single `<main id="main-content">`. */}
      <BrowseFrame current={{ key: 'topics', exact: true }}>
        <header className="pb-6">
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{t('title')}</h1>
          <p className={`mt-3 ${MEASURE} text-neutral-600 dark:text-neutral-400`}>{lead}</p>
        </header>

        {isEmpty ? (
          <div>
            {fallbackLanguage ? (
              <LanguageFallback path="/topics" language={fallbackLanguage} />
            ) : (
              <p className="py-6 text-neutral-600 dark:text-neutral-400">{t('empty')}</p>
            )}
          </div>
        ) : null}

        {categoryCounts.length > 0 ? (
          <section aria-labelledby="chuyen-muc" className="pb-10">
            <SectionHeading id="chuyen-muc" title={t('categories')} />
            {/* Cards, not hairline rows: a row stretched over the whole column puts the name and the count a long way apart. The link is a
              stretched link (the `after:` of the anchor covers the `relative` card), so the whole card is the hit area, not the 24px label. */}
            <ul className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {categoryCounts.map(({ category, count }) => (
                <li
                  key={category.id}
                  className="relative min-w-0 rounded-card border border-neutral-200 p-4 sm:p-5 dark:border-neutral-800"
                >
                  <div className="flex items-baseline justify-between gap-4">
                    {/* The icon inside the link like in ReadingMeta: part of the click target, aria-hidden so the link
                      name stays just the category name. */}
                    <Link
                      href={categoryPath(category.slug)}
                      className={`inline-flex min-w-0 items-center gap-2 font-medium after:absolute after:inset-0 ${TITLE_LINK}`}
                    >
                      <FolderIcon size={14} className={META_ICON} />
                      {category.name}
                    </Link>
                    <span className="shrink-0 text-sm tabular-nums text-neutral-500 dark:text-neutral-400">
                      {t('postCount', { count })}
                    </span>
                  </div>
                  {category.description ? (
                    <p className={`mt-1 ${MEASURE_SMALL} text-sm text-neutral-600 dark:text-neutral-400`}>
                      {category.description}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {tagCounts.length > 0 ? (
          <section aria-labelledby="the">
            <SectionHeading id="the" title={t('tags')} />
            {/* Every tag that has posts, no cut: this is the full index that the Discovery block points to. */}
            <TagCountChips tags={tagCounts} className="mt-6" />
          </section>
        ) : null}
      </BrowseFrame>
    </>
  )
}
