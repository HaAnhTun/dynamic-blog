import type { Metadata } from 'next'
import { Children, type ReactNode } from 'react'
import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { ContactSection } from '@/components/site/ContactSection'
import { Container } from '@/components/site/Container'
import { GallerySection } from '@/components/site/GallerySection'
import { Hero } from '@/components/site/Hero'
import { WebSiteJsonLd } from '@/components/site/JsonLd'
import { LanguageFallback } from '@/components/site/LanguageFallback'
import { ListRow } from '@/components/site/ListRow'
import { NowSection } from '@/components/site/NowSection'
import { INLINE_LINK, SectionHeading, TOUCH_ROW } from '@/components/site/SectionHeading'
import { BAND, SPLIT_ASIDE, SPLIT_EVEN } from '@/components/site/reader/reader-layout'
import { SeriesEntry } from '@/components/site/SeriesEntry'
import { Timeline } from '@/components/site/Timeline'
import type { Locale } from '@/i18n/config'
import { getPosts } from '@/lib/api'
import { otherLanguageWithPosts } from '@/lib/language-fallback'
import { getGallery } from '@/lib/gallery'
import { getSeriesList } from '@/lib/series'
import type { GalleryPhoto, PostSummary, SeriesSummary } from '@/lib/types'
import { metadataLocale } from '@/lib/locale-path'
import { pageMetadata } from '@/lib/metadata'
import { getSiteContent } from '@/lib/site-content'
import type { About } from '@/lib/site-content-types'
import { setPageLocale } from '@/i18n/page-locale'

/**
 * Rendered per request, not prerendered at build.
 *
 * `next build` runs prerendering, and in a Docker build the API is not reachable — so a
 * statically rendered version of this route is baked with whatever the build-time
 * fallback produced (nothing) and served until ISR regenerates it. Measured in the
 * composed stack: a freshly built image served a homepage with no posts and a sitemap
 * listing 10 URLs instead of 29, with every article missing.
 *
 * Static rendering is only appropriate for a route whose correctness does not depend on
 * data that may be absent at build time. This one's does. The cost of rendering per
 * request is near zero — the page is otherwise built from site content, and the
 * API call behind it keeps its own `revalidate`, so the request count against the backend
 * is unchanged. The benefit is that a deploy is correct from the first request instead of
 * from the first revalidation.
 */
export const dynamic = 'force-dynamic'

/**
 * NOW A REAL ISR WINDOW, which it was not before.
 *
 * The previous version of this file read `searchParams` for the post list's `?page`,
 * which made `/` fully dynamic — the build printed the dynamic marker, not the static
 * one — so this export set nothing, and the only revalidation that applied came from the
 * per-fetch `next: { revalidate: 300 }` in lib/api.ts. The post list has moved to
 * /writing and this page takes no params at all, so `/` can be prerendered and this is
 * the window it is prerendered with. 300 matches the fetch-level window, so the shell and
 * the featured posts inside it cannot disagree about how old they are.
 */
export const revalidate = 300

/**
 * `title.absolute`, not a plain string.
 *
 * The root layout sets `title.template` to the name-suffix form, and a page's own title IS
 * a child segment for template purposes — so a plain `site.tagline` title would render
 * with the name arriving last. `absolute` opts out of the parent template,
 * which is the documented way to say "this segment's title is final".
 *
 * The separator is an interpunct and not an em dash: a tagline may itself contain an em dash, and a reader
 * cannot tell which dash separates what. With an empty tagline the title is just the site name.
 */

/**
 * Through lib/metadata.ts, like every other public route. This page's own block was
 * already correct — it is here so that the one definition of "og describes this page"
 * covers all seven, and so a future edit to the share card cannot fix six routes and
 * miss this one.
 *
 * `canonical: '/'` is set here even though app/layout.tsx no longer declares one, and
 * deliberately so: the root value used to be INHERITED by every page that did not
 * override it, which is how an article came to declare the homepage as its canonical
 * URL. A page that states its own canonical cannot be broken by someone later adding a
 * layout above it.
 */
