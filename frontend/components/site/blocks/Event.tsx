import { BLOCK_WRAP } from './content-prose'
import { BLOCK_BODY, BLOCK_TITLE } from './structure-styles'
import type { BlockComponentProps } from './types'

/**
 * One event of `timeline`. A list item that leads with its `when` label as text (a date or a phase, free text), then its title and
 * its content. The marker on the line is drawn and hidden from assistive technology; a line joins it to the next event.
 */
export function Event({ props, children }: BlockComponentProps<'event'>) {
  return (
    <li
      data-block="event"
      className={[
        'relative min-w-0 max-w-full pb-8 pl-8 last:pb-0 @md:pl-10',
        // The line to the next event.
        'before:absolute before:bottom-0 before:left-[0.4375rem] before:top-5 before:w-px before:bg-neutral-300 last:before:hidden dark:before:bg-neutral-700 @md:before:left-[0.4375rem]',
      ].join(' ')}
    >
      <span
        aria-hidden="true"
        className="absolute left-0 top-1.5 size-3.5 rounded-full border-2 border-brand bg-white dark:bg-neutral-950"
      />
      <p className={`m-0 ${BLOCK_WRAP} text-sm font-medium leading-6 text-brand`}>{props.when}</p>
      <p className={`${BLOCK_TITLE} leading-6`}>{props.title}</p>
      {children ? <div className={`${BLOCK_BODY} mt-2`}>{children}</div> : null}
    </li>
  )
}
