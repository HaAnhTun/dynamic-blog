import { useLocale, useTranslations } from 'next-intl'
import type { Locale } from '@/i18n/config'
import { formatDate } from '@/lib/date'
import { asLocale, numberFormat } from '@/lib/format'
import type { AnalyticsDay } from '@/lib/types'

/**
 * Drawing frame in viewBox units. The SVG stretches with the frame width (`preserveAspectRatio="none"`), so it holds
 * no text (text would distort): the axis ticks and the first and last day are HTML.
 */
const WIDTH = 720
const HEIGHT = 120

/** Upper axis tick: 1, 2 or 5 times a power of 10, not smaller than `value`. */
export function niceCeil(value: number): number {
  if (value <= 1) return 1
  const power = 10 ** Math.floor(Math.log10(value))
  return ([1, 2, 5].find((step) => step * power >= value) ?? 10) * power
}

function dayLabel(day: string, locale: Locale): string {
  return formatDate(day, 'medium', locale) ?? day
}

const round = (value: number) => Math.round(value * 100) / 100

/**
 * Bars of views per day, drawn on the server, no library. Only for a quick look: `role="img"` with a one-line summary, the
 * per-day numbers are in the table right below. Hovering a day shows the date and number (`<title>`), not required to read the numbers.
 */
export function DailyChart({ days, since }: { days: AnalyticsDay[]; since: string | null }) {
  const locale = asLocale(useLocale())
  const t = useTranslations('Admin.analytics.chart')
  if (days.length === 0) return null
  const peak = days.reduce((best, day) => (day.views > best.views ? day : best))
  const total = days.reduce((sum, day) => sum + day.views, 0)
  const top = niceCeil(peak.views)
  const slot = WIDTH / days.length
  // A 2-unit gap between bars, widest bar 24. A long range makes bars too thin to leave a gap: the bars join into one band.
  const bar = slot < 6 ? slot : Math.min(slot - 2, 24)
  const first = days[0].day
  const last = days[days.length - 1].day
  const label = t('summary', {
    from: dayLabel(first, locale),
    to: dayLabel(last, locale),
    total,
    peak: peak.views,
    peakDay: dayLabel(peak.day, locale),
  })

  return (
    <div className="mt-4">
      <p aria-hidden="true" className="text-[11px] leading-4 tabular-nums text-slate-500">
        {numberFormat(locale).format(top)}
      </p>
      {/* Bar colour and hover colour are set once on the <svg>: SVG fill is inherited, so 366 bars carry no class. A
          transparent cell covers the full height of a day, so hovering the empty space above a bar also shows the number. */}
      <svg
        role="img"
        aria-label={label}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="mt-1 block h-32 w-full overflow-visible fill-slate-600 [&>g:hover]:fill-slate-900"
      >
        <line x1={0} y1={0} x2={WIDTH} y2={0} vectorEffect="non-scaling-stroke" className="stroke-slate-200" />
        {days.map((day, index) => {
          const x = index * slot
          const height = day.views === 0 ? 0 : Math.max((day.views / top) * HEIGHT, 1.5)
          const title =
            since !== null && day.day < since
              ? t('barNoData', { date: dayLabel(day.day, locale) })
              : t('bar', { date: dayLabel(day.day, locale), views: day.views })
          return (
            <g key={day.day}>
              <title>{title}</title>
              <rect x={round(x)} y={0} width={round(slot)} height={HEIGHT} fill="transparent" />
              {height > 0 && (
                <rect x={round(x + (slot - bar) / 2)} y={round(HEIGHT - height)} width={round(bar)} height={round(height)} />
              )}
            </g>
          )
        })}
        <line x1={0} y1={HEIGHT} x2={WIDTH} y2={HEIGHT} vectorEffect="non-scaling-stroke" className="stroke-slate-300" />
      </svg>
      <div aria-hidden="true" className="mt-1.5 flex justify-between gap-4 text-[11px] leading-4 text-slate-500">
        <span>{dayLabel(first, locale)}</span>
        {days.length > 1 && <span>{dayLabel(last, locale)}</span>}
      </div>
    </div>
  )
}
