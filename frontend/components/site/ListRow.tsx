import { Link } from '@/i18n/navigation'
import type { ReactNode } from 'react'
import { LayersIcon } from '@/components/icons'
import { formatDate } from '@/lib/date'
import type { HighlightSegment } from '@/lib/highlight'
import type { PostSummary, SeriesRef } from '@/lib/types'
import { Highlight, SegmentText } from './Highlight'
import { PostCover } from './PostCover'
import { MEASURE, MEASURE_SMALL } from './reader/reader-layout'
import { META_ICON, ReadingMeta, TagList, readingMinutesOf } from './ReadingMeta'
import { FOCUS, TITLE_LINK, TITLE_TOUCH, TRANSITION } from './SectionHeading'
import { useLocale, useTranslations } from 'next-intl'
import type { Translator } from '@/i18n/translator'
import { asLocale } from '@/lib/format'
import { postLinkLocale } from '@/lib/post-language'

export type ListRowProps = {
  post: PostSummary
  /** h2 when the row sits right under the page's h1 (a list), h3 under an h2 section. */
  headingLevel: 2 | 3
  /** Related posts: thumbnail 6rem at every width, smaller text, tighter spacing. */
  compact?: boolean
  /** Off on the category page, where the h1 is already the category name. Default on. */
  showCategory?: boolean
  /** Default on. */
  showTags?: boolean
  /** Default on; an empty excerpt gives no <p> even when on. */
  showExcerpt?: boolean
  /**
   * Overrides the default series kicker (for example "Part i" on the series page, the sequence number on the featured
   * posts page). `null` drops the kicker entirely; when not passed, a post in a series gets the series kicker.
   */
  kicker?: ReactNode
  /**
   * Search query: matched words in the title and short description are wrapped in `<mark>` (Highlight). Only
   * /search passes it. Category, tags and series name are navigation links, not the post's text,
   * so they must not be highlighted.
   */
  query?: string
  /**
   * Matches chosen by the engine: when present it replaces `query`. The title is only used when it reassembles to exactly
   * `post.title`, so the link's name never changes; the description may be a snippet of the post body (Meilisearch).
   */
  titleSegments?: readonly HighlightSegment[]
  excerptSegments?: readonly HighlightSegment[]
}

const joined = (segments: readonly HighlightSegment[]) => segments.map((segment) => segment.text).join('')

/**
 * The grid of the post row. The text column is `minmax(0,1fr)` (not `1fr`, whose minimum is min-content and
 * would be pushed wide by one long word), the thumbnail column 7rem below 640px (112 x 75, a thumbnail a reader can recognise), from 640px `clamp(10rem,28%,14rem)`.
 *
 * `sm:grid-rows-[auto_auto_auto_1fr]`: from 640px the thumbnail spans four rows (title, meta,
 * excerpt, tags). An empty row takes the thumbnail's extra height by itself, but when all four rows
 * have text and still add up shorter than the thumbnail (a one-line title, a one-line excerpt, one tag),
 * the grid algorithm splits the excess evenly among all four (CSS Grid §11.5, "distribute space beyond
 * limits") — gaps get inserted between the title, meta, excerpt and tags. A `1fr` row at the end
 * takes all the excess: an item spanning a flexible track only distributes into flexible tracks. Measured on Chrome
 * at 1280px: without the `1fr` row, title→meta of such a row is 13px instead of the 8px of `mt-2`.
 */
const GRID =
  'grid grid-cols-[minmax(0,1fr)_7rem] gap-x-4 max-[400px]:grid-cols-[minmax(0,1fr)_6rem] sm:grid-cols-[minmax(0,1fr)_clamp(10rem,28%,14rem)] sm:grid-rows-[auto_auto_auto_1fr] sm:gap-x-8'
const GRID_COMPACT = 'grid grid-cols-[minmax(0,1fr)_6rem] gap-x-4 sm:grid-rows-[auto_auto_auto_1fr] sm:gap-x-6'

/**
 * Thumbnail: column 2, row 1, anchored to the top. From 640px it spans four rows. `sm:row-start-1` is repeated on
 * purpose: `row-span-4` is the shorthand `grid-row: span 4 / span 4`, which also overrides the unprefixed
 * `row-start-1`, and the thumbnail would only stay at row 1 thanks to DOM order. In the compiled
 * CSS, Tailwind puts shorthands before longhands (checked), so the result is `1 / span 4`.
 */
