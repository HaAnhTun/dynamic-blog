import type { Metadata } from 'next'
import { OG_SIZE } from '@/components/og/ShareCard'
import { DEFAULT_LOCALE, ogLocale, type Locale } from '@/i18n/config'
import { languageAlternates, localePath } from '@/lib/locale-path'
import { mediaPath } from '@/lib/media'
import { FEED_PATH, OG_IMAGE } from '@/lib/site'
import { getSiteContent } from '@/lib/site-content'
import type { MediaRef } from '@/lib/types'

/**
 * Page metadata for every public route. One definition, because the five routes that did
 * not write an `openGraph` block were advertising the HOMEPAGE, and the two that did were
 * losing `og:locale` and `og:site_name`. Same Next rule, failing in opposite directions.
 *
 * ## The rule
 *
 * `mergeMetadata` walks the route tree and, for a nested object like `openGraph`, REPLACES
 * the inherited value with the segment's own — it does not merge the two. Read in
 * node_modules/next/dist/lib/metadata/resolve-metadata.js:169 (`for (const key_ in metadata)`)
 * and the `case 'openGraph'` arm below it. So a page either restates the whole block or
 * inherits the whole block, and both halves of the problem are that one sentence:
 *
 *   measured on the running dev server, before this module existed
 *     /writing, /writing?page=1, /categories/*, /tags/*, /search, /search?q=
 *       og:title = "<site name>"      (the homepage's)
 *       og:url   = "http://localhost:3000"  (the homepage's)
 *     /about, /posts/*
 *       og:locale, og:site_name  -> absent entirely
 *     /, /writing, /about, /categories/*
 *       twitter:title = "<site name>" (the root's; only /posts/* set its own)
 *
 * A share of a category page rendered the homepage's card. Nothing on the site shows it,
 * no test saw it, and it is only visible in somebody else's timeline — the same class of
 * failure the note on `OG_IMAGE` in lib/site.ts describes.
 *
 * ## Why the caller passes a canonical rather than a path
 *
 * `og:url` must equal the canonical URL, and the three routes that paginate or search do
 * NOT derive one from the other the same way:
 *
 *   /writing?page=0        canonical /writing          (page 0 collapses)
 *   /writing?page=1        canonical /writing?page=1   (every other page is its own URL)
 *   /search?q=queue        canonical /search           (title is query-specific, URL is not)
 *
 * Those rules are product decisions that live in the route — each is documented at its own
 * call site and pinned by its own test. Taking the already-decided canonical means this
 * module needs no branch for any of them, and `og:url === alternates.canonical` is true by
 * construction rather than by agreement between two expressions. Both strings are relative
 * and Next resolves each against `metadataBase` (app/layout.tsx), so the origin is still
 * configured exactly once, in lib/site.ts.
 *
 * ## Deliberately not here
 *
 * `robots`. It is a per-route product decision, not a presentation one, and keeping it out
 * means this helper can never make the bare /search noindex — the route expresses the
 * difference as "no key at all" (inherit the site default) versus spreading one in
 * alongside the helper's result. A `robots` parameter would invite the opposite.
 *
 * `twitter.images`. Measured on the running site: every route already emits a
 * `twitter:image` equal to its `og:image` without any route declaring one, so restating it
 * would be a second spelling of a value Next derives correctly.
 */

/**
 * Narrow on purpose rather than `Partial<OpenGraph>`: Next picks the legal field list from
 * `og.type` (resolve-opengraph.js), so `publishedTime`/`modifiedTime` only mean anything
 * under `'article'`. A wider type would let a listing page declare an article's timestamps
 * and emit nothing, silently.
 */
export type OpenGraphExtras = { type?: 'website' } | { type: 'article'; publishedTime?: string; modifiedTime?: string }

