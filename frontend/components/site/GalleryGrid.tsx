import Image from 'next/image'
import { useTranslations } from 'next-intl'
import type { Translator } from '@/i18n/translator'
import { IMAGE_QUALITY } from '@/lib/image-quality'
import { mediaPath } from '@/lib/media'
import type { GalleryPhoto, MediaRef } from '@/lib/types'
import { FOCUS, TRANSITION } from './SectionHeading'

/**
 * The attribute carrying a cell's position in the `photos` array. It is a contract with GalleryLightbox: the viewer
 * catches the press with event delegation, finds the cell by this attribute and opens exactly that image — the grid does not
 * need to know whether a viewer exists.
 */
export const TILE_INDEX_ATTRIBUTE = 'data-gallery-index'

/**
 * The column holding the grid. `browse` is the main column of a BROWSE page inside the site frame (/gallery), `band` is a
 * full frame band (the photo bands of the home and About pages). The three older entries follow the pre-frame layouts and
 * are DEPRECATED: `wide`, `prose` and `column` stay only until the pages that use them are converted, then the final
 * cleanup ticket deletes them.
 */
export type GalleryGridWidth = 'browse' | 'band' | 'wide' | 'prose' | 'column'

/** The number of columns from the widest breakpoint at which the grid changes: 3 (always), 4 (from xl), 6 (from lg). */
export type GalleryGridColumns = 3 | 4 | 6

/**
 * `square`: equal square cells, `columns` decides the count (the photo bands). `justified`: rows of equal height that fill the
 * width, every cell keeps its photo's own ratio (/gallery); `columns` is ignored.
 */
export type GalleryGridLayout = 'square' | 'justified'

/** The grid classes per `columns`; gap stays `gap-1 sm:gap-2` for all of them. */
const GRID_CLASSES: Record<GalleryGridColumns, string> = {
  3: 'grid grid-cols-3 gap-1 sm:gap-2',
  4: 'grid grid-cols-3 xl:grid-cols-4 gap-1 sm:gap-2',
  6: 'grid grid-cols-3 lg:grid-cols-6 gap-1 sm:gap-2',
}

/**
 * The width of one cell by the width of the column holding the grid, for `sizes`. `rem` applies from 640px, `lgRem` from
 * 1024px, `xlRem` from 1280px, `vw` below 640px (the grid takes the whole screen minus margins, each cell a third, 33vw).
 *
 * - `browse` (the main column of a BROWSE page): 640 to 1023 up to 20rem; lg (3 columns) 240 to 325px, so 20.5rem, the widest
 *   cell; xl (4 columns) 229px at 1280 to 258px at 1440, so 16.5rem.
 * - `band` (6 columns from lg, 3 below): 156px at 1024 to 218px at 1440 and beyond (the frame stops growing at 1400px), so
 *   14rem from lg.
 * - Deprecated `wide`: the 64rem column, 61rem minus margins divided by three is about 20rem. `prose`: 48rem, about 15rem.
 *   `column` (the text column of /about) has an extra `lgRem`: 61rem - 18rem right column - 4rem gap = 39rem, minus two 0.5rem
 *   gaps then divided by three is about 12.7rem; below 1024px the page is one column and the grid is as wide as `wide`.
 */
export const TILE_WIDTH: Record<GalleryGridWidth, { rem: number; vw: number; lgRem?: number; xlRem?: number }> = {
  browse: { rem: 20, vw: 33, lgRem: 20.5, xlRem: 16.5 },
  band: { rem: 20, vw: 33, lgRem: 14 },
  wide: { rem: 20, vw: 33 },
  prose: { rem: 15, vw: 33 },
  column: { rem: 20, vw: 33, lgRem: 12.7 },
}

/** Rounds a width in rem up to the next half rem: whole-rem rounding would turn 16.5rem into 17rem (3% too many pixels). */
const ceilHalf = (rem: number) => Math.ceil(rem * 2) / 2

/**
 * The `sizes` of ONE image: the cell width times the image's width/height ratio (clamped to 1–2.5).
 *
 * A square cell uses `object-cover`, so a wide image is shrunk by the cell HEIGHT and overflows on both sides: a 4:3
 * image in a 20rem cell needs a ~27rem wide version, not 20rem. `sizes` equal to the cell width (the earlier version)
 * made the browser pick the 640w file for a 318px cell on a 2× screen, then scale the image up 1.3–1.6 times: measured
 * on the QA stack, wide images received only 0.63–0.75 of the pixels they needed. Square and portrait images are limited
 * by width, so they stay as they were (factor 1). The ceiling 2.5 keeps a panorama from pulling the 3840w version.
 */