const THUMB_LINK = 'group col-start-2 row-start-1 self-start sm:row-span-4 sm:row-start-1'

/** The thumbnail border turns brand-colored when the pointer is over it, like everything clickable. */
const THUMB_HOVER = `${TRANSITION} group-hover:border-brand`

/** Meta, excerpt, tags: below 640px they run the full width under the title and thumbnail; from 640px
 *  they go back to the text column. */
const BELOW = 'col-span-2 sm:col-span-1 sm:col-start-1'

/** One-line kicker: the series name shrinks first (min-w-0), everything else keeps its size. */
const KICKER = 'mb-1 flex min-w-0 items-center gap-1.5 text-xs font-medium text-neutral-600 dark:text-neutral-400'
/**
 * The kicker text is only 16px tall. The tap area is enlarged like TAP_TARGET, except the bottom edge: the post title (the only
 * accessible link to the post) is only 4px away (`mb-1`), so the bottom edge stops there so as not to take its taps.
 */
const KICKER_LINK = `relative min-w-0 after:absolute after:-inset-x-1.5 after:-top-2.5 after:-bottom-1 max-sm:after:-top-5 ${FOCUS} ${TRANSITION} hover:text-brand hover:underline hover:underline-offset-4`

/**
 * Title size. `break-words`: the text cell can shrink to 0 but a word with no break opportunity still overflows
 * out of it; at 320px the text column is only about 176px.
 */
const TITLE_H2 = 'break-words text-lg font-medium tracking-tight max-sm:leading-snug sm:text-xl'
const TITLE_H3 = 'break-words text-lg font-medium tracking-tight max-sm:leading-snug'
const TITLE_COMPACT = 'break-words text-base font-medium'

/**
 * "Part n/m", only from `partNumber`/`partCount` (rank among the published parts), never
 * from `position` (the stored position, which may have gaps). If one of the two is missing, or the two numbers do not
 * match, the part number is not written.
 */
function partLabel(series: SeriesRef, t: Translator): string | null {
  const { partNumber: n, partCount: m } = series
  if (typeof n !== 'number' || typeof m !== 'number') return null
  if (!Number.isInteger(n) || !Number.isInteger(m) || n < 1 || m < n) return null
  return t('partLabel', { number: n, total: m })
}

/**
 * Default kicker of a post in a series: `[Layers] {series} · Part n/m`.
 *
 * Only the series name is truncated (`block truncate` in a shrinkable link), while "· Part n/m" is
 * `shrink-0 whitespace-nowrap`: at 320px a long series name is left with a few letters and "…", but the part
 * number is always readable (the bug the mobile variant had: `truncate` on the whole group swallowed
 * "Part 3"). The series name is a link to the series page. The "·" dot is only for the eye, so aria-hidden.
 *
 * Exported so that any page needing its own kicker (for example a sequence number) still uses this exact group.
 */
export function SeriesKicker({ series }: { series: SeriesRef }) {
  const t = useTranslations('Site.listing')
  const part = partLabel(series, t)
  return (
    <>
      <LayersIcon size={14} className={META_ICON} />
      <Link href={`/series/${encodeURIComponent(series.slug)}`} className={KICKER_LINK}>
        <span className="block truncate">{series.title}</span>
      </Link>
      {/* The "·" dot is its own flex item, so both sides of it have the same gap-1.5 of the row. The previous version
          was "· " sharing a span with the part number: a 6px gap before the dot, a space of ~3.5px after it. The space
          between the two spans does not show (whitespace between flex items), kept only so textContent
          reads "· Part n/m". */}
      {part ? (
        <>
          <span aria-hidden="true">·</span> <span className="shrink-0 whitespace-nowrap">{part}</span>
        </>
      ) : null}
    </>
  )
}

/** A ReactNode that is "empty" in the displayed sense: not worth a kicker block. */
function isEmpty(node: ReactNode): boolean {
  return node === null || node === undefined || node === false || node === ''
}

