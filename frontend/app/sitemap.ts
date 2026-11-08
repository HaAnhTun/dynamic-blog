import type { MetadataRoute } from 'next'
import { otherAuthor, postAlternates, postLanguage } from '@/components/site/ArticleJsonLd'
import { bucketByMonth } from '@/lib/discovery'
import { DEFAULT_LOCALE, LOCALES, type Locale } from '@/i18n/config'
import { absoluteLocaleUrl } from '@/lib/locale-path'
import { isProfileSlug, profilePath } from '@/lib/profile'
import { fetchAllPublishedPosts } from '@/lib/published-posts'
import { getSeriesList } from '@/lib/series'
import { getSiteContent } from '@/lib/site-content'
import { getStats } from '@/lib/stats'
import { getCategories, getTags } from '@/lib/taxonomy'
import type { PostSummary } from '@/lib/types'

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
 * request is near zero — the page is otherwise built from content/*.ts constants. The
 * benefit is that a deploy is correct from the first request instead of from the first
 * revalidation.
 */
export const dynamic = 'force-dynamic'

/**
 * ...and its DATA read per request too (V6 P3-8). `force-dynamic` alone did not do that.
 *
 * Every source below asks for `revalidate: 300` under a tag that only the admin's Server
 * Actions clear (lib/api.ts, lib/taxonomy.ts, lib/series.ts, lib/stats.ts). Next's fetch lets
 * `force-dynamic` decide only for a fetch that set no cache option of its own
 * (`noFetchConfigAndForceDynamic` in next/dist/server/lib/patch-fetch.js) — although the
 * route-segment docs call the two settings equivalent — so those reads kept their five
 * minutes. A post published by seed/push.py or straight through the API was missing from the
 * sitemap for up to five minutes, and for longer in practice: a crawler fetches this URL
 * rarely, and a rare fetch of a stale entry is answered with the stale copy while Next
 * refreshes it in the background.
 *
 * `force-no-store` sets the `revalidate` of every fetch this route makes to 0 before the data
 * cache is consulted. The wrapper route Next generates for this file re-exports it with
 * `dynamic` (Turbopack: `export * from`; webpack: `createReExportsCode`). The price is one
 * backend request per source per sitemap fetch — five, plus one per extra hundred posts.
 * app/sitemap.test.ts runs the real helpers through Next's own fetch to show both halves:
 * the old list with `force-dynamic` alone, the new one with this.
 *
 * Both exports belong to the caching model without Cache Components: enabling
 * `cacheComponents` turns them into a build error (migrating-to-cache-components.md), and
 * this route's freshness would need deciding again then.
 */
export const fetchCache = 'force-no-store'

/**
 * The sitemap.
 *
 * The rule this file is written to: EVERY URL IN HERE MUST ANSWER 200. A sitemap is a
 * set of promises to a crawler, and a promise that 404s costs more than silence — it
 * burns crawl budget and, repeated, is read as a quality signal about the whole site.
 * So nothing is listed on a guess: the post slugs come from the API, the category and
 * tag slugs from the taxonomy endpoints, the series slugs from the series list, the
 * archive years from the posts themselves, /gallery from the stats endpoint saying there
 * is something in it, and the static paths are the ones that have route files under app/.
 *
 * NO `changeFrequency` AND NO `priority`, on purpose. Both are advisory and both are
 * ignored by Google (publicly, since 2023). A fabricated ordering — 1.0 for the home
 * page, 0.8 for an article, 0.5 for an archive — looks like information and is not: the
 * numbers would be invented here, not measured anywhere. `lastModified` is the only
 * hint in the format that carries real data, so it is the only one this file emits, and
 * only where the date is actually known (see `newest` below).
 */

