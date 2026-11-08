import { BLOCK_BODY, BLOCK_ROOT } from './structure-styles'
import type { BlockComponentProps } from './types'

/**
 * The content of one tab of `tabs`. Its title is the label of its tab, read from the props of this element by `./Tabs.tsx`, and the
 * panel around it (a `tabpanel` named by that tab) comes from the island, so neither is drawn here: a second name would be read twice.
 * The Markdown and the nested blocks use the shared block typography, without the margin of the first and the last child.
 */
export function Tab({ children }: BlockComponentProps<'tab'>) {
  return (
    <div data-block="tab" className={`${BLOCK_ROOT} ${BLOCK_BODY}`}>
      {children}
    </div>
  )
}