/**
 * A post row, the only primitive for every post list of the site: /writing,
 * category, tag, search, home page, related posts (compact), and the series pages.
 *
 * Layout: text on the left, a 3:2 thumbnail on the right. Below 640px the 112×75 thumbnail sits beside the kicker
 * and title, while the meta, excerpt and tags run the full width below; from 640px the thumbnail
 * 160–224px spans the whole row vertically.
 *
 * The title is the ONLY accessible link to the post. The thumbnail is a link with the same href but
 * `aria-hidden`, `tabIndex={-1}`, `prefetch={false}`: clickable with the mouse, while keyboard and
 * screen reader users still meet one stop per post, as before there was a thumbnail.
 *
 * Meta via ReadingMeta (calendar, folder, clock icons; UTC timezone in one place), tags via TagList.
 * The kicker is a <div>, not a <p>: a row without an excerpt has no <p> at all.
 *
 * Server component, no hooks: renders on every server page and in tests as a function.
 */
export function ListRow({
  post,
  headingLevel,
  compact = false,
  showCategory = true,
  showTags = true,
  showExcerpt = true,
  kicker,
  query,
  titleSegments,
  excerptSegments,
}: ListRowProps) {
  const href = `/posts/${encodeURIComponent(post.slug)}`
  const Heading = headingLevel === 3 ? 'h3' : 'h2'
  const titleClass = compact ? TITLE_COMPACT : headingLevel === 3 ? TITLE_H3 : TITLE_H2

  const eyebrow = kicker !== undefined ? kicker : post.series ? <SeriesKicker series={post.series} /> : null

  const category = showCategory ? post.category : null
  const minutes = readingMinutesOf(post)
  const locale = asLocale(useLocale())
  const linkLocale = postLinkLocale(post, locale)
  // No items means no meta cell: an empty cell would still carry its margin into the grid.
  const hasMeta = formatDate(post.publishedAt, 'long', locale) !== null || Boolean(category) || minutes !== null

  const excerpt = showExcerpt ? (post.excerpt?.trim() ?? '') : ''
  const crop = showExcerpt && excerptSegments && joined(excerptSegments).trim() !== '' ? excerptSegments : null
  const title =
    titleSegments && joined(titleSegments) === post.title ? (
      <SegmentText segments={titleSegments} />
    ) : (
      <Highlight text={post.title} query={query} />
    )

  return (
    <article className={compact ? GRID_COMPACT : GRID}>
      <div className="col-start-1 row-start-1 min-w-0">
        {isEmpty(eyebrow) ? null : <div className={KICKER}>{eyebrow}</div>}
        <Heading className={titleClass}>
          <Link href={href} locale={linkLocale} className={`${TITLE_LINK} ${TITLE_TOUCH}`}>
            {title}
          </Link>
        </Heading>
      </div>

      <Link href={href} locale={linkLocale} aria-hidden="true" tabIndex={-1} prefetch={false} className={THUMB_LINK}>
        <PostCover post={post} variant="thumb" sizes={compact ? '6rem' : undefined} className={THUMB_HOVER} />
      </Link>

      {hasMeta ? (
        <ReadingMeta
          className={`${BELOW} ${compact ? 'mt-1' : 'mt-2'}`}
          publishedAt={post.publishedAt}
          category={category}
          tags={[]}
          readingMinutes={minutes}
        />
      ) : null}

      {crop || excerpt ? (
        // line-clamp-2 below 640px at 15px: on phones the excerpt runs full width below, and two
        // lines are enough to tell what the post is about; a row stays near 200px instead of pushing the next post away.
        <p
          className={`${BELOW} ${compact ? MEASURE_SMALL : MEASURE} text-neutral-700 line-clamp-2 sm:line-clamp-none dark:text-neutral-300 ${compact ? 'mt-2 text-sm' : 'mt-2 text-[0.9375rem] sm:mt-3 sm:text-base'}`}
        >
          {crop ? <SegmentText segments={crop} /> : <Highlight text={excerpt} query={query} />}
        </p>
      ) : null}

      {/* Tags from sm only: on a phone the chips add a 60px line to every row, and the tag pages are one tap away from the post. */}
      {showTags && post.tags.length > 0 ? (
        <div className={`${BELOW} mt-3 hidden sm:block`}>
          <TagList tags={post.tags} />
        </div>
      ) : null}
    </article>
  )
}
