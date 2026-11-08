'use client'

import { useTranslations } from 'next-intl'
import { useEffect, useState, type MouseEvent } from 'react'
import { CheckIcon, CopyIcon } from '@/components/icons'
import { FOCUS_RING, TRANSITION } from './SectionHeading'

type CopyState = 'idle' | 'copied' | 'failed'

/**
 * The sentence of the status region, as catalog keys. Nothing when idle so nothing is read at page load — a live region inserted
 * when it already has text reads that text immediately (like CopyLink).
 */
const MESSAGE_KEYS = { copied: 'copied', failed: 'copyFailed' } as const

/** How long the "copied" check mark stays before the button returns to the copy icon. An error sentence does not switch off by itself. */
export const COPY_FEEDBACK_MS = 2000

/**
 * 44px on a phone (the whole height of the strip), 32px from 640px — the same scale as CopyLink and the cells of ShareBar. Anchored to the top
 * right of the block (CodeBlock is `relative`), inside the strip that globals.css reserves at the top of `<pre>`
 * (`.prose [data-code-block] > pre`: 2.75rem, then 2.25rem from 40rem): that strip is taller than the button, so the button never
 * covers the first line of code, even when that line is long and scrolls horizontally underneath. Change the size here and change the strip
 * there.
 *
 * No border, background only on hover: a bordered cell on every code block is the heaviest thing in the text column. The text
 * neutral-500 on the white background of github-light is 4.74:1; neutral-400 on the `#24292e` of github-dark is 5.8:1.
 */
const BUTTON = `absolute top-0 right-0 inline-flex h-11 w-11 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-brand sm:h-8 sm:w-8 dark:text-neutral-400 dark:hover:bg-white/10 print:hidden ${FOCUS_RING} ${TRANSITION}`

/** The visible error sentence, next to the button, on the same row; it pushes nothing (absolute). */
const HINT =
  'pointer-events-none absolute top-0 right-11 flex h-11 items-center pr-1 text-xs whitespace-nowrap text-red-700 sm:right-8 sm:h-8 dark:text-red-300 print:hidden'

/**
 * The "Copy code" button of a code block. CodeBlock places it right after `<pre>`, inside the same
 * `<div data-code-block>`.
 *
 * IT RECEIVES NO CODE THROUGH PROPS. This is a client component, and every prop of it goes into the RSC payload: passing the
 * code string means every code block of the post is in the page twice, once in the HTML, once in the
 * payload. The button reads the `textContent` of the `<pre>` of the same block at press time, so what is copied is exactly what is
 * shown — every byte, including NFD and leading whitespace — and there is nothing to keep in sync.
 *
 * `navigator.clipboard` IS NOT ALWAYS THERE (http origin over a LAN IP), and `writeText` rejects
 * without permission or when the document has no focus. Both, like CopyLink, become a visible and
 * announced result, never a button that looks like it ran but did nothing.
 *
 * Result: a check mark replaces the icon for `COPY_FEEDBACK_MS`, and a `role="status"` region only for screen
 * readers (the icon is already what sighted people see). When copying fails, a short visible sentence is added next to the button,
 * and that sentence stays until the next press: an error sentence that switches off after two seconds is easy to miss.
 */
export function CopyCodeButton() {
  const t = useTranslations('Site.code')
  const [state, setState] = useState<CopyState>('idle')

  // Only "copied" returns to idle by itself. Pressing again while "copied" sends the state through idle first (see copy()), so the
  // old timer is cleaned up and the new timer counts from the new press.
  useEffect(() => {
    if (state !== 'copied') return
    const timer = setTimeout(() => setState('idle'), COPY_FEEDBACK_MS)
    return () => clearTimeout(timer)
  }, [state])

  async function copy(from: HTMLElement): Promise<void> {
    // Clear the old sentence first: a status region whose text does not change is not read again on the second press.
    setState('idle')

    const pre = from.closest('[data-code-block]')?.querySelector(':scope > pre')
    // `navigator?.clipboard` rather than `'clipboard' in navigator`: on an insecure origin the property
    // is absent altogether; checking that `writeText` is a function also covers a half-baked polyfill.
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
    if (!pre || typeof clipboard?.writeText !== 'function') {
      setState('failed')
      return
    }

    try {
      // The call sits INSIDE the try: some polyfills throw synchronously instead of returning a rejected promise.
      await clipboard.writeText(pre.textContent ?? '')
      setState('copied')
    } catch {
      setState('failed')
    }
  }

  return (
    <>
      <button
        type="button"
        // A fixed name, not changing with the state: a button named "copied" is a different button to assistive
        // technology. The result goes through the status region below.
        aria-label={t('copy')}
        data-state={state}
        onClick={(event: MouseEvent<HTMLButtonElement>) => {
          // currentTarget is read IMMEDIATELY: React clears it from the event when the handler returns.
          void copy(event.currentTarget)
        }}
        className={BUTTON}
      >
        {state === 'copied' ? <CheckIcon /> : <CopyIcon />}
      </button>
      {state === 'failed' ? (
        <span aria-hidden="true" className={HINT}>
          {t('copyFailedShort')}
        </span>
      ) : null}
      {/* Always present, empty when idle: a live region must already be in the DOM before its text changes. */}
      <span role="status" aria-live="polite" className="sr-only">
        {state === 'idle' ? '' : t(MESSAGE_KEYS[state])}
      </span>
    </>
  )
}
