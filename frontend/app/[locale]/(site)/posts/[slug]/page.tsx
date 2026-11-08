import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { ApiError, NotFoundError, getPost, getPostRedirect, getPosts } from '@/lib/api'
import { getDiscovery, type Discovery } from '@/lib/discovery'
import { renderMarkdown } from '@/lib/markdown'
import { fetchAllPublishedPosts } from '@/lib/published-posts'
import { authorIdentity, heroSeries, nextReading } from '@/lib/reader-hero'
import { buildLeftRail, type LeftRailModel } from '@/lib/reader-rail'
import { getSeries } from '@/lib/series'
import { isPlausibleSlug, normalizeSlug } from '@/lib/text'
import type { Locale } from '@/i18n/config'
import type { Post, PostSummary, SeriesDetail } from '@/lib/types'
import { ArticleJsonLd, postAlternates, postLanguage, postPath } from '@/components/site/ArticleJsonLd'
import { ArticleBody } from '@/components/site/ArticleView'
import { AuthorBox } from '@/components/site/AuthorBox'
import { BookmarkButton } from '@/components/site/BookmarkButton'
import { breadcrumbTrail } from '@/components/site/Breadcrumb'
import { CommentSection } from '@/components/site/comments/CommentSection'
import { DiscoveryGrid } from '@/components/site/DiscoveryGrid'
import { BreadcrumbJsonLd } from '@/components/site/JsonLd'
import { LikeButton } from '@/components/site/LikeButton'
import { PostCover } from '@/components/site/PostCover'
import { PostNav, getAdjacentPosts, type SeriesNeighbours } from '@/components/site/PostNav'
import { RelatedPosts, getRelatedPosts } from '@/components/site/RelatedPosts'
import { ArticleHero } from '@/components/site/reader/ArticleHero'
import { LeftRail } from '@/components/site/reader/LeftRail'
import { ReadingRail } from '@/components/site/reader/ReadingRail'
import { ARTICLE_SLOT, BODY_SLOT, END_SLOT, READER_GRID } from '@/components/site/reader/reader-layout'
import { ShareBar } from '@/components/site/ShareBar'
import { ShareMenu } from '@/components/site/reader/ShareMenu'
import { SwitcherTargets } from '@/components/site/LanguageSwitcher'
import { TocNav } from '@/components/site/TocNav'
import { TranslationLink } from '@/components/site/TranslationLink'
import { ViewBeacon } from '@/components/site/ViewBeacon'
import { coverOgImage, pageMetadata, postCardOgImage } from '@/lib/metadata'
import { getSiteContent } from '@/lib/site-content'
import { permanentRedirect } from '@/i18n/navigation'
import { setPageLocale } from '@/i18n/page-locale'
import { metadataLocale } from '@/lib/locale-path'
import { routing } from '@/i18n/routing'

/**
 * Makes THIS FILE reject a hand-written `{ params: { slug: string } }`.
 *
 * `PageProps<'/[locale]/posts/[slug]'>` is the plan's named defence against synchronous params,
 * and on its own it is weaker than it reads. Next's generated validator types the page's
 * default export and `generateMetadata` as `{ params: Promise<…> } & any`, and `X & any`
 * collapses to `any` — so the framework accepts literally any signature, including
 * `(p: string) => string`. Swapping the annotation for a sync shape produced fifteen
 * errors, every one of them at a call site in page.test.tsx and none in this file: the
 * guard lived entirely in the test's return type, one "simplify the fixture" refactor
 * from vanishing, with all four gates staying green.
 *
 * These two aliases put the check where the mistake would be made. The route literal is
 * double-quoted on purpose: a search-and-replace over the single-quoted annotations below
 * cannot rewrite it, which is how a first attempt at this silently disarmed itself.
 */
type AcceptsGeneratedProps<T extends (props: PageProps<'/[locale]/posts/[slug]'>) => unknown> = T
export type _PageAcceptsGeneratedProps = AcceptsGeneratedProps<typeof PostPage>
export type _MetadataAcceptsGeneratedProps = AcceptsGeneratedProps<typeof generateMetadata>

