import { useTranslations } from 'next-intl'
import { Children, useId } from 'react'
import { BLOCK_ROOT, BLOCK_TITLE } from './structure-styles'
import type { BlockComponentProps } from './types'

/**
 * Key figures side by side: a list of `metric` blocks in a grid that answers to the width of its own column (container queries), one
 * figure per row when narrow, two and then three across when there is room. The list keeps its semantics for assistive technology
 * (`role="list"` survives `list-style: none`), and it is named by the title, or by a default label from the catalog. The title is a
 * paragraph, not a heading, so the table of contents of the article stays right. The caption says where the figures come from.
 */
export function Metrics({ props, children }: BlockComponentProps<'metrics'>) {
  const t = useTranslations('Site.blocks')
  const titleId = useId()
  // Four figures stay two across (two rows of two): in three columns the fourth card would stand alone on a second row.
  const columns = Children.count(children) === 4 ? '@lg:grid-cols-2' : '@lg:grid-cols-2 @2xl:grid-cols-3'
  return (
    <div data-block="metrics" className={`${BLOCK_ROOT} @container my-6 sm:my-8`}>
      {props.title ? (
        <p id={titleId} className={`${BLOCK_TITLE} mb-4 text-lg`}>
          {props.title}
        </p>
      ) : null}
      <ul
        role="list"
        aria-labelledby={props.title ? titleId : undefined}
        aria-label={props.title ? undefined : t('metricsLabel')}
        className={`m-0 grid list-none grid-cols-1 gap-3 p-0 ${columns}`}
      >
        {children}
      </ul>
      {props.caption ? (
        <p className="m-0 mt-3 text-sm [overflow-wrap:anywhere] text-neutral-600 dark:text-neutral-400">{props.caption}</p>
      ) : null}
    </div>
  )
}
