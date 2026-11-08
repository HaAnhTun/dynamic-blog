import { DEFAULT_LOCALE, isLocale, type Locale } from '@/i18n/config'
import { localePath } from '@/lib/locale-path'
import { mediaUrl } from '@/lib/media'
import { profileHref } from '@/lib/profile'
import type { Post, PostAuthor } from '@/lib/types'
import { absoluteUrl } from '@/lib/site'
import { JsonLd } from './JsonLd'

/**
 * The article's canonical path and absolute URL.
 *
 * They live here, in the SEO module, because three places need the same answer and
 * must not disagree: `alternates.canonical` in the post page's `generateMetadata`,
 * the `url` in the JSON-LD below, and the string `CopyLink` puts on the clipboard.
 * A reader who copies a link that is not the canonical one spreads a duplicate URL,
 * which is the exact thing the canonical tag exists to prevent.
 *
 * The slug is percent-encoded: every slug on this site is ASCII today, but
 * `/posts/[slug]` accepts whatever the URL carries and `getPost` already encodes, so
 * encoding here keeps the three strings identical for a diacritic slug too.
 */
export function postPath(slug: string): string {
  return `/posts/${encodeURIComponent(slug)}`
}

/**
 * Absolute, because JSON-LD and the clipboard both need an origin — unlike
 * `alternates.canonical`, which Next resolves against `metadataBase`.
 *
 * NEXT_PUBLIC_ so the same name works in `CopyLink`, a client component, where the
 * value is inlined at build time. The fallback is the same localhost origin
 * app/layout.tsx falls back to, deliberately: two different dev fallbacks would make
 * the copy button produce a URL that the canonical tag on the same page contradicts.
 *
 * `||` rather than `??`, and a trim: an env var that is present but empty (a `.env`
 * line written as `NEXT_PUBLIC_SITE_URL=`) is not a configured origin, and `??` would
 * accept it and emit `/posts/x` as an "absolute" URL. The trailing-slash strip covers
 * the other obvious way to write it — without it `https://example.com/` yields
 * `https://example.com//posts/x`, a distinct URL to every crawler and cache.
 */
export function postUrl(slug: string, language: Locale = DEFAULT_LOCALE): string {
  // Via lib/site.ts, which is the single definition of this rule — there used to be four,
  // and the one in app/layout.tsx was wrong in a way that took every page down.
  return absoluteUrl(localePath(postPath(slug), language))
}

/** The language of a post as an enabled locale; a post of an older backend (no language) is in the default one. */
export function postLanguage(post: Pick<Post, 'language'>): Locale {
  return isLocale(post.language) ? post.language : DEFAULT_LOCALE
}

/**
 * hreflang map of a post: itself and its published translations (symmetric, because every member lists the same set), plus
 * `x-default` = the default-locale member when there is one. Undefined when there are no translations: a lone post declares none.
 * Paths are relative or absolute depending on `addressOf`, like `languageAlternates`.
 */
export function postAlternates(
  post: Pick<Post, 'slug' | 'language' | 'translations'>,
  addressOf: (path: string, locale: Locale) => string = localePath,
): Record<string, string> | undefined {
  const siblings = (post.translations ?? []).filter((item) => isLocale(item.language))
  if (siblings.length === 0) return undefined
  const members = [
    { language: postLanguage(post), slug: post.slug },
    ...siblings.map(({ language, slug }) => ({ language: language as Locale, slug })),
  ]
  const languages = Object.fromEntries(members.map(({ language, slug }) => [language, addressOf(postPath(slug), language)]))
  const original = members.find((member) => member.language === DEFAULT_LOCALE)
  return original ? { ...languages, 'x-default': addressOf(postPath(original.slug), DEFAULT_LOCALE) } : languages
}

/**
 * The author of the post if they are NOT the site owner, otherwise null; a missing `author` (backend before multi-author support) is the site owner.
 * The author box, JSON-LD, RSS and share cards all ask here, like postUrl above, so the four places cannot drift apart.
 */
export function otherAuthor(author: PostAuthor | null | undefined): PostAuthor | null {
  return author && !author.siteOwner ? author : null
}

/** Author name as the site writes it: the site owner is `ownerName` (`profile.name` of the site content), a display name everywhere else on the site. */
export function authorName(author: PostAuthor | null | undefined, ownerName: string): string {
  return otherAuthor(author)?.displayName ?? ownerName
}

