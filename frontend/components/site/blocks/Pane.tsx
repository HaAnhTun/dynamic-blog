import { useId } from 'react'
import { BLOCK_PROSE, BLOCK_WRAP } from './content-prose'
import type { BlockComponentProps } from './types'

/**
 * One pane of a compare block: a bordered card with its title on top and Markdown (text, code, images) below. It is a labelled
 * group, so a screen reader announces the title before the content of each pane in turn. The title is a paragraph, not a heading,
 * because a heading here would change the outline of the article that the table of contents is built from. The id is generated
 * per pane, so two compare blocks in one article never share a label.
 */
export function Pane({ props, children }: BlockComponentProps<'pane'>) {
  const titleId = useId()

  return (
    <div
      role="group"
      aria-labelledby={titleId}
      data-block="pane"
      className="not-prose w-full max-w-full min-w-0 rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950"
    >
      <p
        id={titleId}
        className={`border-b border-neutral-200 px-4 py-2 ${BLOCK_WRAP} text-sm font-semibold text-neutral-900 dark:border-neutral-800 dark:text-neutral-50`}
      >
        {props.title}
      </p>
      <div className={`${BLOCK_PROSE} px-4 py-3`}>{children}</div>
    </div>
  )
}
