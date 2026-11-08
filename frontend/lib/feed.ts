import 'server-only'
import { authorName, postLanguage, postUrl } from '@/components/site/ArticleJsonLd'
import { NotFoundError, getPost } from '@/lib/api'
import { rfc822Date } from '@/lib/date'
import { DEFAULT_LOCALE, type Locale } from '@/i18n/config'
import type { Translator } from '@/i18n/translator'
import { localePath } from '@/lib/locale-path'
import { renderMarkdownToFeedHtml } from '@/lib/markdown'
import { absoluteUrl } from '@/lib/site'
import { getSiteContent } from '@/lib/site-content'
import type { PostSummary } from '@/lib/types'

/**
 * RSS 2.0 documents for every feed of the site: /feed.xml and the separate feeds of categories, series,
 * and tags share one item format. The route only chooses the posts and describes the channel; the format lives here.
 */

/**
 * The 20 newest posts not every post ever published.
 *
 * A reader polls to learn what is new since its last poll, keeps the items it already
 * stored, and a new subscriber reads the archive on the site, not in the feed. Sending every
 * post made each poll — now uncached — grow with the archive, for items no reader needs again:
 * a dozen posts measured about 10 KB, so a few hundred posts would cost a few hundred KB per poll, per
 * reader. Twenty is far more than appears between two polls, and it stays bounded.
 *
 * Each item carries the whole post in `content:encoded` (reversing the earlier "summary only" decision), so this limit is
 * all the more needed, and it applies to every feed.
 */
export const FEED_LIMIT = 20

/**
 * What a cache between the site and a reader may do with a feed. A feed is read from the backend on every poll (the data cache is
 * kept out on purpose, so a withdrawn post disappears at once), and without a rule here CloudFront (24 hours by default), Fastly or an
 * nginx `proxy_cache_valid` would pick a lifetime of its own and keep the old feed, whole articles included.
 * - A feed and a 404 are stored but revalidated on every request.
 * - A 503 is never stored, so it cannot outlive the incident, and `Retry-After` tells a reader when to come back.
 */
const REVALIDATE = 'public, max-age=0, must-revalidate'
const NEVER_STORE = 'no-store'
const UNAVAILABLE_RETRY_SECONDS = 120

/** On startup (nothing remembered yet) at most FEED_LIMIT post detail requests, run 4 at a time. */
const DETAIL_CONCURRENCY = 4

/**
 * Rendered HTML, keyed by post URL + `updatedAt`: a steady-state poll only costs the list request.
 * Never by slug alone, so a just-edited post shows its new content on the very next poll. When full, drop the least used entry.
 */
const MEMO_LIMIT = 100
const rendered = new Map<string, string>()

/**
 * Characters forbidden by XML 1.0 even in the `&#x…;` form (C0 except tab, LF, CR; U+FFFE, U+FFFF). An ANSI color string in a
 * code sample of one post is enough to break the whole feed for every reader (tried with DOMParser), so remove before escaping.
 */
