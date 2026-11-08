import { useTranslations } from 'next-intl'
import { useId } from 'react'
import { BLOCK_ROOT, BLOCK_TITLE } from './structure-styles'
import type { BlockComponentProps } from './types'

/**
 * Dated or phased events in order: an ordered list of `event` blocks joined by a vertical line, one marker per event. The line and
 * the markers are drawn in CSS and hidden from assistive technology; the label of each event is plain text that leads the item, so
 * the order and the meaning survive without any styling. The title is a paragraph, not a heading, so the table of contents stays right.
 */
export function Timeline({ props, children }: BlockComponentProps<'timeline'>) {
  const t = useTranslations('Site.blocks')
  const titleId = useId()
  return (
    <div data-block="timeline" className={`${BLOCK_ROOT} @container my-6 sm:my-8`}>
      {props.title ? (
        <p id={titleId} className={`${BLOCK_TITLE} mb-4 text-lg`}>
          {props.title}
        </p>
      ) : null}
      <ol
        role="list"
        aria-labelledby={props.title ? titleId : undefined}
        aria-label={props.title ? undefined : t('timelineLabel')}
        className="m-0 flex list-none flex-col gap-0 p-0"
      >
        {children}
      </ol>
    </div>
  )
}
