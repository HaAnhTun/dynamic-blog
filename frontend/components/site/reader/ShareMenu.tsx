'use client'

import { useTranslations } from 'next-intl'
import { useEffect, useRef, useState } from 'react'
import { BrandIcon } from '@/components/BrandIcon'
import { ChevronRightIcon, Share2Icon } from '@/components/icons'
import type { Locale } from '@/i18n/config'
import { postUrl } from '../ArticleJsonLd'
import { FOCUS_RING, TRANSITION } from '../SectionHeading'
import { SHARE_TARGETS } from '../share-targets'
import { HERO_BUTTON, HERO_ICON_ONLY, HERO_LABEL } from './hero-button'

const ITEM = `flex h-10 items-center gap-2.5 rounded-md px-2.5 text-sm text-neutral-800 hover:bg-neutral-100 hover:text-brand dark:text-neutral-200 dark:hover:bg-neutral-800 ${FOCUS_RING} ${TRANSITION}`

/**
 * The Share button of the post hero: a disclosure (`<details>`), not a dialog. The summary is a hero button; the panel under it
 * lists one text link per destination of `SHARE_TARGETS`, the same list and the same `href(url, title)` functions as the share row
 * of the right column (ShareBar), so both produce identical URLs. No "Send via…" button here: the operating system's share sheet
 * stays in the right column only, so there is no duplicate control.
 *
 * The native element does the keyboard work (Enter and Space on the summary). The client part adds what `<details>` lacks: the
 * panel closes on a pointer press outside it, on Escape (focus returns to the summary) and when a link is activated. The only
 * state is `open`, read from the native `toggle` event, so the listeners exist only while the panel is open. The panel is absolute:
 * opening it never moves the layout.
 *
 * The list has NO accessible name of its own: a list named "Share" would be a second list of that name next to the right column's.
 * A closed `<details>` keeps its content out of the accessibility tree, so the page still has exactly one list named Share.
 * Printing: the page puts the whole hero action group in `print:hidden`.
 */
export function ShareMenu({
  slug,
  title,
  language,
  alignEnd = false,
}: {
  slug: string
  title: string
  language?: Locale
  /** True when the button sits at the right end of its row: the panel opens towards the left on a phone too. */
  alignEnd?: boolean
}) {
  const t = useTranslations('Site.share')
  const url = postUrl(slug, language)
  const root = useRef<HTMLDetailsElement>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const details = root.current
    if (!details) return

    const close = (restoreFocus: boolean) => {
      details.open = false
      if (restoreFocus) details.querySelector('summary')?.focus()
    }
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !details.contains(event.target)) close(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      // Focus goes back to the button only when it was inside the menu: after Tabbing away, Escape must not pull it back.
      if (event.key === 'Escape') close(details.contains(document.activeElement))
    }
    // Tabbing out of the open panel closes it (a related target of null is a click on nothing, handled by the pointer listener).
    const onFocusOut = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && !details.contains(event.relatedTarget)) close(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    details.addEventListener('focusout', onFocusOut)
    return () => {
      details.removeEventListener('focusout', onFocusOut)
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <details
      ref={root}
      className="group relative"
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary
        className={`${HERO_BUTTON} ${HERO_ICON_ONLY} cursor-pointer list-none select-none [&::-webkit-details-marker]:hidden`}
      >
        <Share2Icon size={16} />
        <span className={HERO_LABEL}>{t('label')}</span>
        <ChevronRightIcon
          size={16}
          className="rotate-90 transition-transform group-open:-rotate-90 max-sm:hidden motion-reduce:transition-none"
        />
      </summary>

      <div
        className={`absolute ${alignEnd ? 'end-0' : 'start-0 sm:start-auto sm:end-0'} top-full z-30 mt-2 w-56 rounded-lg border border-neutral-200 bg-white p-1.5 shadow-lg dark:border-neutral-800 dark:bg-neutral-900`}
      >
        <ul>
          {SHARE_TARGETS.map((target) => (
            <li key={target.brand}>
              <a
                href={target.href(url, title)}
                target="_blank"
                rel="noopener noreferrer"
                className={ITEM}
                onClick={() => {
                  if (root.current) root.current.open = false
                }}
              >
                <BrandIcon name={target.brand} />
                {t('shareOn', { target: target.label })}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </details>
  )
}
