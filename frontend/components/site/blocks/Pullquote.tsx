import { BLOCK_WRAP } from './content-prose'
import { BLOCK_ROOT } from './structure-styles'
import type { BlockComponentProps } from './types'

/**
 * A short quotation set large: a `blockquote` whose attribution is part of it (a `footer`), as the registry says. Typography is the
 * block's own, not the article's, so it reads as a quotation and not as a quoted paragraph. The article body is `.prose`, and the
 * `.prose blockquote` rules of app/globals.css are out of any layer, so they beat plain utilities (a 2px rule, weight 400, gray
 * text): the rule width, weight and text colors below are important (`!`), like the ones of the code block, to stay the block's own.
 */
export function Pullquote({ props, children }: BlockComponentProps<'pullquote'>) {
  return (
    <blockquote
      data-block="pullquote"
      className={`${BLOCK_ROOT} my-8 sm:my-10 border-l-4! border-brand py-1 pl-5 text-xl font-medium! leading-snug text-neutral-900! sm:text-2xl dark:text-neutral-100!`}
    >
      <div className={`min-w-0 ${BLOCK_WRAP} [&>:first-child]:mt-0 [&>:last-child]:mb-0 [&_p]:m-0 [&_p+p]:mt-3`}>{children}</div>
      {props.attribution ? (
        <footer className={`mt-3 ${BLOCK_WRAP} text-sm font-normal text-neutral-600 dark:text-neutral-400`}>
          {'— '}
          {props.attribution}
        </footer>
      ) : null}
    </blockquote>
  )
}
