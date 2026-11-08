import { DEFAULT_LOCALE, type Locale } from '@/i18n/config'
import { absoluteLocaleUrl, localePath } from '@/lib/locale-path'
import { absoluteUrl } from '@/lib/site'
import { githubUrl } from './ContactSection'

/**
 * Structured data that is not about one article, and the serialiser all of it shares.
 *
 * The serialiser moved here out of ArticleJsonLd.tsx when a second and third JSON-LD block
 * arrived. It is the one piece of this file that is genuinely dangerous, and a second
 * hand-rolled copy of it is the way that danger comes back.
 */

/**
 * `JSON.stringify` is not enough to put JSON inside an HTML `<script>`.
 *
 * The HTML tokenizer does not parse script contents as JSON. It scans for the literal
 * sequence `</script`, and the FIRST ONE ENDS THE ELEMENT. A post titled
 * `Read </script> before pasting` therefore closes the script early, dumps the rest of the
 * JSON into the page as text, and lets whatever followed be parsed as markup.
 * `JSON.stringify` escapes quotes, backslashes and control characters — it never escapes
 * `<` or `/` — so it does nothing at all about this.
 *
 * The fix is to emit each `<` as the JSON escape sequence for U+003C, which parses back to
 * `<` (so a crawler reads the real title) while the tokenizer never sees a `<` inside the
 * element. `>` and `&` go the same way: not because either can close the element, but
 * because `<!--` inside script data drives the tokenizer into its double-escaped states,
 * and escaping all three removes that whole family of problems rather than enumerating it.
 */
const SCRIPT_UNSAFE = /[<>&]/g

/**
 * A single backslash, built from its code point rather than written as one.
 *
 * The obvious spelling of the escape is a string literal containing a DOUBLED backslash,
 * and its correctness depends on that doubling surviving every editor, formatter and
 * copy-paste between here and the compiler. Halve it by accident and you get `'<'`, which
 * *is* the one-character string `"<"` — so the replace swaps `<` for `<`, compiles, lints,
 * typechecks, and escapes nothing. That precise mutation happened while this code was first
 * being written and the only thing that caught it was the test.
 * `String.fromCharCode(0x5c)` cannot be halved.
 */
const BACKSLASH = String.fromCharCode(0x5c)

export function toScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(
    SCRIPT_UNSAFE,
    (char) => `${BACKSLASH}u00${char.charCodeAt(0).toString(16).padStart(2, '0')}`,
  )
}

/** One JSON-LD block, escaped. Every structured-data component on the site goes through
 *  this rather than building its own `<script>`. */
export function JsonLd({ data }: { data: unknown }) {
  return (
    <script
      type="application/ld+json"
      // The only way to emit a script body from React: as a child it would be HTML-escaped
      // into `&quot;` and the JSON would not parse.
      dangerouslySetInnerHTML={{ __html: toScriptJson(data) }}
    />
  )
}

/**
 * The site itself, on the home page only.
 *
 * Just a name and a URL. That is the whole entity, and it is deliberate: `WebSite` is the
 * signal Google documents for deciding what to call a site in a result, and it has nothing
 * else about this blog that is both true and useful. No `alternateName` — there is not a
 * second real name for it.
 *
 * NO `potentialAction: { SearchAction }`. The SEO audit asks for it, in those words, to get
 * "the search box in sitelinks". That feature was retired globally in November 2024 and the
 * markup now drives nothing: adding it would be a claim about this site made for the
 * benefit of a consumer that no longer exists.
 *
 * `siteUrl()`, NOT `absoluteUrl('/')`. The two differ by one character and it matters:
 * lib/site.ts returns `${siteUrl()}/` for the root, with a trailing slash, while the home
 * page's own canonical tag and the sitemap's root `<loc>` are both the bare origin. Three
 * spellings of the home page, one of them in structured data, is precisely the drift the
 * long note at the top of ArticleJsonLd.tsx exists to prevent.
 */
export function WebSiteJsonLd({ name, locale = DEFAULT_LOCALE }: { name: string; locale?: Locale }) {
  return (
    <JsonLd
      data={{
        '@context': 'https://schema.org',
        '@type': 'WebSite',
        name,
        url: absoluteLocaleUrl('/', locale),
        inLanguage: locale,
      }}
    />
  )
}

/**
 * /about, as a profile page for one person.
 *
 * Google lists "an 'About Me' page on a blog site" as the case this type is for, so the type
 * is right. Every property is backed by something the page actually renders:
 *
 *  - `name` is the h1-adjacent identity the whole site carries.
 *  - `url` is this page, and the test asserts that path is a route this app serves.
 *  - `description` is `profile.role`, which describes the PERSON. `site.positioning`
 *    describes the site and is already the page's meta description; using it here would
 *    make a person out of a sentence about a blog.
 *
 *  - `sameAs` is the owner's GitHub profile, and only when `contact.github` is filled in.
 *    It is the machine-readable twin of the `rel="me"` GitHub link that Hero and the
 *    contact section render from the same field, so it claims nothing the site does not
 *    already claim. With the field null the key is absent, never `sameAs: []` — an empty
 *    list would be a claim of "no profiles anywhere". The email is not in it: `sameAs`
 *    takes URLs of pages about the person, and a mailto is not one.
 *
 * What is deliberately absent, because the data does not exist:
 *  - `jobTitle`: `profile.role` is written as a self-description, not a job title.
 *  - `image`, `address`, `birthDate`, `worksFor`: none of them is on the page.
 *
 * Only on /about, not on the home page: Google's requirement for this type is that the
 * page's primary focus is the one person, and `/` is a hero, a skills grid, a timeline and
 * a post list.
 *
 * `github` is a prop for the reason ContactSection gives: both branches must
 * be reachable from a test without mocking the content module.
 */