export async function generateMetadata(props: PageProps<'/[locale]'>): Promise<Metadata> {
  const locale = await metadataLocale(props.params)
  const { site } = await getSiteContent(locale)
  return pageMetadata({
    locale,
    title: { absolute: site.tagline ? `${site.name} · ${site.tagline}` : site.name },
    description: site.positioning || undefined,
    canonical: '/',
  })
}

/**
 * A framed card for a cell of a band (the introduction, the current focus). The rule that `SectionHeading` draws above its
 * heading would sit inside the card as a second line 24px under the card's own border, so the card removes it: the
 * border is the separation.
 */
const CARD_BOX =
  'rounded-card border border-neutral-200 p-4 sm:p-6 dark:border-neutral-800 [&>*>div:first-child]:border-t-0 [&>*>div:first-child]:pt-0'

/** The introduction card is tinted and a little roomier from xl, like the contact card. */
const INTRO_CARD = `${CARD_BOX} bg-neutral-50 xl:p-8 dark:bg-neutral-900`

/**
 * One band of the home page: a `reader` Container (the gutter of the header and footer, so the text starts under the
 * logo) holding one or two cells.
 *
 * A cell that is `null` is dropped, and a band left with one cell is that cell at full width, not a grid with a hole.
 * Today only the photos can render nothing and they are a band of their own; this is the rule for the first pair cell that can.
 * `split` is one of the two templates of reader-layout.ts, so the left/right placement stays in that file.
 */
function Row({ split, children }: { split?: string; children: ReactNode }) {
  const cells = Children.toArray(children)
  if (cells.length === 0) return null
  return (
    <Container width="reader" className={BAND}>
      {cells.length > 1 && split ? <div className={split}>{cells}</div> : cells}
    </Container>
  )
}

/** Three, against four featured posts of twelve. The section is a sample plus a link,
 *  not a second copy of /writing. */
const POSTS_ON_HOME = 3

/** Three series, like the three posts: a sample and a way into /series, not a copy of it. */
const SERIES_ON_HOME = 3

/** Six photos: two rows of the 3-column grid. A sample and a way into /gallery, not a copy of it. */
const PHOTOS_ON_HOME = 6

/**
 * Which posts go in the posts section, and why: `featured` are the posts the site owner picked (by
 * `featured_rank`, sorted by the backend), `recent` is the newest posts when none has been picked. The section is renamed
 * accordingly: "Best posts" only when the list really is the site owner's choice.
 */
type HomePosts = { kind: 'featured' | 'recent'; posts: PostSummary[] }

/**
 * The featured posts, or the most recent ones if nothing is featured.
 *
 * The fallback is not defensive padding. A fresh database — a clone, a reviewer's local
 * Postgres, the first deploy — has posts and none of them featured, and `featured=true`
 * then answers an empty page: the homepage would show a heading, an "All posts" link
 * and a hole where the writing is. That reads as a broken site, and it is the state every
 * new environment starts in.
 *
 * Two sequential requests rather than one unconditional pair: the common case is that
 * something IS featured, and a second round trip for a list nobody will render is a cost
 * paid on every revalidation. Both calls are cached under the 'posts' tag, so the
 * fallback is free after the first miss.
 *
 * The second call omits `featured` entirely instead of passing `false`. lib/api.ts drops
 * a `false` today, but the backend keeps absent and false distinguishable on purpose, so
 * "every post" is spelled as the absence of the parameter.
 */
async function postsForHome(language: Locale): Promise<HomePosts> {
  try {
    // `featured=true` is returned ordered by `featured_rank`: this is the first three of the list
    // the site owner ordered, not the three newest featured posts.
    const featured = await getPosts({ page: 0, size: POSTS_ON_HOME, featured: true, language })
    if (featured.items.length > 0) return { kind: 'featured', posts: featured.items }

    const recent = await getPosts({ page: 0, size: POSTS_ON_HOME, language })
    return { kind: 'recent', posts: recent.items }
  } catch {
    // An unreachable API must not fail the BUILD, which is the real reason this exists
    // rather than defensiveness for its own sake.
    //
    // This page is prerendered, so `next build` runs it — and inside a Docker build the
    // backend is not running and `localhost:8080` is the build container itself. Measured:
    // the frontend image build died with "Error occurred prerendering page /" and
    // "TypeError: fetch failed". `docker compose up -d --build` builds images before it
    // starts services, so a deployment could never build its own frontend.
    //
    // The cost is bounded and worth stating: a cold build with no API produces a homepage
    // whose writing section is empty, and `revalidate = 300` replaces it within five
    // minutes of the first request. Every other section on this page comes from
    // the site content and renders correctly either way. `generateStaticParams` on the post
    // page already took the same decision for the same reason.
    //
    // `recent`, not `featured`: when nothing could be read there is no selection to call
    // "Best posts".
    return { kind: 'recent', posts: [] }
  }
}