/** GitHub page of a login; null when there is none (a password-only account): never "/null". */
export function githubProfileUrl(login: string | null): string | null {
  return login ? `https://github.com/${encodeURIComponent(login)}` : null
}

function authorNode(author: PostAuthor | undefined, ownerName: string) {
  const other = otherAuthor(author)
  if (other) {
    // Never /about: that page, and its ProfilePage node, is about the site owner and not about this person.
    // With a /u/<slug> profile the url is the profile and GitHub becomes sameAs; an old backend keeps the GitHub url.
    const github = githubProfileUrl(other.githubLogin)
    const href = profileHref(other)
    if (href === null) return { '@type': 'Person', name: other.displayName, ...(github ? { url: github } : {}) }
    return { '@type': 'Person', name: other.displayName, url: absoluteUrl(href), ...(github ? { sameAs: github } : {}) }
  }
  return {
    '@type': 'Person',
    name: ownerName,
    // The author page, which exists and answers 200. Google's Article guidance asks for
    // a url here specifically so the author can be resolved to a single entity, and
    // /about is its own worked example of what that page should be. It is the same URL
    // the ProfilePage node on that page claims for the same person, so the two nodes
    // describe one person rather than two with the same name.
    url: absoluteUrl('/about'),
  }
}

/**
 * Structured data for one article.
 *
 * Only for a published post: a `BlogPosting` node on a draft tells an aggregator that
 * a URL which answers 404 to it is a real article. `null` is the whole render in that
 * case — not an empty script tag.
 */
/** `ownerName` is `profile.name` of the site content: the author of a post by the site owner. */
export function ArticleJsonLd({ post, ownerName }: { post: Post; ownerName: string }) {
  if (post.status !== 'PUBLISHED') return null

  const data = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.title,
    // Absent rather than null. `"datePublished": null` is worse than no key at all:
    // a consumer that validates the type rejects the whole node.
    ...(post.publishedAt ? { datePublished: post.publishedAt } : {}),
    dateModified: post.updatedAt,
    author: authorNode(post.author, ownerName),
    ...(post.excerpt ? { description: post.excerpt } : {}),
    url: postUrl(post.slug, postLanguage(post)),
    // Stated here because a consumer reading the JSON-LD alone has no other way to know.
    inLanguage: postLanguage(post),
    // The section and keywords are the category and tag NAMES the page renders as links
    // under the title (components/site/ReadingMeta.tsx) — not invented keywords, and not
    // the slugs. Both are omitted when the post has neither, rather than emitted empty:
    // `"keywords": ""` is a claim that the article has no subject.
    ...(post.category ? { articleSection: post.category.name } : {}),
    ...(post.tags.length > 0 ? { keywords: post.tags.map((tag) => tag.name) } : {}),
    // `image` only when the post has a cover image: it is a real image the author chose, served
    // at exactly one immutable URL under /media/, and it is the very image the post page shows and og:image
    // shares — so the claim has something behind it. Absolute, because JSON-LD has no metadataBase.
    ...(post.cover ? { image: mediaUrl(post.cover) } : {}),
    // NO `publisher`, NO `mainEntityOfPage`, and NO `image` for a post without a cover. Each
    // was asked for by an SEO audit and each would be a claim this page cannot back:
    //
    //  - `image` without a cover: the only picture that exists for such an article is the
    //    generated share card at app/api/og/posts/[slug]/route.tsx, and its URL
    //    carries a route-group hash plus a content hash that Next derives at build time
    //    (get-metadata-route.js:51-82). This component cannot compute that string, and a
    //    hardcoded one would 404 silently — a Search Console error with no symptom on the
    //    site. It is also a card made of text, which Google's image guidance names as the
    //    wrong thing to nominate. `og:image` already points at it for the social unfurl,
    //    which is what the card is actually for.
    //  - `publisher`: this is one person's blog. There is no organisation, and
    //    the packaged content deliberately carries `org: null` on the timeline entries that
    //    have no employer to name. A `publisher` here would be an invented company.
    //  - `mainEntityOfPage`: it would restate `url` under a second key, giving this page
    //    two spellings of its own address — the exact drift the note at the top of this
    //    file exists to prevent.
  }

  return <JsonLd data={data} />
}