/**
 * One item of the structured list: the name the reader sees, and that page's relative URL.
 *
 * Relative, exactly the string the page gave to `pageMetadata({ canonical })` or `postPath()`: the URL
 * in the JSON-LD and the canonical of the target page are ONE string that goes through one builder, not two
 * expressions that happen to match. To make it absolute, change it here, in one place.
 */
export type JsonLdLink = {
  name: string
  url: string
  /** The locale of the target URL when it differs from the page's (a post always lives at its default-locale URL). */
  locale?: Locale
}

/**
 * The page's breadcrumb trail: post pages and series detail pages.
 *
 * The last item carries the page's own URL: Google allows omitting it, but with it the list does not
 * depend on the reader knowing where the page is. With no items there is no tag: an empty
 * BreadcrumbList is invalid, and a page with no trail is rightly silent.
 */
export function BreadcrumbJsonLd({ items, locale = DEFAULT_LOCALE }: { items: readonly JsonLdLink[]; locale?: Locale }) {
  if (items.length === 0) return null

  return (
    <JsonLd
      data={{
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: items.map((link, index) => ({
          '@type': 'ListItem',
          position: index + 1,
          name: link.name,
          item: absoluteLocaleUrl(link.url, link.locale ?? locale),
        })),
      }}
    />
  )
}

/**
 * An ordered listing page: /start-here, series detail, and the list
 * pages — /writing, category, tag, /archive, /topics, /series (SEO audit).
 *
 * A `CollectionPage` whose `mainEntity` is an `ItemList`: the page is the frame, the list is the main
 * content, and the order is the order the page shows — `position` comes from the place in the array,
 * not from a stored `featuredRank` or `position` (which may have gaps). Each item is `url` + `name`,
 * the "summary page pointing to detail pages" form that Google's ItemList guidance describes. Only
 * what the page is showing: secondary blocks (Discover, "other series") do not enter the list.
 *
 * `offset` is the number of items before this page in the whole list, for paginated pages: `?page=2`
 * of /writing shows posts 21 to 30, so its first item is position 21. Restarting from 1 would make two
 * pages declare "position 1" for two different posts of one list. Still counts from 1 even though `?page=`
 * counts from 0: `?page=0` is the first page, its first item is 1.
 *
 * `description` only when the page passes it, and it must be exactly the string the page gives
 * `pageMetadata({ description })`: the meta description, og:description and JSON-LD are one sentence, not
 * three sentences with drifting wording. Not passed, or empty, means no key — `"description": ""`
 * is the claim that the page has nothing to describe.
 *
 * No `numberOfItems`, no `image`: the first is only the array length rewritten, and for the second the page
 * has no real data to fill in. With no items nothing renders: an empty ItemList is the
 * claim "this page lists nothing".
 */
export function CollectionPageJsonLd({
  name,
  description,
  url,
  items,
  offset = 0,
  locale = DEFAULT_LOCALE,
}: {
  name: string
  /** The page's description, exactly the string the page gives `pageMetadata({ description })`. */
  description?: string
  /** The page's relative URL, exactly the canonical string. */
  url: string
  items: readonly JsonLdLink[]
  /** Number of items of the whole list that come before this page: `?page=n` with n × page size. Default 0. */
  offset?: number
  locale?: Locale
}) {
  if (items.length === 0) return null

  return (
    <JsonLd
      data={{
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name,
        ...(description ? { description } : {}),
        url: absoluteLocaleUrl(url, locale),
        // Like BlogPosting: <html lang> tells the page this, while JSON-LD does not see it.
        inLanguage: locale,
        mainEntity: {
          '@type': 'ItemList',
          itemListElement: items.map((link, index) => ({
            '@type': 'ListItem',
            position: offset + index + 1,
            name: link.name,
            url: absoluteLocaleUrl(link.url, link.locale ?? locale),
          })),
        },
      }}
    />
  )
}

export function ProfilePageJsonLd({
  name,
  role,
  github,
  locale = DEFAULT_LOCALE,
}: {
  name: string
  role: string
  github: string | null
  locale?: Locale
}) {
  return (
    <JsonLd
      data={{
        '@context': 'https://schema.org',
        '@type': 'ProfilePage',
        inLanguage: locale,
        mainEntity: {
          '@type': 'Person',
          name,
          url: absoluteUrl(localePath('/about', locale)),
          description: role,
          ...(github ? { sameAs: [githubUrl(github)] } : {}),
        },
      }}
    />
  )
}
