'use client'

import { useTranslations } from 'next-intl'
import { useEffect, useState } from 'react'
import type { Locale } from '@/i18n/config'
import { postUrl } from './ArticleJsonLd'
import { HERO_BUTTON, HERO_ICON_ONLY, HERO_LABEL } from './reader/hero-button'
import { FOCUS_RING, TRANSITION } from './SectionHeading'

/**
 * The sentence of the hero variant. Below `sm` it is in the flow under the button (a phone wraps the action row, so an absolute sentence would sit
 * over the buttons of the second row, and a long failure sentence never clears), wrapping inside the window. From `sm` it hangs under the button, out of
 * the flow, in a bounded box that wraps instead of running past the window edge. `empty:mt-0` keeps the idle, empty live region from adding the margin.
 */
const HERO_STATUS =
  'mt-1 max-w-[calc(100vw-2rem)] empty:mt-0 sm:absolute sm:start-0 sm:top-full sm:w-max sm:max-w-[min(20rem,calc(100vw-2rem))] '

type CopyState = 'idle' | 'copied' | 'failed'

/**
 * What the live region says, as catalog keys. Nothing while idle so nothing is announced on page load —
 * an aria-live region that starts with text announces it the moment it is inserted.
 */
const MESSAGE_KEYS = { copied: 'copied', failed: 'copyFailed' } as const

/**
 * How long the "link copied" sentence stays. The sentence needs longer than the check mark of the code-copy button
 * (CopyCodeButton, 2 seconds) to be read in time. An error sentence does not switch off by itself: it tells the reader what to do.
 */
export const COPY_LINK_FEEDBACK_MS = 3000

/**
 * Copy this article's canonical URL.
 *
 * THE URL COMES FROM THE SLUG, NOT FROM `window.location`. This is a client component
 * but it still renders on the server first, where there is no `window` — reading
 * `location` would either crash the render or force the button to render disabled and
 * only become correct after hydration. Building it from the slug through `postUrl`
 * means the server HTML is already right, and it means the copied string is the
 * canonical URL rather than whatever the reader's address bar happens to hold
 * (`?utm_source=…`, a trailing `#section`, a preview host).
 *
 * `navigator.clipboard` IS NOT ALWAYS THERE. It is undefined on any insecure origin
 * that is not localhost — a LAN IP over plain http, which is how someone would check
 * this site on their phone — and `writeText` rejects when the document is not focused
 * or permission is denied. Both are handled, neither throws, and both produce a
 * visible, announced failure rather than a button that looks like it worked.
 */
export function CopyLink({
  slug,
  language,
  className = '',
  variant = 'cell',
}: {
  slug: string
  language?: Locale
  className?: string
  /**
   * `cell` (default): the small bordered cell of the share row. `hero`: the button of the post hero (HERO_BUTTON; icon only below `sm`), whose
   * confirmation sentence hangs under it from `sm` (never reflows the hero row) and sits in the flow below it on a phone.
   */
  variant?: 'cell' | 'hero'
}) {
  const t = useTranslations('Site.share')
  const [state, setState] = useState<CopyState>('idle')
  const url = postUrl(slug, language)

  // Only "copied" returns to idle by itself. Pressing again while the sentence is still there sends the state through idle first (see
  // copy()), so the old timer is cleaned up and the new timer counts from the new press; on leaving the page cleanup removes it.
  useEffect(() => {
    if (state !== 'copied') return
    const timer = setTimeout(() => setState('idle'), COPY_LINK_FEEDBACK_MS)
    return () => clearTimeout(timer)
  }, [state])

  async function copy(): Promise<void> {
    // Clear the old sentence first: a live region whose text does not change is not read again, so the second
    // successful press used to be silent.
    setState('idle')

    // `navigator?.clipboard` and not `'clipboard' in navigator`: on an insecure origin
    // the property is absent entirely, and in a jsdom-like environment `navigator`
    // exists but `clipboard` does not. Checking `writeText` is a function covers the
    // partially-polyfilled case too.
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard

    if (typeof clipboard?.writeText !== 'function') {
      setState('failed')
      return
    }

    try {
      await clipboard.writeText(url)
      setState('copied')
    } catch {
      // NotAllowedError (no permission, document not focused) and DataError both land
      // here. An unhandled rejection in an event handler is invisible to the reader:
      // the button would simply do nothing, forever, with an error only in the
      // console.
      setState('failed')
    }
  }

  const hero = variant === 'hero'

  return (
    <div
      className={`${hero ? 'relative inline-flex flex-col items-start' : 'flex flex-wrap items-center gap-x-3 gap-y-1'} ${className}`.trim()}
    >
      <button
        type="button"
        // No aria-label. The visible text IS the accessible name, so a voice-control
        // user can say what they read, and the name stays stable across states — a
        // button whose name changes to "copied" is a different button as far as
        // assistive tech is concerned. The outcome is announced by the live region
        // instead, which is what live regions are for.
        onClick={() => {
          void copy()
        }}
        // Fixed height, like the ShareBar cells beside it: 40px on a phone, 32px from
        // 640px. The old `py-1` version was 26px tall and 3px lower than the row.
        className={
          hero
            ? `${HERO_BUTTON} ${HERO_ICON_ONLY}`
            : `inline-flex h-10 items-center gap-1.5 rounded-md border border-neutral-200 px-2.5 text-xs text-neutral-600 hover:border-brand hover:text-brand sm:h-8 dark:border-neutral-800 dark:text-neutral-400 ${FOCUS_RING} ${TRANSITION}`
        }
      >
        <svg
          aria-hidden="true"
          focusable="false"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          className={hero ? 'h-4 w-4' : 'h-3.5 w-3.5'}
        >
          <path d="M10 13a5 5 0 0 0 7.07 0l2.12-2.12a5 5 0 0 0-7.07-7.07L10.6 5.23" />
          <path d="M14 11a5 5 0 0 0-7.07 0L4.8 13.12a5 5 0 0 0 7.07 7.07l1.52-1.52" />
        </svg>
        {hero ? <span className={HERO_LABEL}>{t('copyLink')}</span> : t('copyLink')}
      </button>

      {/*
        Rendered always, empty while idle: a live region has to be in the DOM before
        its content changes, or the change is not announced at all. `role="status"`
        and `aria-live="polite"` say the same thing twice on purpose — `role` is what
        older assistive tech honours, `aria-live` is what the newer mapping reads, and
        the redundancy costs nothing.

        Visible text, not a colour change: the outcome has to be readable by someone
        who cannot distinguish the hover colour from the focus colour.
      */}
      <p
        role="status"
        aria-live="polite"
        className={`text-xs ${hero ? HERO_STATUS : ''}${state === 'failed' ? 'text-neutral-900 dark:text-neutral-100' : 'text-neutral-600 dark:text-neutral-400'}`}
      >
        {state === 'idle' ? '' : t(MESSAGE_KEYS[state])}
      </p>
    </div>
  )
}