export const revalidate = 300

/**
 * Returning [] when the API is unreachable is the difference between a degraded build
 * and no build at all: `next build` exits 1 if this throws, with no partial output.
 * dynamicParams stays at its default, so posts absent here are generated on first
 * visit and then cached.
 */
export async function generateStaticParams() {
  try {
    const { items } = await getPosts({ page: 0, size: 200 })
    return items.flatMap((post) => routing.locales.map((locale) => ({ locale, slug: post.slug })))
  } catch {
    return []
  }
}

/**
 * The target of an old path: the current slug of the published post that once carried the slug `wanted`,
 * or null. Only called after getPost(wanted) has returned 404.
 *
 * A target equal to `wanted` itself (compared after NFC, like `wanted`) gives null: the backend only returns the slug of a post
 * that is CURRENTLY published, so this only happens when two cached answers disagree, and redirecting then
 * would be a loop back to this very URL. 404 is the right answer until the cache refreshes.
 *
 * An error from the lookup (other than 404) passes through: the caller decides, as with getPost.
 */
async function movedTo(wanted: string): Promise<string | null> {
  const target = await getPostRedirect(wanted)
  return target !== null && target.normalize('NFC') !== wanted ? target : null
}

export async function generateMetadata(props: PageProps<'/[locale]/posts/[slug]'>): Promise<Metadata> {
  const { locale, slug } = await props.params
  const pageLocale = await metadataLocale(props.params)
  const wanted = normalizeSlug(slug)
  // A value no post can have (a slash, a control character, too long) is a 404 without a backend call, here and in the page.
  if (!isPlausibleSlug(wanted)) {
    const t = await getTranslations({ locale, namespace: 'Site.article' })
    return { title: t('notFoundTitle') }
  }
  let moved: string | null = null
  try {
    const post = await getPost(wanted)
    /**
     * The excerpt, verbatim. Not shortened, and that is a decision rather than an
     * omission — an SEO audit asked for the opposite and was wrong on measurement.
     *
     * The audit's reasoning: 11 of 12 excerpts exceed 160 characters (longest 266), so
     * "almost every article loses its tail on the results page, and the part that is lost
     * is the part that distinguishes it". Its prescription: cut to the nearest sentence
     * boundary under ~155 characters. Both halves were checked.
     *
     *  - THE LIMIT IS NOT A LIMIT. Google's own snippet documentation says "there's no
     *    limit on how long a meta description can be, but the snippet is truncated in
     *    Google Search results as needed, typically to fit the device width". A character
     *    count is a proxy for a pixel width that varies per device, so a fixed cut
     *    discards text on every device, including the ones where it would have been shown.
     *  - THE PRESCRIPTION DELETES THE PAYLOAD. Running that exact algorithm over a realistic
     *    set of excerpts drops the sentence that carries the answer or the punchline of an
     *    article. Some excerpts contain no sentence boundary inside the budget at all and
     *    fall through to a mid-phrase ellipsis, the "ugly hard cut" the same brief forbids.
     *
     * The two concepts ARE separate, which was the audit's real architectural point, and
     * they are already separate in this codebase: `excerpt` is listing copy, with its own
     * product rule enforced at the source (seed/push.py warns outside 100-400 characters
     * and wants roughly 150-300), and it is used as the description because it is
     * independently a good one: unique, trimmed, free of markdown and written as prose. A
     * transform would be a no-op on such excerpts and a destructive one on the next excerpt that happened to run long. If a future
     * excerpt ever stops being a usable description, the fix belongs where the excerpt is
     * written, not in a truncator here. post.test.tsx pins the qualities that actually
     * matter; nothing in this repo asserts a character count.
     *
     * `string | undefined`, never null, and the key is always set — lib/metadata.ts
     * carries the long note on why an ABSENT key would make this article advertise the
     * homepage's description instead of none.
     */
    const description = post.excerpt ?? undefined
    // `post.slug`, not the slug from the URL. They differ when the reader arrived via
    // a decomposed (NFD) spelling of a Vietnamese slug — the canonical URL has to be
    // the one spelling the backend stores, or the canonical tag points at a second
    // URL for the same article, which is the duplicate it exists to collapse.
    const canonical = postPath(post.slug)

    return pageMetadata({
      locale: pageLocale,
      // The post's own language URL is its canonical whatever locale the page was opened under; hreflang only links the post
      // and its published translations.
      contentLanguage: postLanguage(post),
      languages: postAlternates(post),
      /**
       * `absolute`, so the document title is the article's title and nothing else — no
       * ` — <owner name>` suffix. Measured rather than argued, in the font Google
       * renders desktop result titles in (Arial 20px) against the ~600px the title
       * column gives:
       *
       *   with suffix      9 / 12 posts exceed 600px, longest 975px
       *   without suffix   2 / 12
       *
       * The suffix costs ~210px of a 600px budget, and seven of the nine truncations are
       * caused by it alone. What it buys is a name Google already has from this page:
       * `og:site_name`, and `author.name` in the BlogPosting. What it costs is the end of
       * the sentence — which on an article title is the half carrying the claim.
       *
       * Only on articles. Every other route's title is two or three words ("Writing",
       * "About", "Category: Architecture") and sits far inside the budget with the
       * suffix attached, where the name is free and worth having.
       *
       * This is NOT the character-count rule an earlier audit asked for, and the
       * distinction matters: a character count is a proxy for a pixel width, and the
       * same audit's description rule was refused in the note below precisely because
       * the proxy deletes real text. Here the pixel width itself is the measurement.
       */
      title: { absolute: post.title },
      description,
      // Without this every article inherits app/layout.tsx's `alternates.canonical: '/'`
      // and declares itself a duplicate of the homepage. Measured on the running dev
      // server before the fix: /posts/<slug> emitted
      // `<link rel="canonical" href="http://localhost:3000"/>`. Relative on purpose —
      // Next resolves it against `metadataBase`, so one origin is configured once.
      canonical,
      /**
       * A post without a cover image gets its own card (/api/og/posts/<slug>, the one carrying THIS article's title) rather than the
       * site-wide one, so twelve articles do not share one picture. A post with a cover image uses it as og:image: the image the
       * author chose wins over the generated text card, and whoever receives the share sees exactly the image at the top of the
       * post page. The ~1200px version through /_next/image rather than the original file of up to 4 MiB; see coverOgImage.
       */
      image: post.cover
        ? coverOgImage(post.cover, post.cover.altText ?? post.title)
        : postCardOgImage(post.slug, post.title, post.updatedAt),
      og: {
        type: 'article',
        // Omitted rather than null when the post has no publication date: OG parsers
        // reject `article:published_time` with an empty value.
        ...(post.publishedAt ? { publishedTime: post.publishedAt } : {}),
        modifiedTime: post.updatedAt,
      },
    })
  } catch (error) {
    // Old path: the same answer as the page. Metadata is a separate call, sometimes
    // running even before the page (crawlers receive head-blocking metadata), so it must not build a
    // "not found" title for a URL that is really a 308. A failed lookup still gives the fallback title:
    // this function does not throw because of a data error (see the test), the page throws its own real error.
    if (error instanceof NotFoundError) moved = await movedTo(wanted).catch(() => null)
  }
  // Outside the try: permanentRedirect throws NEXT_REDIRECT, and the catch above would swallow it.
  if (moved !== null) permanentRedirect({ href: postPath(moved), locale })
  const t = await getTranslations({ locale, namespace: 'Site.article' })
  return { title: t('notFoundTitle') }
}

