'use client'

import { useTranslations } from 'next-intl'
import { useId, useState, type ReactNode } from 'react'

/**
 * Below `sm`, while collapsed, every item after the third is out of the page (`display: none`, so also out of reach of a screen reader).
 * The three is the `COLLAPSED_ITEMS` of entry-parts.tsx, which counts what is hidden (it cannot be imported here: a constant exported by a
 * client module is a reference, not a number, when a server component imports it).
 */
const COLLAPSED = 'data-[expanded=false]:max-sm:[&_li:nth-child(n+4)]:hidden'

const TOGGLE =
  'mt-2 inline-flex min-h-11 cursor-pointer items-center rounded-md text-sm font-medium text-brand hover:underline hover:underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand motion-reduce:transition-none sm:hidden'

/**
 * A long list that shows its first three items on a phone, with a button to show the rest. From `sm` nothing is hidden and there is no
 * button: the list is exactly what the server drew. The list is passed as `children` (drawn on the server, so the whole text is in the HTML
 * and in the feed of the page); this component only holds the one bit of state, which item is hidden by CSS. A list with nothing hidden (`hidden` 0)
 * renders no button.
 */
export function CollapsibleList({ hidden, children }: { hidden: number; children: ReactNode }) {
  const t = useTranslations('Site.entry')
  const [open, setOpen] = useState(false)
  const id = useId()

  return (
    <div>
      <div id={id} data-expanded={open ? 'true' : 'false'} className={COLLAPSED}>
        {children}
      </div>
      {hidden > 0 ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((value) => !value)}
          className={TOGGLE}
        >
          {open ? t('showLess') : t('showMore', { count: hidden })}
        </button>
      ) : null}
    </div>
  )
}
