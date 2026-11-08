import { useTranslations } from 'next-intl'
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import { CodeTabsView } from './CodeTabsView'
import { BLOCK_ROOT } from './structure-styles'
import type { BlockComponentProps } from './types'

/** Room around the content of a panel: unlike a code panel, it holds text, so it is not flush with the frame. */
const PANEL = 'p-4'

type TabElement = ReactElement<{ title: string }>

/**
 * The `tab` blocks of the body, in order, or null when the body holds anything else (text, another element, a tab that has no
 * title to be its label): then nothing is made a tab and the content is shown as it is, so nothing is lost. The pipeline hands
 * each child block over as an element of the block dispatcher (`./AiBlock.tsx`) whose props are the attributes of the directive, so
 * the label of a tab is its `title` prop; the newlines between the blocks are not content.
 */
function tabsOf(node: ReactNode): TabElement[] | null {
  const found: TabElement[] = []
  for (const child of Children.toArray(node)) {
    if (typeof child === 'string' && child.trim() === '') continue
    if (!isValidElement<{ block?: unknown; title?: unknown }>(child)) return null
    const { block, title } = child.props
    if (block !== 'tab' || typeof title !== 'string' || title === '') return null
    found.push(child as TabElement)
  }
  return found.length > 0 ? found : null
}

/**
 * The same task for different setups: one tab per `tab` block, labelled with its title, the content of one shown at a time. The
 * pipeline guarantees the body is tab blocks with unique titles (`validateBlocks`); this component still copes with what it is given
 * and falls back to the content as it is.
 *
 * A server component: every tab, with its Markdown and its nested blocks, is drawn here and handed to the client island
 * (`CodeTabsView`, the one of `code-tabs`), which only decides which panel shows and handles the keys. Every panel is in the HTML
 * and in the feed, so a reader of the source and a feed reader see every tab. The panels that are not selected are `hidden`, which the
 * browser's find-in-page and print skip, and if the script does not run only the first tab shows.
 */
export function Tabs({ props, children }: BlockComponentProps<'tabs'>) {
  const t = useTranslations('Site.blocks')
  const tabs = tabsOf(children)
  if (!tabs) {
    return (
      <div data-block="tabs" className={BLOCK_ROOT}>
        {children}
      </div>
    )
  }

  return (
    <div data-block="tabs" className={`${BLOCK_ROOT} my-6`}>
      <CodeTabsView
        title={props.title}
        groupLabel={props.title ?? t('tabsLabel')}
        labels={tabs.map((tab) => tab.props.title)}
        panels={tabs}
        panelClass={PANEL}
      />
    </div>
  )
}