export default async function PostPage(props: PageProps<'/[locale]/posts/[slug]'>) {
  const locale = await setPageLocale(props.params)
  const { slug } = await props.params
  const t = await getTranslations('Site.article')
  const tReader = await getTranslations('Site.reader')
  const { site, profile, contact } = await getSiteContent(locale)
  // params are NOT url-decoded by Next (searchParams are), and the same text can
  // arrive composed or decomposed — normalizeSlug settles both. Once: it is not
  // idempotent, and the redirect lookup below must ask about the slug that just 404ed.
  const wanted = normalizeSlug(slug)
  // Issue 106: no post has a slash, a control character or more than 255 characters in its slug. Answering 404 here keeps the
  // value away from the backend (which would answer 400) and from the prerender cache (a long one becomes a file name).
  if (!isPlausibleSlug(wanted)) notFound()

  let post
  try {
    post = await getPost(wanted)
  } catch (error) {
    // The backend refuses a slug it will not take with a 400: that is the visitor's URL, not an outage, so it is a 404 and not a
    // 500 with a stack trace in the log. A 5xx still passes through (below).
    if (error instanceof ApiError && error.status === 400) notFound()
    if (!(error instanceof NotFoundError)) throw error
    /*
      Old path: when the slug of a published post changes the backend remembers the old slug, and the old link
      (already shared, already indexed) redirects PERMANENTLY (308) to the current slug instead of 404.
      One lookup, only after a real 404: a 503 from getPost already passed through on the line above, and a
      503 from the lookup itself also passes through (error.tsx), it does not become a 404 that crawlers would cache.

      getPostRedirect is cached with the same tag (`posts`) and the same 300 seconds as getPost, so the next post save
      in admin (updateTag('posts')) refreshes both at once, even when the author changes the slug back
      to what it was: that path is a post again, and no longer redirects anywhere.
    */
    const target = await movedTo(wanted)
    if (target !== null) permanentRedirect({ href: postPath(target), locale })
    notFound()
  }

  // Neighbours, related posts, series and suggestions are all in the language of the post, not of the URL it was opened under.
  const language = postLanguage(post)

  // Independent pieces of work, so sequential awaits would make the page as slow as their
  // sum. Shiki highlighting is the expensive one and none of the others depends on it.
  // None of the others can reject — the two listing helpers swallow their own failure and
  // return nothing, and the series and discovery loaders below do the same (secondary
  // blocks catch their errors and hide themselves) — so Promise.all cannot fail here on their account, and
  // `renderMarkdown` throwing is a real error that should still reach error.tsx.
  // The left rail needs the series, so it chains on the series promise instead of waiting for the others.
  const seriesRequest = seriesOf(post, language)
  const [{ content, toc }, related, adjacent, series, discovery, leftRail] = await Promise.all([
    renderMarkdown(post.content),
    getRelatedPosts(post, language),
    getAdjacentPosts(post.slug, language),
    seriesRequest,
    discoveryAfter(post.slug, language),
    seriesRequest.then((loaded) => leftRailOf(post, loaded, language)),
  ])

  const neighbours = seriesNeighbours(series, post.slug)
  const published = post.status === 'PUBLISHED'

  // The structured data is the first child of the article (the header's head slot).
  const head = (
    <>
      <ArticleJsonLd post={post} ownerName={profile.name} />
      {/* Same condition as BlogPosting: a BreadcrumbList for an old draft is also a claim
          made to crawlers about a URL that returns 404 for it. The steps come from exactly the function that builds the visible
          breadcrumb, then the post itself is added at the end. */}
      {published ? (
        <BreadcrumbJsonLd
          locale={locale}
          items={[
            ...breadcrumbTrail(post.category, await getTranslations({ locale, namespace: 'Site.breadcrumb' })),
            // The post itself lives at the URL of its own language, like its canonical.
            { name: post.title, url: postPath(post.slug), locale: language },
          ]}
        />
      ) : null}
    </>
  )

  // Like, save and share: the actions of the reading rail, published posts only. Two client islands plus the share bar: the
  // prerendered HTML only has inert placeholders, the reader state arrives after hydration, so the page stays static
  // for everyone. Below `rail:` this is the toolbar drawn after the article; from `rail:` the lower part of the sticky rail.
  const actions = published ? (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-neutral-200 py-4 dark:border-neutral-800 rail:flex-col rail:items-start rail:border-t rail:pt-5 rail:pb-0 max-rail:[&_a]:min-h-11 max-rail:[&_button]:min-h-11 pointer-coarse:[&_a]:min-h-11 pointer-coarse:[&_button]:min-h-11">
      {/* One row on a phone: like, save, and the share menu (the four share icons collapse into it below `sm`). */}
      <div className="flex flex-wrap items-start gap-x-1 gap-y-2 max-sm:flex-nowrap max-sm:items-center max-sm:gap-x-2">
        <LikeButton slug={post.slug} language={language} />
        <BookmarkButton slug={post.slug} language={language} />
        <div className="ms-auto sm:hidden">
          <ShareMenu slug={post.slug} title={post.title} language={language} alignEnd />
        </div>
      </div>
      <div className="max-sm:hidden">
        <ShareBar variant="rail" slug={post.slug} title={post.title} language={language} />
      </div>
    </div>
  ) : null

  return (
    // No <main> here. SiteChrome owns the document's single
    // `<main id="main-content">`, which is also the skip link's target; a second main
    // landmark is invalid HTML and makes "skip to main content" ambiguous. DOM order is the focus order and, below `rail:`,
    // the visual order: skip links, sidebar, hero, body, reading rail (inside the article), end blocks (reader-layout.ts).
    // The admin preview (ArticleView) shares TocNav and ArticleBody with this page. The 1400px frame is `main` itself (SiteChrome,
    // SITE_MAIN), so the page is the grid plus the discovery band: `data-reader-grid` is the hook the layout tests and the E2E
    // geometry checks use, and the page reads no request data, so it stays ISR.
    <>
      <div data-reader-grid="" className={READER_GRID}>
        <LeftRail model={leftRail} />

        <article id="post-article" className={ARTICLE_SLOT}>
          {head}

          <ArticleHero
            post={post}
            locale={locale}
            language={language}
            t={t}
            tReader={tReader}
            author={authorIdentity(post.author, profile)}
            series={heroSeries(leftRail.primary, post.series)}
            next={nextReading({ series: neighbours, adjacent })}
            published={published}
          />

          {/* The body column: the skip link "to the text" lands here (tabIndex -1), cover first. */}
          <div data-reader-body="" id="post-body" tabIndex={-1} className={`${BODY_SLOT} focus:outline-none`}>
            {/* Cover image (high fetchPriority, no preload) or the post's own cover art. */}
            <PostCover post={post} variant="hero" />

            {/* Closed <details>, shown below `rail:` only; the reading rail renders the TocSpy of the page. */}
            <TocNav variant="inline" toc={toc} t={t} />

            <ArticleBody content={content} />

            <TranslationLink translations={post.translations} />
            {post.translations && post.translations.length > 0 ? (
              <SwitcherTargets
                targets={Object.fromEntries([
                  [language, postPath(post.slug)],
                  ...post.translations.map((item) => [item.language, postPath(item.slug)]),
                ])}
              />
            ) : null}
            {/* Published posts only: the backend only counts those, a beacon for a draft is a request
                that is certain to 404. */}
            {published ? <ViewBeacon slug={post.slug} /> : null}
          </div>

          <ReadingRail toc={toc} actions={actions} />
        </article>

        {/* The end of the post: neighbours, author, comments, related. Nothing around the author is print:hidden,
            it prints with the post; the blocks that must not print carry their own class. */}
        <div className={END_SLOT}>
          <PostNav previous={adjacent.previous} next={adjacent.next} series={neighbours} width="bare" />
          {/* AuthorBox owns no outer margin: this wrapper gives it the vertical rhythm of the other end blocks. */}
          <div className="pb-10">
            <AuthorBox author={post.author} data={profile} contactData={contact} positioning={site.positioning} />
          </div>
          {/* Comments: published posts only. Loaded client-side through the no-store BFF route when the area nears
              the screen; the page reads no cookie or header, so it stays ISR. `post.slug`, not the slug in the URL:
              the BFF route and the return target after sign-in must be exactly the string the backend stores. */}
          {published ? <CommentSection slug={post.slug} language={language} width="bare" /> : null}
          <RelatedPosts posts={related} width="bare" />
        </div>
      </div>

      {discovery ? (
        <div className="border-t border-neutral-200 dark:border-neutral-800 print:hidden">
          <DiscoveryGrid id="doc-gi-tiep" title={t('readNextTitle')} data={discovery} variant="article" width="reader" />
        </div>
      ) : null}
    </>
  )
}