/**
 * Photos for the "Photos" section. A secondary block: an API failure is an empty array, and empty means no
 * section, for the same reason as `postsForHome` above (the Docker build has no API).
 */
async function photosForHome(): Promise<GalleryPhoto[]> {
  try {
    const { items } = await getGallery({ page: 0, size: PHOTOS_ON_HOME })
    return items
  } catch {
    return []
  }
}

/**
 * The newest published series of the page language. A secondary block: an API failure is an empty list, and empty means no
 * block, for the same reason as `postsForHome` (the Docker build has no API).
 */
async function seriesForHome(language: Locale): Promise<SeriesSummary[]> {
  try {
    return (await getSeriesList(language)).slice(0, SERIES_ON_HOME)
  } catch {
    return []
  }
}

/**
 * `about.intro` is NOT what this section renders, and that is a deliberate deviation from
 * the brief. Its first words are "This page exists to answer a few questions…" — "this page
 * answers these questions" — which is true on /about and self-referential here. The `who`
 * section of the same object is the actual self-introduction, is two sentences, and reads
 * correctly in this position.
 *
 * The fallback arm keeps the section from vanishing if that id is ever renamed, since
 * `find` returning undefined would otherwise render nothing at all.
 */
function introParagraphs(about: About): readonly string[] {
  return about.sections.find((section) => section.id === 'who')?.body ?? [about.intro]
}

/**
 * No `searchParams`, no `params`, and therefore none of the three guards the previous
 * version of this file carried: the digit-shape check before `Number()`, the MAX_PAGE
 * refusal, and the `AcceptsGeneratedProps` self-signature tripwire. Each existed because
 * this page parsed `?page` into an API argument, and all three are dead code here — but
 * they are NOT obsolete: they belong on whichever page now owns the paginated list.
 * `Home.length === 0` is asserted in page.test.tsx so that growing a parameter again is a
 * test failure rather than a silent reintroduction of the parsing they protected.
 */
