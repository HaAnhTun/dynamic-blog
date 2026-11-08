import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { seriesCoverInput } from '@/lib/cover-art'
import type { SeriesSummary } from '@/lib/types'
import { postPath } from './ArticleJsonLd'
import { CoverArt } from './CoverArt'
import { MEASURE } from './reader/reader-layout'
import { INLINE_LINK, PHONE_BUTTON, PHONE_PRIMARY, TITLE_LINK, TITLE_TOUCH, TOUCH_ROW, TRANSITION } from './SectionHeading'
import { SeriesMeta } from './SeriesMeta'

/** Number of parts shown for each series; the rest are wrapped in "+k more parts". */
const PARTS_SHOWN = 5

export function seriesPath(slug: string): string {
  return `/series/${encodeURIComponent(slug)}`
}

/**
 * The grid of ListRow, rewritten verbatim because ListRow's constant is not exported and
 * Tailwind only generates classes it sees in source. Text left, a 3:2 thumbnail right; below 640px a
 * 7rem thumbnail sits beside the title, and the rest (description included) runs the full width below. Two rows
 * (`auto_1fr`): the `1fr` row takes the thumbnail's extra height, so the title is not pushed far from the lower part.
 */
const GRID =
  'grid grid-cols-[minmax(0,1fr)_7rem] gap-x-4 max-[400px]:grid-cols-[minmax(0,1fr)_6rem] sm:grid-cols-[minmax(0,1fr)_clamp(10rem,28%,14rem)] sm:grid-rows-[auto_1fr] sm:gap-x-8'
const THUMB_LINK = 'group col-start-2 row-start-1 self-start sm:row-span-2 sm:row-start-1'
const BELOW = 'col-span-2 sm:col-span-1 sm:col-start-1'

/** Like TITLE_H2/TITLE_H3 of ListRow: the h3 sits under a `text-xl` SectionHeading, so it does not grow
 *  from 640px — it must not be as large as the title of the section containing it. */
const TITLE: Record<2 | 3, string> = {
  2: 'text-lg font-medium tracking-tight break-words sm:text-xl',
  3: 'text-lg font-medium tracking-tight break-words',
}

/** PostCover's frame: hairline, rounded corners, paper-colored background; the border turns brand-colored on hover. */
const THUMB_FRAME = `relative block aspect-[3/2] overflow-hidden rounded-md border border-neutral-200 bg-neutral-100 dark:border-neutral-800 dark:bg-neutral-900 ${TRANSITION} group-hover:border-brand`

/**
 * One series: the name (the only accessible link to the series page), the series' cover art, description, meta,
 * the first five parts, "+k more parts", and the entry to part 1.
 *
 * The thumbnail is a link with the same href but `aria-hidden` + `tabIndex={-1}` like ListRow: the mouse can
 * click it, while keyboard and screen reader users meet one stop per series. The cover art is built from
 * `seriesCoverInput`: the same ink as the series' parts, its own layout.
 *
 * Used at /series (h2, the first five parts) and /start-here (h3 under "read by series", every part): the same
 * row of text left, image right as the post list right above it on both pages, instead of a narrow text column
 * leaving the right of the wide frame empty.
 */