export type PageMetadataInput = {
  /**
   * A plain string goes through `title.template` in app/layout.tsx and renders as
   * `… — <site name>`. `{ absolute }` opts out, which is what the homepage needs.
   * Either way `og:title` is the page's OWN title with no brand suffix, matching what
   * /about and the article page already emitted.
   */
  title: string | { absolute: string }
  /**
   * `string | undefined`, and the key is ALWAYS set on the result — never conditionally
   * spread. The difference is load-bearing and was read out of Next's source rather than
   * guessed: `resolve-metadata.js:244` is `case 'description': metadata[key] ?? null`, so a
   * present-but-undefined key resolves to null and `metadata.js:261` (`if
   * (metadata.description)`) then emits no tag — which is what an article with no excerpt
   * wants. An ABSENT key is never visited by the `for (const key_ in metadata)` loop at
   * :169, so the inherited value survives, and `inheritFromMetadata` (:603-611) copies it
   * into og:description and twitter:description as well. Omitting the key would therefore
   * make a post without an excerpt advertise the homepage's positioning line as its own
   * description — the same failure, re-created on the description axis.
   */
  description?: string
  /**
   * Relative and WITHOUT a locale prefix, e.g. '/writing?page=1'. Becomes `alternates.canonical` AND `og:url` once the locale
   * prefix is added (lib/locale-path.ts).
   */
  canonical: string
  /** The locale of the page; the default locale when absent. Drives the canonical, hreflang, `og:locale` and the feed link. */
  locale?: Locale
  /**
   * The language of the content the page shows (a post): its canonical and `og:locale` follow it whatever locale the URL was
   * opened under, and it declares no hreflang alternates except the explicit `languages` below.
   */
  contentLanguage?: Locale
  /** Explicit hreflang map of a page with `contentLanguage` (a post and its published translations); absent = none. */
  languages?: Record<string, string>
  og?: OpenGraphExtras
  /**
   * Where `og:image` comes from.
   *
   * `'site'` (the default) restates the site-wide card from app/opengraph-image.tsx. It has
   * to be restated: the file convention only fills `openGraph.images` when the segment did
   * not declare the key itself — resolve-metadata.js:148-149, `if (openGraph &&
   * !source?.openGraph?.hasOwnProperty('images'))` — and a page that sets any `openGraph`
   * at all without `images` would otherwise share a blank 1200x630 panel under a
   * `summary_large_image` card.
   *
   * `'colocated'` OMITS the key so that a colocated `opengraph-image.tsx` in the route's own
   * folder supplies the image instead. It is the same `hasOwnProperty` gate read the other
   * way round, and it is how /posts/[slug] gets a card carrying its own title. The key must
   * be genuinely absent — `images: undefined` satisfies `hasOwnProperty` and would suppress
   * the file just as effectively as a value.
   *
   * A specific image (`{url, width, height, alt}`): a post's cover image. An image the author
   * picked beats the generated text card — the key is present, so the `opengraph-image.tsx` next to the page
   * gives way, through the same `hasOwnProperty` gate as above. `url` is relative (`mediaPath()`), like OG_IMAGE:
   * metadataBase makes it absolute, the origin is configured in one place. The size comes along so share
   * platforms can lay out the frame before the image loads. alt is decided by the caller (post page: the
   * description the author typed, else the post title — same rule as the image at the top of the post in PostCover).
   */
  image?: 'site' | 'colocated' | OgImage
  /** The page's own feeds (category, series, tag), advertised next to the shared feed. */
  feed?: FeedLink
}

/** A specific share image (`og:image` plus `og:image:width/height/alt`). */
export type OgImage = { url: string; width: number; height: number; alt: string }

/** An RSS feed: a relative path (metadataBase makes it absolute) and the title shown to someone choosing a feed. */
export type FeedLink = { path: string; title: string }

/**
 * Name of an RSS channel, also the `title` of the autodiscovery link to it: the shared feed is the site name, an own feed
 * puts the category name in front. The feed route and the page call this same function, so the name when choosing and
 * when already subscribed match.
 */
export async function feedTitle(locale: Locale, scope?: string): Promise<string> {
  const { site } = await getSiteContent(locale)
  return scope ? `${scope} — ${site.name}` : site.name
}

/**
 * The site's shared share card (app/opengraph-image.tsx), with size and alt.
 *
 * The earlier version was just the `OG_IMAGE` string, so every non-post page (/, /writing, /start-here,
 * /series, /topics, /archive, /gallery…) emitted og:image without og:image:width/height/alt, while
 * each post's card had all of them. Facebook needs the size pair to draw the image on the very first share. Same
 * `OG_SIZE` and the same alt sentence the card is drawn with (name and tagline of the site content of the locale).
 */
export async function siteOgImage(locale: Locale): Promise<OgImage> {
  const { site } = await getSiteContent(locale)
  return {
    url: OG_IMAGE,
    width: OG_SIZE.width,
    height: OG_SIZE.height,
    alt: site.tagline ? `${site.name} — ${site.tagline}` : site.name,
  }
}

/**
 * Width of the cover-image version used as og:image, and its quality. 1200 is in next/image's default
 * `deviceSizes` and 75 is Next 16's default `qualities`, so `/_next/image` accepts both;
 * a value outside the list is a 400.
 */
const COVER_OG_WIDTH = 1200
const COVER_OG_QUALITY = 75

