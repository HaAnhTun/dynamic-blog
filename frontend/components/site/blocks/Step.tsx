import { BLOCK_BODY, BLOCK_TITLE } from './structure-styles'
import type { BlockComponentProps } from './types'

/**
 * One step of `steps`. A list item: its number is announced by the list, the drawn badge is hidden from assistive technology and
 * counts with a CSS counter that the list resets. In the sequential variant a line joins the badge to the next step; in the grouped
 * variant the step is a panel (both read the variant of the parent, see `./Steps.tsx`).
 */
export function Step({ props, children }: BlockComponentProps<'step'>) {
  return (
    <li
      data-block="step"
      className={[
        'relative min-w-0 max-w-full pb-8 pl-11 last:pb-0 @md:pl-12',
        // The line to the next step.
        'before:absolute before:bottom-0 before:left-4 before:top-9 before:w-px before:bg-neutral-300 last:before:hidden dark:before:bg-neutral-700',
        // The grouped variant: a panel, no line.
        'group-data-[variant=grouped]/steps:rounded-card group-data-[variant=grouped]/steps:border group-data-[variant=grouped]/steps:border-neutral-200 group-data-[variant=grouped]/steps:bg-neutral-50 group-data-[variant=grouped]/steps:p-4 group-data-[variant=grouped]/steps:pb-4 group-data-[variant=grouped]/steps:pl-14 group-data-[variant=grouped]/steps:before:hidden dark:group-data-[variant=grouped]/steps:border-neutral-800 dark:group-data-[variant=grouped]/steps:bg-neutral-900',
      ].join(' ')}
    >
      <span
        aria-hidden="true"
        className="absolute left-0 top-0 flex size-8 items-center justify-center rounded-full border border-brand bg-white text-sm font-semibold text-brand [counter-increment:blk-step] before:content-[counter(blk-step)] group-data-[variant=grouped]/steps:left-4 group-data-[variant=grouped]/steps:top-4 dark:bg-neutral-950"
      />
      <p className={`${BLOCK_TITLE} pt-1 leading-6`}>{props.title}</p>
      {children ? <div className={`${BLOCK_BODY} mt-2`}>{children}</div> : null}
    </li>
  )
}
