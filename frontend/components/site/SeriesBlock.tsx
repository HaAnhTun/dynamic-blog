import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { LayersIcon } from '@/components/icons'
import { SERIES_FULL_LIST_MAX, seriesRows } from '@/lib/series-rows'
import type { SeriesDetail } from '@/lib/types'
import { FOCUS, FOCUS_RING, TITLE_LINK, TRANSITION } from './SectionHeading'

export { SERIES_FULL_LIST_MAX, seriesRows, type SeriesRow } from '@/lib/series-rows'

/** A left-ruled row like Timeline: the row's 2px border overlays the list's 1px rule (`-ml-px`). */
const ROW = '-ml-px flex gap-3 border-l-2 py-1.5 pl-4'
const PART_LINK = `${ROW} border-transparent text-neutral-600 hover:border-neutral-400 hover:text-brand dark:text-neutral-400 dark:hover:border-neutral-500 ${FOCUS_RING} ${TRANSITION}`
const PART_CURRENT = `${ROW} border-brand font-medium text-neutral-900 dark:text-neutral-100`
const NUMBER = 'w-5 shrink-0 tabular-nums text-neutral-500 dark:text-neutral-400'

const SECTION_ID = 'series-cua-bai'

/**
 * The series block in the post page, between the post's top image and the table of contents.
 *
 * A `<nav>` named after the series (aria-labelledby points at the visible name): it is the way between
 * parts, as PostNav is the way between posts. A left-ruled list in the Timeline style; the part being read
 * is not a link (a link to the page already open is a useless keyboard stop), it carries a brand bar,
 * `aria-current="true"` and sr-only "currently reading" text for people who cannot see that bar.
 *
 * "Part n/m" and the number on each row count by position in `series.posts` — the PUBLISHED parts in
 * reading order, which is exactly the meaning of `partNumber`/`partCount` — never by the stored `position`, which may
 * have gaps. No progress bar: "Part 2/3" already says enough.
 *
 * A post not among the published parts (cached data out of sync) does not render: a series
 * block with no part being read is a misplaced list.
 */
export function SeriesBlock({ series, currentSlug }: { series: SeriesDetail; currentSlug: string }) {
  const t = useTranslations('Site.seriesBlock')
  const parts = series.posts
  const current = parts.findIndex((part) => part.slug === currentSlug)
  if (current === -1) return null

  const rows = seriesRows(parts.length, current)
  const windowed = parts.length > SERIES_FULL_LIST_MAX
  const seriesHref = `/series/${encodeURIComponent(series.slug)}`

  return (
    <nav aria-labelledby={SECTION_ID} className="mt-8">
      <p className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-neutral-600 uppercase dark:text-neutral-400">
        <LayersIcon size={14} />
        {t('partOf', { current: current + 1, total: parts.length })}
      </p>
      <p id={SECTION_ID} className="mt-1 font-medium break-words">
        <Link href={seriesHref} className={TITLE_LINK}>
          {series.title}
        </Link>
      </p>

      {/* <ol>: the order is the meaning of the list. The "…" row is aria-hidden, so the screen reader
          counts exactly the number of parts being shown, and the number on each row says which part was skipped. */}
      <ol className="mt-3 border-l border-neutral-200 text-sm dark:border-neutral-800">
        {rows.map((row) => {
          if (row.kind === 'gap') {
            return (
              <li
                key={`gap-${row.after}`}
                aria-hidden="true"
                className={`${ROW} border-transparent text-neutral-400 dark:text-neutral-500`}
              >
                <span className={NUMBER}>…</span>
              </li>
            )
          }

          const part = parts[row.index]!
          const number = (
            <span className={NUMBER} data-part-number="">
              {row.index + 1}
            </span>
          )

          if (row.index === current) {
            return (
              <li key={part.id} aria-current="true">
                <span className={PART_CURRENT}>
                  {number}{' '}
                  <span className="min-w-0 break-words">
                    {part.title}
                    <span className="sr-only"> {t('currentPart')}</span>
                  </span>
                </span>
              </li>
            )
          }

          return (
            <li key={part.id}>
              {/* The space between the number and the title is a separate text node: an accessible name joining the text of
                  child spans does not insert whitespace by itself (see PostNav), so without it a screen
                  reader reads the number glued to the title. Inside flex it takes no room. */}
              <Link href={`/posts/${encodeURIComponent(part.slug)}`} className={PART_LINK}>
                {number} <span className="min-w-0 break-words">{part.title}</span>
              </Link>
            </li>
          )
        })}
      </ol>

      {windowed ? (
        <Link
          href={seriesHref}
          className={`mt-3 inline-block text-sm font-medium text-brand hover:underline hover:underline-offset-4 ${FOCUS} ${TRANSITION}`}
        >
          {t.rich('viewAll', { arrow: (chunks) => <span aria-hidden="true">{chunks}</span> })}
        </Link>
      ) : null}
    </nav>
  )
}
