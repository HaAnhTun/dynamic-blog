import { ChevronRightIcon } from '@/components/icons'
import { BLOCK_WRAP } from './content-prose'
import { BLOCK_BODY, BLOCK_ROOT, FOCUS_RING } from './structure-styles'
import type { BlockComponentProps } from './types'

const INLINE = 'rounded-card border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950'
const APPENDIX =
  'rounded-card border border-dashed border-neutral-300 bg-neutral-50 text-[0.95em] dark:border-neutral-700 dark:bg-neutral-900'

/**
 * Expandable details on the platform's own element: closed unless `open` is set, operated by Enter and Space on the summary with no
 * script, found by the browser's in-page search. The root is the `details` element itself. The summary shows a visible focus ring
 * and its chevron turns (and stops turning for readers who ask for less motion). The title is the summary, never a heading.
 *
 * `group` is the native `name` attribute: the details of one group, such as the questions of an FAQ, open one at a time, with no script.
 * A browser that does not know the attribute shows them as independent details, which still works; the name belongs to the whole
 * page, so two groups of one article need two names.
 */
export function Details({ props, children }: BlockComponentProps<'details'>) {
  return (
    <details
      data-block="details"
      data-variant={props.variant}
      open={props.open}
      name={props.group}
      className={`${BLOCK_ROOT} group/details my-6 ${props.variant === 'appendix' ? APPENDIX : INLINE}`}
    >
      <summary
        className={`${FOCUS_RING} flex cursor-pointer list-none items-start gap-2 rounded-card px-4 py-3 font-medium text-neutral-900 marker:hidden dark:text-neutral-100 [&::-webkit-details-marker]:hidden`}
      >
        <ChevronRightIcon
          size={16}
          className="mt-1 text-neutral-500 transition-transform duration-150 group-open/details:rotate-90 motion-reduce:transition-none dark:text-neutral-400"
        />
        <span className={`min-w-0 ${BLOCK_WRAP}`}>{props.title}</span>
      </summary>
      <div className={`${BLOCK_BODY} border-t border-neutral-200 px-4 py-4 dark:border-neutral-800`}>{children}</div>
    </details>
  )
}
