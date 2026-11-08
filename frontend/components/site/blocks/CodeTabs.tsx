import { useTranslations } from 'next-intl'
import { Children, cloneElement, Fragment, isValidElement, type ReactElement, type ReactNode } from 'react'
import { CodeBlock } from '../CodeBlock'
import { CodeTabsView } from './CodeTabsView'
import { BLOCK_ROOT } from './structure-styles'
import type { BlockComponentProps } from './types'

type Panel = ReactElement<Record<string, unknown>>

/**
 * The code blocks of the body, in order, or null when the body holds anything else (text, another element): then nothing is made
 * a tab and the content is shown as it is, so nothing is lost. The pipeline hands each highlighted block over inside a fragment
 * (Shiki replaces the `<pre>` with a small tree of its own), so the search looks through fragments; the newlines between the
 * blocks are not content.
 */
function codeBlocksOf(node: ReactNode): Panel[] | null {
  const found: Panel[] = []
  for (const child of Children.toArray(node)) {
    if (typeof child === 'string' && child.trim() === '') continue
    if (!isValidElement(child)) return null
    if (child.type === Fragment) {
      const inner = codeBlocksOf((child.props as { children?: ReactNode }).children)
      if (!inner) return null
      found.push(...inner)
    } else if (child.type === CodeBlock) {
      found.push(child as Panel)
    } else {
      return null
    }
  }
  return found
}

/** The label a code block carries as its tab: the title of its fence (`data-title`, set by `components/site/CodeBlock.tsx`). */
function titleOf(panel: Panel): string | null {
  const title = panel.props['data-title']
  return typeof title === 'string' && title !== '' ? title : null
}

/**
 * The same thing in several languages or files: one tab per fenced code block, labelled with the title of its fence. The pipeline
 * guarantees the body is code blocks, each with a title (`validateBlocks`); this component still copes with what it is given, a
 * code block without a title gets the number of its place and anything that is not an element (the newlines between the blocks) is
 * ignored.
 *
 * A server component: the code blocks, with their highlighting and copy buttons, are drawn here and handed to the client island
 * (`CodeTabsView`), which only decides which panel shows. The fence title is taken off the panel's code block, since the tab
 * already says it.
 */
export function CodeTabs({ props, children }: BlockComponentProps<'code-tabs'>) {
  const t = useTranslations('Site.blocks.codeTabs')
  const blocks = codeBlocksOf(children)
  if (!blocks || blocks.length === 0) {
    return (
      <div data-block="code-tabs" className={BLOCK_ROOT}>
        {children}
      </div>
    )
  }

  return (
    <div data-block="code-tabs" className={`${BLOCK_ROOT} my-6`}>
      <CodeTabsView
        title={props.title}
        groupLabel={props.title ?? t('label')}
        labels={blocks.map((block, index) => titleOf(block) ?? t('tab', { n: index + 1 }))}
        panels={blocks.map((block) => (titleOf(block) === null ? block : cloneElement(block, { 'data-title': undefined })))}
      />
    </div>
  )
}
