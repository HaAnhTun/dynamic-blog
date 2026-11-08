import { useTranslations } from 'next-intl'
import { useId } from 'react'
import { BLOCK_WRAP } from './content-prose'
import { BLOCK_ROOT, BLOCK_TITLE } from './structure-styles'
import type { BlockComponentProps } from './types'

/**
 * The classes of the tree. The block root is `not-prose`, so the plain list, code and link styles are written out here (the shared
 * block typography brings bullets and a left padding that a tree does not want). Whole class names, because Tailwind reads the source.
 *
 * - lists: no marker; the important modifiers keep the bullets and the 1.5rem indent of the body of a tab, a step or a details block
 *   (`[&_ul]:list-disc`, `[&_ul]:ps-6`) away from the tree, and the nested indent is important too so it still wins over the flush rule;
 *   the first list sits flush, every deeper list gets a start border as its tree line and a small indent (logical
 *   properties, so the tree mirrors in a right-to-left page);
 * - a folder is an item that holds a list: heavier weight through `li:has(>ul)`, and the nested list takes the normal weight back so
 *   only the folder name itself is heavy. The trailing slash in the text is the signal for everyone; the weight is an extra;
 * - inline code and links are styled as in the other blocks; the text wraps anywhere, so a long name never widens the frame.
 */
const TREE_BODY = [
  'font-mono text-sm leading-7 text-neutral-800 dark:text-neutral-200',
  '[&_ul]:m-0 [&_ul]:list-none! [&_ul]:p-0! [&_ul]:ps-0! [&_p]:m-0',
  '[&_ul_ul]:ms-2 [&_ul_ul]:ps-3! [&_ul]:border-neutral-300 dark:[&_ul]:border-neutral-600 [&_ul_ul]:border-s',
  '[&_ul]:font-normal [&_li:has(>ul)]:font-semibold',
  '[&_code]:rounded [&_code]:bg-transparent [&_code]:p-0 [&_code]:font-[inherit] [&_code]:text-[inherit]',
  '[&_a]:text-brand [&_a]:underline [&_a]:decoration-brand/50 [&_a]:underline-offset-4',
  `overflow-x-auto ${BLOCK_WRAP}`,
].join(' ')

/**
 * A directory structure drawn from a nested Markdown list. The list stays a real nested list, so a screen reader announces the
 * depth; a folder is told apart by the trailing slash in its text, never by an icon. The title is a paragraph, not a heading; without
 * a title the group takes a default name from the catalog.
 */
export function FileTree({ props, children }: BlockComponentProps<'file-tree'>) {
  const t = useTranslations('Site.blocks')
  const titleId = useId()
  return (
    <div
      data-block="file-tree"
      role="group"
      aria-labelledby={props.title ? titleId : undefined}
      aria-label={props.title ? undefined : t('fileTreeLabel')}
      className={`${BLOCK_ROOT} my-6 rounded-card border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-700 dark:bg-neutral-900`}
    >
      {props.title ? (
        <p id={titleId} className={`${BLOCK_TITLE} mb-3 text-base`}>
          {props.title}
        </p>
      ) : null}
      <div className={TREE_BODY}>{children}</div>
    </div>
  )
}
