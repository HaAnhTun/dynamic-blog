import { Children } from 'react'
import type { BlockComponentProps } from './types'

/**
 * Two or three panes side by side when the block is wide enough, stacked when it is not. The switch follows the width of the block
 * itself (container queries), so the same comparison fits a wide article and a narrow one, and no window width is assumed. Three
 * panes need more room than two. Before-after (exactly two panes) puts an arrow between them, drawn only, so it is skipped by
 * screen readers: the order of the panes and their titles already say it.
 */
export function Compare({ props, children }: BlockComponentProps<'compare'>) {
  const { variant } = props
  const panes = Children.toArray(children)
  const beforeAfter = variant === 'before-after' && panes.length === 2
  const columns = beforeAfter
    ? 'grid-cols-1 @xl:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]'
    : panes.length === 3
      ? 'grid-cols-1 @3xl:grid-cols-3'
      : 'grid-cols-1 @xl:grid-cols-2'

  return (
    <div data-block="compare" data-variant={variant} className="not-prose @container my-6 sm:my-8 w-full max-w-full min-w-0">
      <div className={`grid items-start gap-4 ${columns}`}>
        {beforeAfter ? (
          <>
            {panes[0]}
            <svg
              aria-hidden="true"
              focusable="false"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="mx-auto h-6 w-6 shrink-0 rotate-90 self-center text-neutral-500 @xl:rotate-0 dark:text-neutral-400"
            >
              <path d="M5 12h14" />
              <path d="m13 6 6 6-6 6" />
            </svg>
            {panes[1]}
          </>
        ) : (
          panes
        )}
      </div>
    </div>
  )
}