/**
 * The model of the left rail (series list, category, latest, month link), or the "Explore"-only model when it cannot be built.
 * A secondary block like seriesOf: `fetchAllPublishedPosts` shares its request with PostNav, RelatedPosts and the discovery
 * block (same URL and tags); a failure of it, or of buildLeftRail itself, only costs the contextual groups, with one log line.
 */
async function leftRailOf(post: Post, series: SeriesDetail | null, language: Locale): Promise<LeftRailModel> {
  const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))
  let all: PostSummary[] | null = null
  try {
    all = await fetchAllPublishedPosts(language)
  } catch (error) {
    // Only the posts fetch is caught here: the series was already loaded and its group needs no `all`, so it is kept.
    console.warn(
      `[post] Could not list the posts for the left rail (${reason(error)}). Showing the series group and Explore only.`,
    )
  }

  try {
    const model = buildLeftRail({ post, series, all: all ?? [], language })
    // Without the listing the newest archive year is unknown: for an older post the month link would target an anchor that
    // does not exist on the default archive page, so it is dropped.
    return all ? model : { ...model, month: null }
  } catch (error) {
    console.warn(`[post] Could not build the left rail (${reason(error)}). Showing the Explore group alone.`)
    return { primary: null, secondary: null, month: null }
  }
}