export function tileSizes(image: Pick<MediaRef, 'width' | 'height'>, width: GalleryGridWidth): string {
  const ratio = image.width > 0 && image.height > 0 ? image.width / image.height : 1
  const k = Math.min(Math.max(ratio, 1), 2.5)
  const { rem, vw, lgRem, xlRem } = TILE_WIDTH[width]
  // The browser takes the FIRST clause that matches, so the clauses go from the largest min-width to the smallest.
  const xl = xlRem === undefined ? '' : `(min-width: 1280px) ${ceilHalf(xlRem * k)}rem, `
  const lg = lgRem === undefined ? '' : `(min-width: 1024px) ${ceilHalf(lgRem * k)}rem, `
  return `${xl}${lg}(min-width: 640px) ${ceilHalf(rem * k)}rem, ${Math.ceil(vw * k)}vw`
}

/** The ratio range used by the justified layout: a panorama or a very tall image stays a reasonable cell. */
export const JUSTIFIED_RATIO_MIN = 0.5
export const JUSTIFIED_RATIO_MAX = 2.5
/** A portrait cell may grow at most this many times its basis, so a lone portrait on a phone row does not fill the width. */
export const JUSTIFIED_MAX_GROWTH = 1.6
/**
 * A landscape cell is not capped on a phone (`--grow` is large below 640px): a landscape that wraps onto a row alone fills the
 * width instead of leaving a ragged left-aligned strip. From sm there are enough photos per row and the cap applies again.
 */
const LANDSCAPE_MIN_RATIO = 1.2
/** The target row height in rem per breakpoint (phone, from sm, from lg), also the source of the justified `sizes`. */
const ROW_HEIGHT_REM = { base: 9.5, sm: 12, lg: 14.5 }
/** Cells grow a little to fill their row; `sizes` plans for that average growth. */
const JUSTIFIED_SIZES_GROWTH = 1.25

/** The width/height ratio the justified layout uses: clamped to 0.5–2.5, 1 when the size is unknown (0). */
export function layoutRatio(image: Pick<MediaRef, 'width' | 'height'>): number {
  const ratio = image.width > 0 && image.height > 0 ? image.width / image.height : 1
  return Math.min(Math.max(ratio, JUSTIFIED_RATIO_MIN), JUSTIFIED_RATIO_MAX)
}

/**
 * The `sizes` of one image in the justified layout: its basis width (ratio times the target row height of each breakpoint)
 * with room for the average growth that fills the row, never wider than the screen.
 */
export function justifiedSizes(image: Pick<MediaRef, 'width' | 'height'>): string {
  const ratio = layoutRatio(image)
  const rem = (rowHeight: number) => ceilHalf(ratio * rowHeight * JUSTIFIED_SIZES_GROWTH)
  // On a phone a landscape may be alone on its row, then it is as wide as the screen.
  const phone = ratio >= LANDSCAPE_MIN_RATIO ? '100vw' : `min(100vw, ${rem(ROW_HEIGHT_REM.base)}rem)`
  return `(min-width: 1024px) ${rem(ROW_HEIGHT_REM.lg)}rem, (min-width: 640px) ${rem(ROW_HEIGHT_REM.sm)}rem, ${phone}`
}

/**
 * The name of an image: the description the site owner typed (required in admin), falling back to a numbered name by position in the grid
 * for old images without a description. The grid and the viewer share it, so one image does not have two names.
 */
export function photoName(photo: GalleryPhoto, index: number, t: Translator): string {
  return photo.image.altText?.trim() || t('photoName', { number: index + 1 })
}

/**
 * The same rule as PostCover: the dominant color goes straight into the style attribute, so only exactly `#rrggbb` is accepted.
 * The backend already has a CHECK with the same pattern; this is the second layer, stopping a corrupt record from injecting a CSS declaration.
 */
const HEX_COLOR = /^#[0-9a-f]{6}$/i

function placeholder(image: MediaRef): { backgroundColor: string } | undefined {
  const color = image.dominantColor
  return color && HEX_COLOR.test(color) ? { backgroundColor: color } : undefined
}

/**
 * The focus ring on the link, the rounded `rounded-md` frame on the inner span: FOCUS carries `rounded-sm` for the focus
 * ring, and when two corner-rounding classes sit on the same element, which one wins depends on the order the CSS is generated.
 * The border changes color with the link's `group-hover`, like the thumbnail on /series.
 */
const TILE_LINK = `group block ${FOCUS}`
const FRAME_BASE = `relative block overflow-hidden rounded-md border border-neutral-200 bg-neutral-100 dark:border-neutral-800 dark:bg-neutral-900 ${TRANSITION} group-hover:border-brand`
const TILE_FRAME = `${FRAME_BASE} aspect-square`

/** The justified list: wrapping flex rows; the row height is a CSS variable per breakpoint. */
const JUSTIFIED_CLASSES =
  'flex flex-wrap gap-1 sm:gap-2 [--row-h:9.5rem] sm:[--row-h:12rem] lg:[--row-h:14.5rem] [--grow:4] sm:[--grow:1.6]'