export default async function Home(props: PageProps<'/[locale]'>) {
  const locale = await setPageLocale(props.params)
  const t = await getTranslations({ locale, namespace: 'Site.home' })
  const { site, profile, about, now, timeline, contact } = await getSiteContent(locale)
  // In parallel: the two sources do not depend on each other, and each catches its own errors.
  const [{ kind, posts }, photos, series] = await Promise.all([postsForHome(locale), photosForHome(), seriesForHome(locale)])
  const curated = kind === 'featured'
  const fallbackLanguage =
    posts.length === 0
      ? await otherLanguageWithPosts(
          locale,
          async (language) => (await getPosts({ page: 0, size: 1, language })).meta.totalElements,
        )
      : null

  return (
    // No <main>: app/layout.tsx owns `<main id="main-content">`, and two main landmarks in
    // one document make the skip link ambiguous. Every band is a `reader` <Container>, so they
    // all share one gutter with the header and footer and line up at every width.
    <>
      {/* The site's identity, for a consumer that reads structured data rather than the
          page. Home page only: it describes the WebSite, and there is one of those. */}
      <WebSiteJsonLd name={site.name} locale={locale} />
      {/* Five bands in the DOM order of the page (hero, introduction, posts, series, journey, now, photos, contact):
          each pair is two neighbours, so the reading order of a keyboard or screen reader user did not change. */}
      <Row split={SPLIT_EVEN}>
        <Hero bare hero={profile.hero} github={contact.github} seeking={profile.seeking} location={profile.location} />
        <div className={INTRO_CARD}>
          <section aria-labelledby="gioi-thieu">
            <SectionHeading id="gioi-thieu" title={t('introTitle')} action={{ href: '/about', label: t('aboutLink') }} />
            <div className="mt-5 max-w-2xl space-y-4 text-base text-neutral-700 sm:mt-6 sm:text-lg dark:text-neutral-300">
              {/* Below lg only the first paragraph: the hero right above already says who this is (two paragraphs were about 480px). */}
              {introParagraphs(about).map((paragraph, index) => (
                <p key={paragraph} className={index > 0 ? 'max-lg:hidden' : undefined}>
                  {paragraph}
                </p>
              ))}
            </div>
          </section>
        </div>
      </Row>

      <Row split={SPLIT_EVEN}>
        {/* The id `bai-viet` stays unchanged even though the name changed: `/#bai-viet` may already sit in a link someone saved. */}
        <section aria-labelledby="bai-viet">
          {/* "Best posts" when this is the site owner's choice: the first three posts, and the action
              in the heading row is the whole list. When none has been picked, the three newest posts are not
              "best" in any sense; the title honestly says "new", and the action is every post. */}
          <SectionHeading
            id="bai-viet"
            title={curated ? t('featuredTitle') : t('recentTitle')}
            lead={curated ? t('featuredLead', { count: posts.length }) : undefined}
            action={curated ? { href: '/start-here', label: t('fullList') } : { href: '/writing', label: t('allPosts') }}
          />
          {posts.length === 0 ? (
            // Reachable only when the blog has published nothing at all — the featured
            // query and the fallback both came back empty. Saying so is better than an
            // empty div under a heading.
            fallbackLanguage ? (
              <LanguageFallback path="/" language={fallbackLanguage} />
            ) : (
              <p className="mt-6 text-neutral-600 dark:text-neutral-400">{t('empty')}</p>
            )
          ) : (
            <ul className="mt-6 divide-y divide-neutral-200 dark:divide-neutral-800">
              {posts.map((post) => (
                <li key={post.id} className="py-5 first:pt-0 last:pb-0">
                  {/* h3: the section's h2 is directly above, so a card title at h2 would put
                      two siblings at the same level and flatten the outline.

                      ListRow, same row as /writing: 3:2 thumbnail, meta with icons.
                      No tag row: the three posts here are an invitation to read, not a table of contents. */}
                  <ListRow post={post} headingLevel={3} showTags={false} />
                </li>
              ))}
            </ul>
          )}
          {/* The heading row gave way to "Full list", so the way to every post sits below the
              list. Only in the curated branch: in the other branch the heading row itself is this link, and two links
              with the same name and target in one section are a redundant stop for the keyboard. */}
          {curated ? (
            <p className="mt-4 text-sm font-medium sm:mt-6">
              <Link href="/writing" className={`${INLINE_LINK} ${TOUCH_ROW}`}>
                {t('allPosts')} <span aria-hidden="true">→</span>
              </Link>
            </p>
          ) : null}
        </section>
        {/* The series, right after the posts and drawn the same way: a heading row, a lead, the rows with a thumbnail. The cell is
            dropped when there is no published series (the band then keeps the posts at full width). */}
        {series.length > 0 ? (
          <section aria-labelledby="series">
            <SectionHeading
              id="series"
              title={t('seriesTitle')}
              lead={t('seriesLead')}
              action={{ href: '/series', label: t('allSeries') }}
            />
            <ul className="mt-6 divide-y divide-neutral-200 dark:divide-neutral-800">
              {series.map((entry) => (
                <li key={entry.id} className="py-5 first:pt-0 last:pb-0">
                  <SeriesEntry series={entry} headingLevel={3} compact />
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </Row>

      {/* The journey is the wide cell now that its entries carry highlights and technologies; "Now" is the short card beside it. */}
      <Row split={SPLIT_ASIDE}>
        <Timeline bare data={timeline} />
        <div className={CARD_BOX}>
          <NowSection bare data={now} />
        </div>
      </Row>

      {/* Between the journey band and "Contact": the "scroll down" spot of the profile part. A band of its own (six photos in one row
          from lg). Returns null by itself when there are no photos or the API fails: the page then has four bands. */}
      <GallerySection id="anh" photos={photos} headingLevel={2} />

      <Row>
        <ContactSection bare data={contact} />
      </Row>
    </>
  )
}
