import { useTranslations } from 'next-intl'
import { BLOCK_ROOT } from './structure-styles'
import type { BlockComponentProps } from './types'

/** The path of the arrow of each trend: three different shapes (up, down, along), so the direction never depends on colour. */
const TREND_ARROWS = {
  up: 'M12 19V5M5 12l7-7 7 7',
  down: 'M12 5v14M19 12l-7 7-7-7',
  flat: 'M5 12h14M13 6l6 6-6 6',
} as const

/**
 * One figure of a `metrics` block, a list item that reads label, value, trend and note, in that order. The value is text, large, and
 * wraps when it is long. The trend is an arrow shape plus its word from the catalog, both in the neutral text color: a falling
 * latency is good news and a falling revenue is not, so the color would say something the author did not. The arrow is hidden from
 * assistive technology, the word is what it reads.
 */
export function Metric({ props }: BlockComponentProps<'metric'>) {
  const t = useTranslations('Site.blocks')
  return (
    <li
      data-block="metric"
      className={`${BLOCK_ROOT} flex flex-col gap-1 rounded-card border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900`}
    >
      <p className="m-0 text-sm font-medium [overflow-wrap:anywhere] text-neutral-600 dark:text-neutral-400">{props.label}</p>
      <p className="m-0 text-3xl leading-tight font-semibold [overflow-wrap:anywhere] text-neutral-900 dark:text-neutral-100">
        {props.value}
      </p>
      {props.trend ? (
        <p className="m-0 flex items-center gap-1.5 text-sm font-medium text-neutral-700 dark:text-neutral-300">
          <svg
            aria-hidden="true"
            data-trend={props.trend}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="size-4 shrink-0"
          >
            <path d={TREND_ARROWS[props.trend]} />
          </svg>
          <span>{t(`metric.trend.${props.trend}`)}</span>
        </p>
      ) : null}
      {props.note ? (
        <p className="m-0 text-sm [overflow-wrap:anywhere] text-neutral-600 dark:text-neutral-400">{props.note}</p>
      ) : null}
    </li>
  )
}