/**
 * The static routes, each of which has a route file under app/.
 *
 * Not a guess: app/sitemap.test.ts asserts that a route file exists for every path in
 * this array, and every URL here was fetched against the running dev server — all five
 * answer 200. `/search` was a 404 while this file was being written (it is owned by
 * another agent in this run, linked from the header on every page, and named in the
 * brief) and landed before it shipped; the test is what makes that visible either way,
 * rather than the sitemap quietly promising a page that does not exist.
 *
 * The four pages added with series and the archive — /start-here, /series,
 * /topics, /archive — answer 200 even when empty ("No posts picked yet.", "No series yet.", …),
 * so they are listed unconditionally, like /writing. The order is the
 * reading order of the header and the footer.
 *
 * /gallery is NOT here: it is listed only when the gallery has photos (end of the function).
 */
const STATIC_PATHS = [
  '/',
  '/writing',
  '/start-here',
  '/series',
  '/topics',
  '/archive',
  '/case-studies',
  '/about',
  '/search',
] as const

type StaticPath = (typeof STATIC_PATHS)[number]

/**
 * The years with posts, newest first, each with its publish dates.
 *
 * Through `bucketByMonth` of lib/discovery.ts — exactly the function the /archive page uses to decide which year has a
 * page — and not by reading the year here: the year is computed in UTC (matching the date printed on a post), and a post with no
 * readable date belongs to no year. Two different ways of counting years is how the sitemap would promise a
 * `?year` that the page answers with a 404.
 */
function archiveYears(posts: PostSummary[]): { year: number; dates: (string | undefined)[] }[] {
  const years: { year: number; dates: (string | undefined)[] }[] = []
  for (const bucket of bucketByMonth(posts)) {
    let entry = years.find((candidate) => candidate.year === bucket.year)
    if (!entry) {
      entry = { year: bucket.year, dates: [] }
      years.push(entry)
    }
    // The year is still the publish year (bucketByMonth groups by publishedAt); the DATE of a year page is the latest
    // change among the posts of that year, because the page lists their titles and summaries.
    entry.dates.push(...bucket.posts.map(modifiedOf))
  }
  return years.sort((a, b) => b.year - a.year)
}

/**
 * The post list comes from lib/published-posts.ts, which app/feed.xml/route.ts also uses.
 * It used to be three constants and a paging loop right here; it moved out when the feed
 * arrived, because two independent answers to "which articles exist" is how a sitemap and
 * a feed come to disagree silently. The `isPublished` filter and the slug de-duplication
 * moved with it.
 */

/**
 * The most recent of a set of ISO timestamps, or undefined if none is usable.
 *
 * `Date.parse` rather than a string comparison. Lexicographic order happens to be
 * correct for the `...Z` instants this API returns today, and silently stops being
 * correct the first time one carries an offset (`+07:00`) instead. The original string
 * is returned untouched — reformatting a timestamp here could only introduce a timezone
 * bug, and the sitemap format wants ISO-8601 anyway.
 */
function newest(dates: readonly (string | null | undefined)[]): string | undefined {
  let best: string | undefined
  let bestTime = -Infinity

  for (const date of dates) {
    if (!date) continue
    const time = Date.parse(date)
    if (!Number.isFinite(time)) continue
    if (time > bestTime) {
      bestTime = time
      best = date
    }
  }

  return best
}

/**
 * When a post last changed: the newer of `updatedAt` and `publishedAt` (V6 P1-8), or undefined
 * if neither is a usable date.
 *
 * `updatedAt` first, because it is the one that moves: publishedAt is set once on the first
 * publish and kept through every later edit, so a sitemap built on it told crawlers that an
 * edited article had not changed since the day it went out. The NEWER of the two rather than
 * updatedAt alone, because seeded and imported posts can carry an updatedAt older than their
 * publish date, and the page cannot have changed before it existed.
 *
 * Defensive on purpose. Listing summaries only carry `updatedAt` from V6, the dev backend keeps
 * serving the old shape until it is restarted, and lib/api.ts does not validate the JSON — so
 * the field may be absent, empty, unparseable or not a string at all. Each of those falls back
 * to publishedAt through `newest`, which drops what `Date.parse` cannot read; the `typeof`
 * guard is the part `newest` cannot do: `Date.parse` coerces a number to a string first, and
 * `Date.parse(2027)` is a valid date (the year), so a number would be emitted as the lastmod.
 */
