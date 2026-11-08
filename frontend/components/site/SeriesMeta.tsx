import { LayersIcon } from '@/components/icons'
import { formatDate } from '@/lib/date'
import { META_ICON } from './ReadingMeta'
import { useLocale, useTranslations } from 'next-intl'
import { asLocale } from '@/lib/format'

/**
 * A series' meta line: "[Layers] 3 parts · 36 min read · updated 5 October 2026" (in the site language). Used at
 * /series, /series/[slug] and /start-here.
 *
 * A flex row, each piece a flex item, `items-center`. The previous version was plain text running on inside an
 * `inline-flex` containing the icon: inline-flex takes its baseline from the SVG itself, so the "[Layers] 3 parts" group
 * stood 2px higher than the rest of the line (measured at 1440). The "·" dot is also its own flex item
 * (aria-hidden), with the same `gap-x-1.5` gap on both sides.
 *
 * The spaces between pieces do not show (whitespace between flex items), kept only so textContent reads
 * as a sentence: "3 parts · 36 min read" (in the site language), exactly the string the test and e2e look for.
 */
export function SeriesMeta({
  parts,
  minutes,
  updatedAt = null,
  className = '',
}: {
  parts: number
  minutes: number
  /** ISO; when present, adds "· updated <date>". An unreadable date drops the whole piece. */
  updatedAt?: string | null
  className?: string
}) {
  const t = useTranslations('Site.listing')
  const locale = asLocale(useLocale())
  const updated = updatedAt ? formatDate(updatedAt, 'long', locale) : null

  return (
    <p className={`flex flex-wrap items-center gap-x-1.5 text-sm text-neutral-600 dark:text-neutral-400 ${className}`.trim()}>
      <span className="inline-flex items-center gap-1.5">
        <LayersIcon size={14} className={META_ICON} />
        {t('seriesMeta.parts', { count: parts })}
      </span>{' '}
      <span aria-hidden="true">·</span> <span>{t('seriesMeta.readingMinutes', { minutes })}</span>
      {updatedAt && updated ? (
        <>
          {' '}
          <span aria-hidden="true">·</span>{' '}
          <span>
            {t.rich('seriesMeta.updated', { date: updated, time: (chunks) => <time dateTime={updatedAt}>{chunks}</time> })}
          </span>
        </>
      ) : null}
    </p>
  )
}