/**
 * The series of the post with its published parts, or null when the post is in no series or when
 * it cannot be read. A secondary block: a failure only loses the series block and puts PostNav back on
 * chronological order, with one log line so that an API incident is not swallowed silently.
 *
 * The slug is read BEFORE the try, like getRelatedPosts: the catch only covers the network call, not a programming
 * error while reading a property of the post itself.
 */
async function seriesOf(post: Post, language: Locale): Promise<SeriesDetail | null> {
  if (!post.series) return null
  const slug = post.series.slug

  try {
    return await getSeries(slug, language)
  } catch (error) {
    console.warn(
      `[post] Could not read series "${slug}" (${error instanceof Error ? error.message : String(error)}). Hiding the series block; PostNav falls back to chronological order.`,
    )
    return null
  }
}

/**
 * The "What to read next" block, minus the post being read. getDiscovery catches the error of each source itself, logs
 * it and does not throw; the catch here is for getDiscovery itself, so that a programming error inside it does not become a
 * 500 page for a post that has already loaded.
 */
async function discoveryAfter(slug: string, language: Locale): Promise<Discovery | null> {
  try {
    return await getDiscovery({ context: 'article', excludeSlug: slug, language })
  } catch {
    return null
  }
}

/**
 * The part right before and right after in the series, in the reading order of the published parts. null when
 * there is no series, or when the post is not in that list (the two cached sources disagree);
 * PostNav then goes by time.
 */
function seriesNeighbours(series: SeriesDetail | null, slug: string): SeriesNeighbours | null {
  if (!series) return null
  const index = series.posts.findIndex((part) => part.slug === slug)
  if (index === -1) return null
  return {
    title: series.title,
    previous: series.posts[index - 1] ?? null,
    next: series.posts[index + 1] ?? null,
  }
}
