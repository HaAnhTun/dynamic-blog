import { ImageResponse } from 'next/og'
import { OG_SIZE, ShareCard } from '@/components/og/ShareCard'
import { authorName, postLanguage } from '@/components/site/ArticleJsonLd'
import { NotFoundError, getPost, getPostRedirect } from '@/lib/api'
import { TILE_VIEWBOX, composeCover, coverInputOf, coverSvgString } from '@/lib/cover-art'
import { formatDate } from '@/lib/date'
import { memoizedPng } from '@/lib/png-memo'
import { limitReads } from '@/lib/read-limit'
import { getDefaultSiteContent, getSiteContent } from '@/lib/site-content'
import { isPlausibleSlug, normalizeSlug } from '@/lib/text'
import type { Post } from '@/lib/types'

/**
 * The share card for one article: `GET /api/og/posts/<slug>`, a PNG of 1200x630.
 *
 * Before this card every one of the twelve articles shared the identical site-wide card, so a thread with three links from this
 * blog in it showed the same picture three times and told a reader nothing about which was which.
 *
 * ## Why a route handler and not the `opengraph-image` file convention
 *
 * The convention puts a build hash in the URL (`/posts/<slug>/opengraph-image-<hash>/card`, a djb2 of the route path when it
 * contains a group segment) and, under `app/[locale]`, the locale in front of it, so the tag a Vietnamese page emitted was
 * `/vi/posts/...` and redirected. Here the URL is written by `postCardOgImage` (lib/metadata.ts), never depends on where the
 * file lives, and is outside the locale routing (`/api` is not matched by the proxy). The old hashed URL still answers: a
 * permanent redirect in next.config.ts sends it here.
 *
 * ## Truthful, and nothing more
 *
 * Category, publication date, title, author: each already rendered on the page itself by `ReadingMeta`, through the same
 * `formatDate` so the two cannot disagree about a timezone. No reading time, no tag list, no excerpt: a card is read at
 * thumbnail size in a feed.
 */
const size = OG_SIZE

/**
 * The cover art cell for the card, or `undefined` when the post already has a cover image: then the `og:image`
 * of the page is the cover image itself, and the text card here stays as it was.
 *
 * Same input as the thumbnail in the list (`coverInputOf`), so same recipe, same ink,
 * same flip direction: the reader sees exactly that picture when the link is shared. A dark palette because the card always has
 * the background `#0a0a0a`. Cropped square (columns 2-5) with a viewBox. Stroke 1.6 units: a 240-unit cell drawn at 300px
 * comes out at 2px on a 1200px card, about 1px when social networks shrink the card to ~500px; still a
 * hairline, only baked in, since resvg is not sure to support `vector-effect`.
 */
function coverTile(post: Post): string | undefined {
  if (post.cover) return undefined
  const svg = coverSvgString(composeCover(coverInputOf(post)), {
    theme: 'dark',
    viewBox: TILE_VIEWBOX,
    hairline: 1.6,
  })
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
}

/**
 * The article this card is for, or null — and null is never a throw: this route is fetched by
 * crawlers and unfurlers, and both callers below answer null with the site-wide card.
 *
 * `normalizeSlug`, matching page.tsx and its generateMetadata: route params arrive
 * percent-encoded and the same Vietnamese text can arrive composed or decomposed, so a
 * reader who followed a decomposed link would otherwise get the fallback card on an
 * article that renders perfectly.
 *
 * Old path: when the slug already 404s, ask whether it is the old slug of a published post,
 * and draw the card of that post. The page of the old path redirects with 308, but the image cannot be redirected:
 * a preview still holding the old image link must still see the right post. A target equal to the asked slug itself (stale cache) is skipped, like
 * in page.tsx; an error other than 404 is not looked up, like every other error here.
 */
async function postFor(slug: string): Promise<Post | null> {
  const wanted = normalizeSlug(slug)
  try {
    return await getPost(wanted)
  } catch (error) {
    if (!(error instanceof NotFoundError)) return null
  }
  const target = await getPostRedirect(wanted).catch(() => null)
  if (target === null || target.normalize('NFC') === wanted) return null
  return getPost(target).catch(() => null)
}

type CardContext = { params: Promise<{ slug: string }> }

/**
 * The site-wide card is the same for every address that is not a post, so it is drawn once for each version of the site content and
 * served from memory. It may be kept by a browser or a CDN for five minutes (the card of a real post is sent `max-age=0,
 * must-revalidate`, as every route handler is unless it says otherwise): long enough to absorb a flood for one address, short enough that a
 * post published later at an address that was asked for before gets its own card within five minutes.
 */
const SITE_CARD_CACHE_CONTROL = 'public, max-age=300, no-transform'

async function siteCard(): Promise<Response> {
  const { site } = await getDefaultSiteContent()
  const png = await memoizedPng(JSON.stringify([site.name, site.tagline, site.positioning]), () =>
    new ImageResponse(
      <ShareCard title={site.name} titleSize={76} subtitle={site.tagline || undefined} footer={site.positioning} />,
      size,
    ).arrayBuffer(),
  )
  return new Response(png.slice().buffer, {
    headers: { 'content-type': 'image/png', 'cache-control': SITE_CARD_CACHE_CONTROL },
  })
}

/**
 * The card, or the site-wide card when the post cannot be found: never a 500 (see `postFor`).
 *
 * An anonymous route that draws a picture is an expensive one to leave open: one address may ask 60 times a minute (`limitReads`), a
 * value no post can have (a slash, a control character, more than 255 characters) is answered without asking the backend, and the
 * answer to every address that is not a post is one picture drawn once.
 */
export async function GET(request: Request, ctx: CardContext): Promise<Response> {
  const limited = limitReads(request, 'og')
  if (limited) return limited
  const { slug } = await ctx.params
  const post = isPlausibleSlug(normalizeSlug(slug)) ? await postFor(slug) : null

  // The site-wide card, not a 500 and not an empty PNG. This route is fetched by crawlers and link unfurlers rather than by the
  // reader, so a throw here would surface only as a broken preview, which is the exact failure this card exists to fix.
  if (post === null) return siteCard()
  const { profile } = await getSiteContent(postLanguage(post))

  // ' · ' between them, and the parts are dropped rather than left blank: a card reading "Architecture · " would be worse than one
  // reading "Architecture".
  const eyebrow = [post.category?.name, formatDate(post.publishedAt, 'medium')].filter(Boolean).join(' · ')

  return new ImageResponse(
    <ShareCard
      eyebrow={eyebrow || undefined}
      title={post.title}
      footer={authorName(post.author, profile.name)}
      art={coverTile(post)}
    />,
    size,
  )
}
