import { useTranslations } from 'next-intl'
import { useId } from 'react'
import { BLOCK_BODY_BASE, BLOCK_ROOT, BLOCK_TITLE } from './structure-styles'
import type { BlockComponentProps } from './types'

/**
 * The key points of the article: a Markdown list in a labelled group. The title is a paragraph, not a heading; without a title the
 * group takes a default name from the catalog, so the list is never anonymous.
 */
export function Takeaways({ props, children }: BlockComponentProps<'takeaways'>) {
  const t = useTranslations('Site.blocks')
  const titleId = useId()
  return (
    <div
      data-block="takeaways"
      role="group"
      aria-labelledby={props.title ? titleId : undefined}
      aria-label={props.title ? undefined : t('takeawaysLabel')}
      className={`${BLOCK_ROOT} my-6 sm:my-8 rounded-card border border-brand/30 bg-brand/5 p-5 dark:border-brand/40 dark:bg-brand/10`}
    >
      {props.title ? (
        <p id={titleId} className={`${BLOCK_TITLE} mb-3 text-lg`}>
          {props.title}
        </p>
      ) : null}
      <div className={`${BLOCK_BODY_BASE} [&_li::marker]:text-brand`}>{children}</div>
    </div>
  )
}