/** The photo keeps its head in a square crop: a portrait is anchored near the top, everything else is centered. */
const objectPosition = (image: Pick<MediaRef, 'width' | 'height'>) =>
  image.height > image.width ? 'object-[50%_28%]' : 'object-center'

/**
 * The photo grid of the gallery: square cells, 3 columns on a phone (about 100px per cell, the photo-grid style people are
 * used to) and `columns` above it: 3 (always, default), 4 (from xl, /gallery) or 6 (from lg, the photo bands). A square cell means a fixed frame: no layout jump, no need for JS
 * masonry; the viewer is where the image shows in its whole frame.
 *
 * Each cell is a real `<a href>` to the original file, so the image can be viewed without JS. The `fill` image +
 * `object-cover` on a dominant-color background while loading; the link's accessible name is the image's `alt`.
 *
 * A server component: no hooks, no JS apart from what next/image brings itself. With no images it renders
 * nothing — the page decides what to say when empty.
 */
export function GalleryGrid({
  photos,
  width = 'wide',
  columns = 3,
  eager = 0,
  layout = 'square',
}: {
  photos: GalleryPhoto[]
  /** The column the grid sits in, for the `sizes` of each image. Default `wide` (deprecated) until the pages pass their own. */
  width?: GalleryGridWidth
  /** 3 = always 3; 4 = 3 below xl, 4 from xl; 6 = 3 below lg, 6 from lg. */
  columns?: GalleryGridColumns
  /**
   * The number of first cells loaded immediately (`loading="eager"`) instead of lazily; the first cell also gets `fetchPriority="high"`.
   * For a page where the grid is the first content (/gallery: the first row is 3 cells, and the first cell is the LCP element —
   * Lighthouse measured 92 points with `lcp-lazy-loaded` when the whole grid was lazy). No `preload`: the next/image
   * docs recommend `loading`/`fetchPriority` instead of it, and the two are not used together. Default 0:
   * the photos block on the home page and /about is below the first screen, lazy is right.
   */
  eager?: number
  /** `square` (default) or `justified`: see GalleryGridLayout. */
  layout?: GalleryGridLayout
}) {
  const t = useTranslations('Site.gallery')
  if (photos.length === 0) return null

  const justified = layout === 'justified'

  return (
    <ul className={justified ? JUSTIFIED_CLASSES : GRID_CLASSES[columns]}>
      {photos.map((photo, index) => {
        const ratio = layoutRatio(photo.image)
        return (
          <li
            key={photo.id}
            style={
              justified
                ? {
                    flexGrow: ratio,
                    flexBasis: `calc(${ratio} * var(--row-h))`,
                    maxWidth:
                      ratio >= LANDSCAPE_MIN_RATIO
                        ? `calc(${ratio} * var(--grow) * var(--row-h))`
                        : `calc(${ratio * JUSTIFIED_MAX_GROWTH} * var(--row-h))`,
                  }
                : undefined
            }
          >
            {/* `data-gallery-index` is TILE_INDEX_ATTRIBUTE written verbatim; a test pins that the two match. */}
            <a href={mediaPath(photo.image)} data-gallery-index={index} className={TILE_LINK}>
              <span
                className={justified ? FRAME_BASE : TILE_FRAME}
                style={{ ...placeholder(photo.image), ...(justified ? { aspectRatio: String(ratio) } : undefined) }}
              >
                <Image
                  src={mediaPath(photo.image)}
                  alt={photoName(photo, index, t)}
                  fill
                  sizes={justified ? justifiedSizes(photo.image) : tileSizes(photo.image, width)}
                  quality={IMAGE_QUALITY.sharp}
                  loading={index < eager ? 'eager' : 'lazy'}
                  fetchPriority={index === 0 && eager > 0 ? 'high' : undefined}
                  className={`object-cover ${justified ? 'object-center' : objectPosition(photo.image)}`}
                />
              </span>
            </a>
          </li>
        )
      })}
      {justified && (
        // Shares the leftover width of the LAST row with its photos, so a short last row neither stretches into giant tiles
        // nor leaves a half-empty strip. On a phone it takes nothing (grow 0): a last row there has one or two photos, and a
        // lone landscape fills the width like the rows above (the cells' own max-width still caps portraits). From sm it
        // takes a share (grow 2, about one photo's worth), so a last row of two photos grows a little towards the row height
        // of the others. The negative top margin cancels the row gap when it lands on a line of its own (a full last row),
        // the negative left margin cancels the column gap before it, so a last row it shares still ends at the right edge.
        <li
          aria-hidden="true"
          role="presentation"
          className="-mt-1 -ml-1 grow-0 sm:-mt-2 sm:-ml-2 sm:grow-[2]"
          style={{ flexBasis: 0, height: 0 }}
        />
      )}
    </ul>
  )
}