function modifiedOf(post: PostSummary): string | undefined {
  const updatedAt = typeof post.updatedAt === 'string' ? post.updatedAt : undefined
  return newest([updatedAt, post.publishedAt])
}

/**
 * `{ lastModified }` or `{}`, never `{ lastModified: undefined }`.
 *
 * Next serialises the entry objects it is handed; an explicit `undefined` is the kind
 * of thing that becomes an empty `<lastmod></lastmod>` in a future version. Spreading
 * nothing cannot.
 */
function lastModifiedOf(date: string | undefined): { lastModified?: string } {
  return date ? { lastModified: date } : {}
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  /**
   * `/` becomes the bare origin — `https://example.com`, not `https://example.com/`.
   *
   * Measured on the running dev server, not assumed: the home page emits
   * `<link rel="canonical" href="http://localhost:3000"/>`, because Next resolves a canonical of '/' against
   * `metadataBase` and drops the trailing slash. A `<loc>` of `http://localhost:3000/` would therefore be a URL
   * whose own page declares a different canonical. Every crawler normalises the two at
   * the root, so this is cosmetic rather than a bug — but the whole point of this file
   * is that there is one spelling of each URL, and Next's own sitemap documentation
   * writes the home page the same way (`url: 'https://acme.com'`).
   *
   * Only at the root: `/writing/` and `/writing` are NOT equivalent, and every other
   * path here already has no trailing slash. The locale prefix comes from lib/locale-path.ts, the rule every other URL uses.
   */
  const url = absoluteLocaleUrl

  /**
   * THE API BEING DOWN MUST NOT FAIL THE BUILD.
   *
   * `next build` renders this route. If an unhandled rejection escaped, a backend that
   * is merely not running — the normal state of CI, and of any `docker build` that is
   * not sharing a network with the API — would fail the entire production build. A
   * sitemap holding only the static routes is a worse sitemap than a complete one and a
   * far better outcome than no deployable image.
   *
   * Each source is caught separately and in parallel: a taxonomy outage must not cost
   * the article URLs, which are the ones that matter. `Promise.all` over
   * already-caught promises therefore never rejects.
   *
   * One log line, after the fact, naming what was lost — not one per source and not one
   * per page of a paged fetch, which on a long outage would be noise that hides the
   * rest of the build output.
   *
   * `fallback` stands in for a failed source: an empty list for the four list sources, `null`
   * for the stats. "Unknown whether the gallery has photos" and "the gallery has 0 photos"
   * lead to the same result here (no /gallery), but the type says which one it was.
   */
  const failures: string[] = []
  const record =
    <T>(what: string, fallback: T) =>
    (error: unknown): T => {
      // One line per source even though the taxonomy is read once per locale.
      if (!failures.some((failure) => failure.startsWith(`${what} (`))) {
        failures.push(`${what} (${error instanceof Error ? error.message : String(error)})`)
      }
      return fallback
    }

  // The taxonomy is read per locale: a locale lists only the categories, tags and series that have a published post in it.
  const perLocale = <T>(read: (locale: Locale) => Promise<T[]>, what: string) =>
    Promise.all(LOCALES.map((locale) => read(locale).catch(record(what, [] as T[]))))
  const [posts, categoryLists, tagLists, seriesLists, stats] = await Promise.all([
    fetchAllPublishedPosts().catch(record('posts', [])),
    perLocale((locale) => getCategories(locale), 'categories'),
    perLocale((locale) => getTags(locale), 'tags'),
    perLocale((locale) => getSeriesList(locale), 'series'),
    getStats().catch(record('stats', null)),
  ])

  if (failures.length > 0) {
    // console.warn, not console.error: the build is not failing, and a CI log scanner
    // that greps for "error" should not be told it is.
    console.warn(
      `[sitemap] Incomplete: could not read ${failures.join(', ')}. ` +
        'The URLs built from them are left out; the static routes are still listed.',
    )
  }

  // Already filtered to PUBLISHED and de-duplicated by slug in lib/published-posts.ts.
  const published = posts
  const postsIn = (locale: Locale) => published.filter((post) => postLanguage(post) === locale)
  // A locale with no post of its own still has these list pages (they show the fallback), dated by the newest change of any post.
  const latestPostIn = (locale: Locale) => newest(postsIn(locale).map(modifiedOf)) ?? newest(published.map(modifiedOf))

  /**
   * Every URL is collected as a path in ONE locale. A page that exists in every locale is added once per locale, each listing the
   * others as hreflang alternates; a page that exists in some locales only (a post, a category with posts in one language) is
   * promised in those and lists alternates only among them: an hreflang to a page that does not exist is worse than none.
   */
  type Entry = { path: string; locale: Locale; lastModified?: string; languages?: Record<string, string> }
  const entries: Entry[] = []

  /** hreflang of a page present in `locales`: nothing for a single locale, `x-default` only when the default locale has it. */
  const alternatesFor = (path: string, locales: readonly Locale[]): Record<string, string> | undefined => {
    if (locales.length < 2) return undefined
    const languages = Object.fromEntries(locales.map((locale) => [locale, url(path, locale)]))
    return locales.includes(DEFAULT_LOCALE) ? { ...languages, 'x-default': url(path, DEFAULT_LOCALE) } : languages
  }

  /** One entry per locale of `locales`; `dateIn` gives the lastmod of that locale's copy. */
  const add = (path: string, dateIn: (locale: Locale) => string | undefined, locales: readonly Locale[] = LOCALES) => {
    const languages = alternatesFor(path, locales)
    for (const locale of locales) {
      entries.push({ path, locale, ...lastModifiedOf(dateIn(locale)), ...(languages ? { languages } : {}) })
    }
  }
  const undated = () => undefined

  /**
   * `lastModified` on `/` and `/writing` is the date of the newest change to any post
   * (`modifiedOf`: a publish or an edit), which is a real measurement rather than a guess:
   * both pages are lists of posts — titles, excerpts, tags — so publishing or editing one
   * is what changes either; each locale's page lists its own language, so its date is the newest of those posts.
   * It is omitted when the post fetch failed or returned nothing —
   * an invented date would be worse than none, since `lastmod` is the one field in this
   * format a crawler actually weighs.
   *
   * The same holds for /archive and /topics: one is the posts by month (newest year), the
   * other the post counts per category and tag, and a post being published or edited is what
   * changes either. /series takes the newest date among the series themselves: that page
   * changes when a new part of some series is published (the series API has no edit date).
   *
   * /about and /search get no `lastModified` at all. Their content lives in
   * content/profile.ts, and the only honest date for them would be a git commit time
   * this route cannot see at runtime. `new Date()` — the obvious thing to write — would
   * claim every static page changed on every build, which trains a crawler to ignore
   * the field. Nor does /start-here: it is an order the owner sets by hand, re-ordering it
   * publishes nothing, so the newest post's date says nothing about it.
   */
  const seriesIn = (locale: Locale) => seriesLists[LOCALES.indexOf(locale)] ?? []
  const latestSeriesIn = (locale: Locale) => newest(seriesIn(locale).map((entry) => entry.latestPublishedAt))
  const staticDates: Partial<Record<StaticPath, (locale: Locale) => string | undefined>> = {
    '/': latestPostIn,
    '/writing': latestPostIn,
    '/archive': latestPostIn,
    '/topics': latestPostIn,
    '/series': latestSeriesIn,
  }

  for (const path of STATIC_PATHS) {
    add(path, staticDates[path] ?? undated)
  }

  /**
   * /gallery only when the stats say there are photos. An empty gallery is still a 200 page,
   * but a thin one — a title and "No photos yet." — not worth inviting a crawler.
   * Failing stats mean not knowing, and what is not known is not promised.
   *
   * No `lastModified`: the public API does not return the upload date, and `takenOn` is the date taken, not
   * the date the page changed.
   */
  if (stats && stats.galleryPhotos > 0) {
    add('/gallery', undated)
  }

  /**
   * Case studies: site content (getSiteContent never throws and falls back to the packaged defaults), so this loop has no
   * error branch. The default locale's list decides the URLs for every locale, like the other paths. No
   * `lastModified` — the only honest date for a page built from constants is the commit
   * time, which this route cannot read at run time; `lastVerified` in the content is the date the
   * measurements were rerun, not the date the page changed.
   */
  for (const study of (await getSiteContent(DEFAULT_LOCALE)).caseStudies) {
    add(`/case-studies/${encodeURIComponent(study.slug)}`, undated)
  }

  /**
   * One entry per post, at the URL of its own language. The alternates are its published translations, kept only when the
   * translation is itself in this list and lists the post back: the map is symmetric and never points at a page this sitemap
   * does not promise. A draft is never in the list, so it is never an alternate.
   */
  const listed = new Map(published.map((post) => [`${postLanguage(post)}/${post.slug}`, post]))
  const withMutualTranslations = (post: PostSummary): PostSummary => {
    const own = `${postLanguage(post)}/${post.slug}`
    const translations = (post.translations ?? []).filter((sibling) => {
      const other = listed.get(`${sibling.language}/${sibling.slug}`)
      return other !== undefined && (other.translations ?? []).some((back) => `${back.language}/${back.slug}` === own)
    })
    return { ...post, translations }
  }
  for (const post of published) {
    // encodeURIComponent, matching `postPath` in components/site/ArticleJsonLd.tsx.
    // Every slug is ASCII today, so this is a no-op; it is here so that a diacritic
    // slug produces the same string here, in the canonical tag and on the clipboard,
    // rather than three spellings of one article.
    const languages = postAlternates(withMutualTranslations(post), url)
    entries.push({
      path: `/posts/${encodeURIComponent(post.slug)}`,
      locale: postLanguage(post),
      ...lastModifiedOf(modifiedOf(post)),
      ...(languages ? { languages } : {}),
    })
  }

  /**
   * Author profiles: /u/<slug> of every author who is NOT the site owner and has a post in the published list above —
   * never a reader (profiles are noindex), never the site owner (the profile is /about). The date is the latest change
   * (`modifiedOf`) among that person's posts: the profile page lists them.
   */
  const authorDates = new Map<string, (string | undefined)[]>()
  for (const post of published) {
    const slug = otherAuthor(post.author)?.profileSlug
    if (!isProfileSlug(slug)) continue
    authorDates.set(slug, [...(authorDates.get(slug) ?? []), modifiedOf(post)])
  }
  for (const [slug, dates] of authorDates) {
    add(profilePath(slug), () => newest(dates))
  }

  /**
   * Archive dates are derived from the posts in them, which is why this runs after the
   * post fetch rather than beside it: `/categories/kien-truc` changes when a post in
   * that category is published or edited and at no other time. A category whose posts could
   * not be fetched is still listed — the archive is a 200 page either way, and the taxonomy
   * list is what decides whether the URL exists — just without a date.
   *
   * A category, tag or series is listed in the locales whose list (read with that locale) contains it, i.e. the ones with a
   * published post in that language, and its date is the newest change among the posts of that language.
   *
   * By SLUG, never by name: a tag's name and slug differ whenever the name carries
   * diacritics, capitals or punctuation ("A lesson"/"bai-hoc", "CI/CD"/"ci-cd"), and
   * app/tags/[slug] reads the segment as a slug.
   */
  const addTaxonomy = (
    lists: { slug: string }[][],
    pathOf: (slug: string) => string,
    dateIn: (slug: string, locale: Locale) => string | undefined,
  ) => {
    const slugs = [...new Set(lists.flatMap((list) => list.map((entry) => entry.slug)))]
    for (const slug of slugs) {
      const locales = LOCALES.filter((locale) => lists[LOCALES.indexOf(locale)]?.some((entry) => entry.slug === slug))
      add(pathOf(slug), (locale) => dateIn(slug, locale), locales)
    }
  }
  addTaxonomy(
    categoryLists,
    (slug) => `/categories/${encodeURIComponent(slug)}`,
    (slug, locale) =>
      newest(
        postsIn(locale)
          .filter((post) => post.category?.slug === slug)
          .map(modifiedOf),
      ),
  )
  addTaxonomy(
    tagLists,
    (slug) => `/tags/${encodeURIComponent(slug)}`,
    (slug, locale) =>
      newest(
        postsIn(locale)
          .filter((post) => post.tags.some((postTag) => postTag.slug === slug))
          .map(modifiedOf),
      ),
  )

  /**
   * One URL per series and locale, dated by the `latestPublishedAt` the backend precomputes: the series detail page
   * changes when one of its parts is published. The backend only returns a series with at least one part
   * published in the asked language — exactly the set of slugs for which /series/[slug] is not a 404 there. Through `newest` even
   * for a single value: a date that cannot be read is dropped, not emitted verbatim.
   */
  addTaxonomy(
    seriesLists,
    (slug) => `/series/${encodeURIComponent(slug)}`,
    (slug, locale) => newest([seriesIn(locale).find((entry) => entry.slug === slug)?.latestPublishedAt]),
  )

  /**
   * `/archive?year=Y` for every year with posts EXCEPT the newest: the newest year is /archive itself, and
   * that page declares canonical `/archive` even when the URL has its `?year` (archive/page.tsx) —
   * listing it twice promises a URL that declares itself a duplicate. With one year `slice(1)` is empty:
   * no URL besides /archive.
   *
   * The years are those of each locale's own posts (the page lists one language), and a year is listed in the locales that have it.
   * The date of each year is the latest change (`modifiedOf`) among the posts published in that year: an older year's page
   * only changes when a post of that very year is published, edited or removed.
   */
  const yearsByLocale = LOCALES.map((locale) => archiveYears(postsIn(locale)).slice(1))
  const years = [...new Set(yearsByLocale.flatMap((list) => list.map(({ year }) => year)))].sort((a, b) => b - a)
  for (const year of years) {
    const locales = LOCALES.filter((locale) => yearsByLocale[LOCALES.indexOf(locale)]?.some((entry) => entry.year === year))
    add(
      `/archive?year=${year}`,
      (locale) => newest(yearsByLocale[LOCALES.indexOf(locale)]?.find((entry) => entry.year === year)?.dates ?? []),
      locales,
    )
  }

  /**
   * One entry per URL.
   *
   * Not defensive padding: `fetchAllPosts` makes several requests, and a post published
   * between page 0 and page 1 shifts the ordering under the cursor, so the same article
   * can legitimately appear on both pages. A duplicate `<url>` is not fatal to a
   * crawler but it is a sitemap that contradicts itself, and the first occurrence is
   * the one with the ordering the API intended.
   */
  const seen = new Set<string>()
  const unique = entries.filter((entry) => {
    const key = `${entry.locale} ${entry.path}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  /** The default-locale entries first, in the order above, then each other locale's. */
  return [DEFAULT_LOCALE, ...LOCALES.filter((locale) => locale !== DEFAULT_LOCALE)].flatMap((locale) =>
    unique
      .filter((entry) => entry.locale === locale)
      .map(({ path, lastModified, languages }): MetadataRoute.Sitemap[number] => ({
        url: url(path, locale),
        ...(lastModified ? { lastModified } : {}),
        ...(languages ? { alternates: { languages } } : {}),
      })),
  )
}
