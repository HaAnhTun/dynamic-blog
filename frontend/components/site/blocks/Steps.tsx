import { useTranslations } from 'next-intl'
import { useId } from 'react'
import { BLOCK_ROOT, BLOCK_TITLE } from './structure-styles'
import type { BlockComponentProps } from './types'

/**
 * A numbered procedure: an ordered list of `step` blocks. The numbers are real list numbers for assistive technology (`role="list"`
 * keeps the semantics that `list-style: none` removes in some screen readers); the drawn badges of the steps count with a CSS counter
 * and are hidden from it. The title is a paragraph, not a heading, so the table of contents stays right.
 *
 * The list modifiers are important: inside the body of a tab or a details block the shared prose rules `[&_ol]:list-decimal` and
 * `[&_ol]:ps-6` are more specific than a plain class and would draw a number and an indent next to the badges.
 *
 * `sequential` joins the steps by a line, `grouped` sets each step in its own panel: the steps style themselves from the
 * `data-variant` of this block (`group-data-*`), so a step needs no prop of its own.
 */
export function Steps({ props, children }: BlockComponentProps<'steps'>) {
  const t = useTranslations('Site.blocks')
  const titleId = useId()
  return (
    <div data-block="steps" data-variant={props.variant} className={`${BLOCK_ROOT} group/steps @container my-6 sm:my-8`}>
      {props.title ? (
        <p id={titleId} className={`${BLOCK_TITLE} mb-4 text-lg`}>
          {props.title}
        </p>
      ) : null}
      <ol
        role="list"
        aria-labelledby={props.title ? titleId : undefined}
        aria-label={props.title ? undefined : t('stepsLabel')}
        className="m-0 flex list-none! flex-col gap-0 p-0! ps-0! [counter-reset:blk-step] group-data-[variant=grouped]/steps:gap-4"
      >
        {children}
      </ol>
    </div>
  )
}
