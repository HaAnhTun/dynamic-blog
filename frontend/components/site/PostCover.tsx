import Image from 'next/image'
import { coverInputOf } from '@/lib/cover-art'
import { IMAGE_QUALITY } from '@/lib/image-quality'
import { mediaPath } from '@/lib/media'
import type { MediaRef, PostSummary } from '@/lib/types'
import { CoverArt } from './CoverArt'

/** What the image frame needs to know about a post: enough to pick the cover image or build cover art. */
export type CoverPost = Pick<PostSummary, 'slug' | 'title' | 'category' | 'series' | 'cover'>

/**
 * Shared frame: hairline border, `rounded-md` radius, no ring, no shadow.
 * `relative` for `next/image fill`, `overflow-hidden` so the image and cover art are clipped to the rounded corners.
 * The background is the cover art's paper color: a placeholder for an uploaded image without a dominant color.
 */
const FRAME =
  'relative block overflow-hidden rounded-md border border-neutral-200 bg-neutral-100 dark:border-neutral-800 dark:bg-neutral-900'

/** Each ratio is written verbatim so Tailwind's scan sees it. */
const THUMB_SHAPE = 'aspect-[3/2]'
/** Cover image at the top of a post: exactly the share card ratio, so the image the author picked for og:image is the image the
 *  reader sees on the page. */
const HERO_COVER_SHAPE = 'aspect-[1200/630]'
/** Cover art at the top of a post: 2:1 shows the full eight columns of the canvas; from 640px 5:2 so it does not take more than half
 *  of the first screen on desktop. */
const HERO_ART_SHAPE = 'aspect-[2/1] sm:aspect-[5/2]'

/**
 * Default `sizes` by the frame's real width. Thumbnail: a 7rem column below 640px, from 640px the ListRow column
 * `clamp(10rem,28%,14rem)`, at most 14rem. Hero: the centre column of the reader layout, at most 52rem from 1088px (`rail`), 45rem from 640px (below it the
 * column is the viewport minus the gutter). Without `sizes` the browser treats the image as 100vw wide and loads the largest version.
 */
const THUMB_SIZES = '(min-width: 640px) 14rem, 7rem'
const HERO_SIZES = '(min-width: 1088px) 52rem, (min-width: 640px) 45rem, 100vw'

/**
 * The dominant color is only used when it has the exact `#rrggbb` form. The backend already has a CHECK with the same pattern; this value goes
 * straight into the style attribute, so this is the second layer that stops a broken record from injecting a CSS declaration.
 */
const HEX_COLOR = /^#[0-9a-f]{6}$/i

function placeholder(cover: MediaRef): { backgroundColor: string } | undefined {
  const color = cover.dominantColor
  return color && HEX_COLOR.test(color) ? { backgroundColor: color } : undefined
}

/**
 * A post's picture: the uploaded cover image if there is one, otherwise cover art generated from the slug.
 *
 * - `thumb`: the 3:2 frame of the list row. The image has `alt=""`: the title right beside it already describes the post, and
 *   the link wrapping the thumbnail in ListRow is a copy hidden from the accessibility tree.
 * - `hero`: the top of a post page. The cover image is the LCP image so `fetchPriority="high"` + `loading="eager"`,
 *   NO `preload`. next/image leaves `loading="lazy"` even with fetchPriority (get-img-props.js
 *   only turns lazy off with preload/priority or a `loading` other than 'lazy'), and Next 16 forbids combining preload
 *   with loading (E803) — so `eager` must be written out. alt takes the description the author entered, otherwise
 *   the title: an image the author chose is content, not decoration.
 *
 * `src` always goes through `mediaPath()`: next/image rejects a local src with a query string, and
 * `images.localPatterns` only opens `/media/**`.
 *
 * Server component: no hooks, no JS to the browser beyond what next/image carries itself.
 */
export function PostCover({
  post,
  variant,
  className,
  sizes,
}: {
  post: CoverPost
  variant: 'thumb' | 'hero'
  /** Added to the frame (for example the hover effect of the wrapping link), not replacing the frame. */
  className?: string
  /** Overrides the default `sizes` when the frame is narrower than usual (compact row: 6rem at every width). */
  sizes?: string
}) {
  const cover = post.cover ?? null
  const hero = variant === 'hero'
  const shape = !hero ? THUMB_SHAPE : cover ? HERO_COVER_SHAPE : HERO_ART_SHAPE
  const frame = className ? `${FRAME} ${shape} ${className}` : `${FRAME} ${shape}`

  if (!cover) {
    return (
      <span className={frame}>
        <CoverArt input={coverInputOf(post)} />
      </span>
    )
  }

  return (
    <span className={frame} style={placeholder(cover)}>
      <Image
        src={mediaPath(cover)}
        alt={hero ? (cover.altText ?? post.title) : ''}
        fill
        sizes={sizes ?? (hero ? HERO_SIZES : THUMB_SIZES)}
        quality={hero ? IMAGE_QUALITY.sharp : IMAGE_QUALITY.standard}
        className="object-cover"
        {...(hero ? { loading: 'eager' as const, fetchPriority: 'high' as const } : {})}
      />
    </span>
  )
}