/**
 * og:image of a post with a cover image: a ~1200px version via `/_next/image`, not the original file.
 *
 * The original is up to 2400px and up to 4 MiB; some link-preview crawlers (WhatsApp is often cited with
 * about 300 KB) skip or fail on images that large. The same image through `/_next/image?…&w=1200&q=75`
 * with `Accept: *\/*` as crawlers send it is a ~16 KB JPEG (measured on the QA stack). Relative like OG_IMAGE:
 * metadataBase makes it absolute.
 *
 * The size is declared for the downscaled version: next/image does not upscale, so an image narrower than 1200px keeps
 * its own width. The post's JSON-LD `image` is still the original file (ArticleJsonLd): that is the image the author
 * picked, at an immutable URL under /media/.
 */
export function coverOgImage(cover: Pick<MediaRef, 'fileName' | 'width' | 'height'>, alt: string): OgImage {
  const width = Math.min(COVER_OG_WIDTH, cover.width)
  return {
    url: `/_next/image?url=${encodeURIComponent(mediaPath(cover))}&w=${COVER_OG_WIDTH}&q=${COVER_OG_QUALITY}`,
    width,
    height: Math.round((cover.height * width) / cover.width),
    alt,
  }
}

/**
 * og:image of a post without a cover image: its own share card, drawn by app/api/og/posts/[slug]/route.tsx.
 *
 * Relative, like the others (metadataBase makes it absolute). `version` busts the cache of the unfurlers when the post changes: the
 * route answers with an immutable cache header, so an edit that changed the title must change the URL.
 */
export function postCardOgImage(slug: string, alt: string, version?: string): OgImage {
  const v = version === undefined ? NaN : Date.parse(version)
  return {
    url: `/api/og/posts/${encodeURIComponent(slug)}${Number.isNaN(v) ? '' : `?v=${v}`}`,
    width: OG_SIZE.width,
    height: OG_SIZE.height,
    alt,
  }
}

export async function pageMetadata(input: PageMetadataInput): Promise<Metadata> {
  const { title, description, og, image = 'site', feed, locale = DEFAULT_LOCALE, contentLanguage, languages } = input

  // The content language decides which locale's URL is the page's own address; everything else follows from that one value.
  const canonical = localePath(input.canonical, contentLanguage ?? locale)
  const { site } = await getSiteContent(locale)
  const feedPath = localePath(FEED_PATH, locale)

  // Composed here rather than left to inherit: `title.template` is not applied to
  // `openGraph.title` (measured — /about emits a bare "About"), so a page that sets a
  // document title and no og:title keeps whatever the root wrote, which is the site name.
  const ogTitle = typeof title === 'string' ? title : title.absolute

  // Absent when the route owns its image, present otherwise. See `image` above — spreading
  // nothing is the only way to leave `hasOwnProperty('images')` false.
  const images = image === 'colocated' ? {} : image === 'site' ? { images: [await siteOgImage(locale)] } : { images: [image] }

  return {
    title,
    description,
    alternates: {
      canonical,
      // Only a page that exists in every locale: a hreflang that points at a page that does not exist is worse than none.
      ...(contentLanguage ? (languages ? { languages } : {}) : { languages: languageAlternates(input.canonical) }),
      /**
       * `<link rel="alternate" type="application/rss+xml">`, which is how a browser
       * extension or a reader discovers the feed from any page.
       *
       * Here and not on the root layout, and that is the interesting part: `alternates` is
       * one of the nested objects Next REPLACES rather than merges, and every public page
       * sets its own `canonical` — so a `types` declared once on the root layout would be
       * dropped by all eight of them and survive only on /admin and the 404 page. Exactly
       * backwards. Declaring it here means it lands on every page that has metadata worth
       * having, and on no page that does not.
       *
       * A page with its own feed emits two links, the shared feed first, each with its own title so the reader can choose;
       * other pages keep exactly one string as before.
       */
      types: {
        'application/rss+xml': feed
          ? [
              { url: feedPath, title: await feedTitle(locale) },
              { url: localePath(feed.path, locale), title: feed.title },
            ]
          : feedPath,
      },
    },
    openGraph: {
      ...images,
      locale: ogLocale(contentLanguage ?? locale),
      siteName: site.name,
      type: 'website',
      // Before `title`/`url`/`description` on purpose: a caller may override `type` and add
      // the article timestamps, but must not be able to clobber the three fields this
      // module exists to keep correct.
      ...og,
      title: ogTitle,
      description,
      url: canonical,
    },
    twitter: {
      card: 'summary_large_image',
      title: ogTitle,
      description,
    },
  }
}