const NOT_XML_CHAR = /[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g

/**
 * XML escaping, applied to every interpolated string without exception.
 *
 * `&` FIRST. Escaping it after the others would rewrite the `&` of an already-emitted
 * `&lt;` and produce `&amp;lt;`, which renders as the literal text `&lt;`. The ordering is
 * the whole correctness of this function and is why it is five sequential replaces rather
 * than one character-class pass.
 *
 * No CDATA anywhere in this file, deliberately. A CDATA section is terminated by the first
 * `]]>` in its contents, so a post whose excerpt contained that sequence would break the
 * document in a way that looks like escaping and is not — the same class of bug as the
 * `</script>` problem components/site/ArticleJsonLd.tsx documents at length. Escaping has
 * no such hole.
 *
 * `'` becomes `&apos;` rather than being left alone: it is only significant inside
 * single-quoted attribute values, none of which exist here today, and escaping it costs
 * nothing while surviving a future attribute that does.
 */
function escapeXml(value: string): string {
  return value
    .replace(NOT_XML_CHAR, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** `<tag>escaped</tag>`, or '' when there is nothing truthful to put in it. An element
 *  present but empty is a claim that the value is the empty string. */
function element(tag: string, value: string | null | undefined): string {
  return value ? `<${tag}>${escapeXml(value)}</${tag}>` : ''
}

/** One feed item: a post from the list, and its full HTML (null when it could not be read). */
type FeedItem = { post: PostSummary; html: string | null }

function remember(key: string, html: string): void {
  rendered.delete(key)
  rendered.set(key, html)
  if (rendered.size > MEMO_LIMIT) {
    const oldest = rendered.keys().next()
    if (!oldest.done) rendered.delete(oldest.value)
  }
}

/**
 * The post with its full HTML, or null when the post is no longer published when the detail is read (unpublished between two requests). Other
 * errors keep the item without `content:encoded` and remember nothing, so the next poll tries again.
 */
async function withContent(post: PostSummary): Promise<FeedItem | null> {
  const url = postUrl(post.slug, postLanguage(post))
  const version = typeof post.updatedAt === 'string' && post.updatedAt !== '' ? post.updatedAt : null
  const key = version === null ? null : `${url} ${version}`
  const cached = key === null ? undefined : rendered.get(key)
  if (key !== null && cached !== undefined) {
    remember(key, cached)
    return { post, html: cached }
  }

  try {
    const detail = await getPost(post.slug)
    if (detail.status !== 'PUBLISHED') return null
    const html = await renderMarkdownToFeedHtml(detail.content, url)
    // Only remember when the list and the detail are the same version: a post edited between two requests is read again next time.
    if (key !== null && detail.updatedAt === version) remember(key, html)
    return { post, html }
  } catch (error) {
    if (error instanceof NotFoundError) return null
    console.warn(
      `[feed] Could not read the content of post ${post.slug} (${error instanceof Error ? error.message : String(error)}). ` +
        'This item has no content:encoded.',
    )
    return { post, html: null }
  }
}

/** `fn` for each element, at most `limit` calls at once; results keep the input order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

function itemXml({ post, html }: FeedItem, ownerName: string): string {
  const url = postUrl(post.slug, postLanguage(post))

  // Category elements for the post's own category and each of its tags — these are the
  // strings the article page renders as links, not invented keywords. De-duplicated
  // because a post may carry a tag with the same name as its category ("Architecture" does),
  // and the same term twice is noise rather than a second fact.
  const categories = [...new Set([post.category?.name, ...post.tags.map((tag) => tag.name)])]
    .filter((name): name is string => Boolean(name))
    .map((name) => element('category', name))
    .join('')

  return [
    '<item>',
    element('title', post.title),
    `<link>${escapeXml(url)}</link>`,
    // `isPermaLink="true"` because it genuinely is one: the same URL as `<link>`, which is
    // the article's canonical. A reader uses the guid to decide whether it has seen an item
    // before, so it must be stable — and the slug is, which is why no title or date goes
    // into it.
    `<guid isPermaLink="true">${escapeXml(url)}</guid>`,
    element('description', post.excerpt),
    // The whole post, escaped into entities like every other string, no CDATA: `]]>` inside a code block
    // cannot cut the document. Absent when the post detail could not be read.
    element('content:encoded', html),
    // Omitted rather than guessed for a post with no publication date, and omitted rather
    // than emitted as the string "Invalid Date" for an unparseable one — see lib/date.ts.
    element('pubDate', rfc822Date(post.publishedAt)),
    element('dc:creator', authorName(post.author, ownerName)),
    categories,
    '</item>',
  ].join('')
}

export type FeedChannel = {
  title: string
  /** Absolute URL of the HTML page this feed represents. */
  link: string
  description: string
  /** The feed's own path WITHOUT a locale prefix (FEED_PATH, categoryFeedPath…); the locale prefix is added for `<atom:link rel="self">`. */
  selfPath: string
  /** Language of the channel and locale of its own URLs; the default locale when absent. Item links are always the canonical post URLs. */
  locale?: Locale
}

/** Feed of `posts` in the given order: only PUBLISHED posts, at most FEED_LIMIT items, each item with the whole post. */
export async function rssResponse(channel: FeedChannel, posts: readonly PostSummary[]): Promise<Response> {
  const { locale = DEFAULT_LOCALE } = channel
  const ownerName = (await getSiteContent(locale)).profile.name
  const candidates = posts.filter((post) => post.status === 'PUBLISHED').slice(0, FEED_LIMIT)
  const items = (await mapLimit(candidates, DETAIL_CONCURRENCY, withContent)).filter((item): item is FeedItem => item !== null)

  // The newest of the readable `updatedAt`/`publishedAt` of the items: the same `modifiedOf` rule as
  // app/sitemap.ts, copied because this change does not touch that file. When there is none, omit it entirely: a
  // `lastBuildDate` of "now" would announce a changed feed on every poll.
  const times = items
    .flatMap(({ post }) => [post.updatedAt, post.publishedAt])
    .map((date) => (typeof date === 'string' ? Date.parse(date) : Number.NaN))
    .filter(Number.isFinite)
  const lastBuild = times.length > 0 ? new Date(Math.max(...times)).toUTCString() : null

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    // The atom namespace is here for exactly one element: `<atom:link rel="self">`, which
    // is how a feed states its own address. Validators require it and some readers use it
    // to re-find a feed that moved. Dublin Core, likewise, for `<dc:creator>` alone.
    // `content` also, for `<content:encoded>`.
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">',
    '<channel>',
    element('title', channel.title),
    `<link>${escapeXml(channel.link)}</link>`,
    element('description', channel.description),
    element('language', locale),
    `<atom:link href="${escapeXml(absoluteUrl(localePath(channel.selfPath, locale)))}" rel="self" type="application/rss+xml"/>`,
    element('lastBuildDate', lastBuild),
    // No <managingEditor>, <webMaster> or item-level <author>. All three are specified as
    // an email address, and even with `contact.email` filled in they stay out: that field
    // drives the visible contact links (site content `contact`: leaving it `null` makes the UI
    // hide the matching link), and copying it into the feed is a separate choice — every aggregator
    // that polls this URL would store the address, and a reader that displays item
    // <author> would print it as the byline of every article. The byline is `dc:creator`
    // on each item instead: a name, never an address.
    ...items.map((item) => itemXml(item, ownerName)),
    '</channel>',
    '</rss>',
  ]
    .filter(Boolean)
    .join('')

  return new Response(xml, {
    headers: { 'content-type': 'application/rss+xml; charset=utf-8', 'cache-control': REVALIDATE },
  })
}

/**
 * 503, NOT a 200 with an empty channel. A feed reader treats an empty feed as "every
 * article was deleted" and some will drop the items it already has; a 503 is read as
 * "try again later", which is true. The sitemap makes the opposite choice for the
 * opposite reason — it runs during `next build`, where throwing would fail the image.
 */
export function feedUnavailable(error: unknown, t: Translator): Response {
  console.warn(
    `[feed] Could not read the posts (${error instanceof Error ? error.message : String(error)}). ` +
      'Answering 503 rather than an empty feed.',
  )
  return new Response(t('unavailable'), {
    status: 503,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': NEVER_STORE,
      'retry-after': String(UNAVAILABLE_RETRY_SECONDS),
    },
  })
}

/** A slug that matches no category, series or tag: a real 404, not an empty channel carrying 200. */
export function feedNotFound(t: Translator): Response {
  return new Response(t('notFound'), {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': REVALIDATE },
  })
}
