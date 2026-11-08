import { useId } from 'react'
import { BLOCK_PROSE, BLOCK_WRAP } from './content-prose'
import type { BlockComponentProps } from './types'

/**
 * A titled panel around a Markdown table. The table is not drawn here: the pipeline wraps every table in its horizontal scroll
 * region (`.table-scroll`, a keyboard-focusable region named after the table's header cells), and that wrapper stays as it is, so
 * a wide table scrolls inside the panel instead of pushing the page sideways. The wrapper's CSS lives under `.prose`, which is why
 * the content keeps a `.prose` wrapper even though the panel itself is `not-prose`. The panel is a labelled group when it has a
 * title; the title is a paragraph, not a heading, so the outline the table of contents reads is unchanged.
 */
export function Comparison({ props, children }: BlockComponentProps<'comparison'>) {
  const titleId = useId()
  const { title, caption } = props

  return (
    <div
      data-block="comparison"
      {...(title ? { role: 'group', 'aria-labelledby': titleId } : {})}
      className="not-prose my-6 w-full max-w-full min-w-0 sm:my-8 sm:rounded-lg sm:border sm:border-neutral-200 sm:p-4 dark:sm:border-neutral-800"
    >
      {title ? (
        <p id={titleId} className={`mb-3 ${BLOCK_WRAP} text-base font-semibold text-neutral-900 dark:text-neutral-50`}>
          {title}
        </p>
      ) : null}
      <div className={`${BLOCK_PROSE} [&_.table-scroll]:my-0! max-sm:[&_.table-scroll_:is(th,td):first-child]:min-w-32`}>
        {children}
      </div>
      {caption ? <p className={`mt-3 ${BLOCK_WRAP} text-sm text-neutral-500 dark:text-neutral-400`}>{caption}</p> : null}
    </div>
  )
}
