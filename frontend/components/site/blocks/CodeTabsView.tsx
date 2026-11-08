'use client'

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { BLOCK_TITLE } from './structure-styles'
import { SCROLL_CUE, useScrollCue } from './use-scroll-cue'

/**
 * A tab is a button in a row; the selected one has the brand colour under it. The focus ring is drawn inside the button
 * (negative offset): the row scrolls sideways when it is too narrow, and a scroll container would clip a ring drawn outside.
 * Text on the tint: neutral-600 on neutral-50 is 7.3:1, neutral-400 on neutral-900 is 7.9:1; the selected tab is darker still.
 */
const TAB =
  '-mb-px shrink-0 cursor-pointer border-b-2 px-4 py-2 text-sm font-medium whitespace-nowrap max-sm:min-h-11 sm:text-xs transition-colors duration-[120ms] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand motion-reduce:transition-none'
const TAB_SELECTED = 'border-brand text-neutral-900 dark:text-white'
const TAB_IDLE = 'border-transparent text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-white'

/**
 * Inside the panel the code blocks lose the frame of a lone block (the typography plugin does not reach into `not-prose`, and the
 * rules of app/globals.css that do are out of any layer, so only `!` beats them): the group draws one border, the panel only keeps
 * the lower corners.
 */
const PANEL =
  '[&_pre]:m-0 [&_pre]:overflow-x-auto [&_pre]:rounded-t-none! [&_pre]:rounded-b-[calc(0.5rem-1px)]! [&_pre]:border-0! [&_pre]:text-sm [&_pre]:leading-[1.7]'

type Props = {
  /** The visible heading of the group, when the author gave one. */
  title?: string
  /** The accessible name of the row of tabs. */
  groupLabel: string
  /** One label per panel, already resolved (a panel without a title has its number). */
  labels: string[]
  /** The panels, drawn on the server (code blocks, or the content of the tab blocks of `tabs`); every one is in the page, only the selected one is shown. */
  panels: ReactNode[]
  /** The classes of every panel. The default suits code blocks; `tabs` gives its own, since its panels hold anything. */
  panelClass?: string
}

/**
 * The tabs of a `code-tabs` block and of a `tabs` block, the WAI-ARIA tabs pattern with automatic activation: the tab that has focus is the selected one.
 * Only the selected tab is in the Tab order (roving tabindex); the arrow keys, Home and End move between tabs. Every panel is in the
 * document and the others are `hidden`, so the first panel is what the server HTML shows and hydration has nothing to correct, and
 * a reader of the source or of the feed finds the code of every tab. A hidden panel is skipped by find-in-page and by print, and
 * without script only the first tab shows.
 *
 * The panels are React nodes the server already built (code blocks with their copy buttons, or the content of a tab): the browser
 * receives them as they are and this component only decides which one shows.
 */
export function CodeTabsView({ title, groupLabel, labels, panels, panelClass = PANEL }: Props) {
  const id = useId()
  const [selected, setSelected] = useState(0)
  const tabs = useRef<(HTMLButtonElement | null)[]>([])
  const row = useRef<HTMLDivElement>(null)
  useScrollCue(row, true)
  const last = panels.length - 1

  function select(index: number, focus: boolean) {
    setSelected(index)
    if (focus) tabs.current[index]?.focus()
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // Alt+Left is "back" and Ctrl, Cmd and Shift with an arrow belong to the browser and the system: not ours.
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const from = Math.max(0, tabs.current.indexOf(event.target as HTMLButtonElement))
    let to: number
    if (event.key === 'ArrowRight') to = from === last ? 0 : from + 1
    else if (event.key === 'ArrowLeft') to = from === 0 ? last : from - 1
    else if (event.key === 'Home') to = 0
    else if (event.key === 'End') to = last
    else return
    event.preventDefault()
    select(to, true)
  }

  return (
    <div>
      {title ? <p className={`${BLOCK_TITLE} mb-2 text-sm`}>{title}</p> : null}
      <div className="rounded-lg border border-neutral-200 dark:border-neutral-800">
        <div
          ref={row}
          role="tablist"
          aria-label={groupLabel}
          onKeyDown={onKeyDown}
          className={`flex min-w-0 overflow-x-auto rounded-t-[calc(0.5rem-1px)] border-b border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900 ${SCROLL_CUE}`}
        >
          {labels.map((label, index) => (
            <button
              key={index}
              ref={(element) => {
                tabs.current[index] = element
              }}
              type="button"
              role="tab"
              id={`${id}-tab-${index}`}
              aria-selected={index === selected}
              aria-controls={`${id}-panel-${index}`}
              tabIndex={index === selected ? 0 : -1}
              onClick={() => select(index, false)}
              className={`${TAB} ${index === selected ? TAB_SELECTED : TAB_IDLE}`}
            >
              {label}
            </button>
          ))}
        </div>
        {panels.map((panel, index) => (
          <div
            key={index}
            role="tabpanel"
            id={`${id}-panel-${index}`}
            aria-labelledby={`${id}-tab-${index}`}
            hidden={index !== selected}
            className={panelClass}
          >
            {panel}
          </div>
        ))}
      </div>
    </div>
  )
}