export function SeriesEntry({
  series,
  headingLevel = 2,
  partsShown = PARTS_SHOWN,
  phonePartsShown,
  compact = false,
}: {
  series: SeriesSummary
  /** 2 right under the page's h1 (/series); 3 when under the h2 of a section (/start-here). */
  headingLevel?: 2 | 3
  /** Number of parts listed; `Infinity` means every part, with no "+k more parts". */
  partsShown?: number
  /**
   * Below `sm` only the first this-many of the listed parts are drawn, followed by "+k more parts" for the rest (the list is
   * a CSS fold, so from `sm` every listed part is still there). /start-here uses 3: seven parts of every series were 5,880px of phone.
   */
  phonePartsShown?: number
  /**
   * The home page form: title, description, thumbnail and the meta line (parts, minutes, last update), the way a featured post is
   * drawn there. No part list, no "+k more parts" and no "start at part one": the title is the way in.
   */
  compact?: boolean
}) {
  const t = useTranslations('Site.listing')
  const Heading = headingLevel === 3 ? 'h3' : 'h2'
  const href = seriesPath(series.slug)
  const shown = series.parts.slice(0, partsShown)
  const more = series.parts.length - shown.length
  const first = series.parts[0]
  const phoneLimit = phonePartsShown !== undefined && phonePartsShown < shown.length ? phonePartsShown : undefined
  const phoneMore = phoneLimit === undefined ? 0 : series.parts.length - phoneLimit

  return (
    <article className={GRID}>
      {/* Name and description: from 640px one text cell right next to the thumbnail. Below it the cell is `contents`, so the name
          stays beside the thumbnail and the description runs the full width under both, like the excerpt of a ListRow (a
          description in the narrow column was four lines beside an empty strip once the name was shorter than the thumbnail). */}
      <div className="col-start-1 row-start-1 min-w-0 max-sm:contents">
        <Heading className={`${TITLE[headingLevel]} max-sm:col-start-1 max-sm:row-start-1 max-sm:min-w-0 max-sm:leading-snug`}>
          <Link href={href} className={`${TITLE_LINK} ${TITLE_TOUCH}`}>
            {series.title}
          </Link>
        </Heading>
        {series.description ? (
          <p className={`mt-2 ${MEASURE} text-[0.9375rem] text-neutral-700 max-sm:col-span-2 sm:text-base dark:text-neutral-300`}>
            {series.description}
          </p>
        ) : null}
      </div>

      <Link href={href} aria-hidden="true" tabIndex={-1} prefetch={false} className={THUMB_LINK}>
        <span className={THUMB_FRAME}>
          <CoverArt input={seriesCoverInput(series)} />
        </span>
      </Link>

      <div className={BELOW}>
        <SeriesMeta
          parts={series.postCount}
          minutes={series.readingMinutes}
          updatedAt={series.latestPublishedAt}
          className="mt-2"
        />

        {!compact && shown.length > 0 ? (
          // A link-dense list: prefetch off, like every other link-dense list of the site.
          <ol className="mt-2 list-decimal pl-6 text-[0.9375rem] marker:text-neutral-500 max-sm:list-none max-sm:pl-0 sm:mt-3 sm:space-y-1 sm:pl-5 sm:text-sm dark:marker:text-neutral-400">
            {shown.map((part, index) => (
              <li
                key={part.slug}
                className={`max-sm:flex max-sm:items-center max-sm:border-t max-sm:border-neutral-200 max-sm:first:border-t-0 dark:max-sm:border-neutral-800${
                  phoneLimit !== undefined && index >= phoneLimit ? ' max-sm:hidden' : ''
                }`}
              >
                {/* Below sm the number is drawn by hand in a 24px gutter (the native marker is off), so the title column is the same on every row. */}
                <span aria-hidden="true" className="w-6 shrink-0 text-neutral-500 sm:hidden dark:text-neutral-400">
                  {index + 1}.
                </span>
                <Link
                  href={postPath(part.slug)}
                  prefetch={false}
                  className={`${INLINE_LINK} ${TOUCH_ROW} min-w-0 max-sm:flex-1 max-sm:no-underline`}
                >
                  {part.title}
                </Link>
              </li>
            ))}
          </ol>
        ) : null}

        {/* Each series has a pair of links with the same text: the sr-only part tells screen readers which
            series it is when they list links out of context. The space sits OUTSIDE the sr-only span — the way
            the accessible name is computed in the test trims the leading whitespace of the span and glues the two words. */}
        {!compact && phoneMore > 0 ? (
          <p className="mt-1 text-sm sm:hidden">
            <Link href={href} className={`${INLINE_LINK} ${TOUCH_ROW}`}>
              {t('seriesEntry.moreParts', { count: phoneMore })}{' '}
              <span className="sr-only">{t('seriesEntry.ofSeries', { title: series.title })}</span>
            </Link>
          </p>
        ) : null}
        {!compact && more > 0 ? (
          <p className={`mt-1 text-sm sm:mt-2${phoneLimit !== undefined ? ' max-sm:hidden' : ''}`}>
            <Link href={href} className={`${INLINE_LINK} ${TOUCH_ROW}`}>
              {t('seriesEntry.moreParts', { count: more })}{' '}
              <span className="sr-only">{t('seriesEntry.ofSeries', { title: series.title })}</span>
            </Link>
          </p>
        ) : null}

        {!compact && first ? (
          <p className="mt-2 text-sm font-medium sm:mt-3">
            {/* The phone button recipe of the series page: a 44px filled button below sm, the underlined link from sm. */}
            <Link href={postPath(first.slug)} className={`${INLINE_LINK} ${PHONE_BUTTON} ${PHONE_PRIMARY}`}>
              {t('seriesEntry.startAtPartOne')}{' '}
              <span className="sr-only">{t('seriesEntry.ofSeries', { title: series.title })} </span>
              <span aria-hidden="true">→</span>
            </Link>
          </p>
        ) : null}
      </div>
    </article>
  )
}
