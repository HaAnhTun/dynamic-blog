'use client'

import { useTranslations } from 'next-intl'
import { useSyncExternalStore } from 'react'
import { Share2Icon } from '@/components/icons'
import type { Locale } from '@/i18n/config'
import { postUrl } from './ArticleJsonLd'
import { FOCUS_RING, TRANSITION } from './SectionHeading'

/** Share support does not change during the page's life, so there is nothing to subscribe to. */
function subscribe(): () => void {
  return () => {}
}

function canShare(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function'
}

/** The server does not know which browser will open the page: no button, and hydration matches that HTML. */
function cannotShareOnServer(): boolean {
  return false
}

/**
 * The "send via…" button opens the operating system's share sheet. On a phone that is the way to
 * Zalo, Messenger, messages — places the three fixed links of ShareBar do not reach.
 *
 * "Send via…", not "Share…": the button sits right after ShareBar's share label, and two things with the same name
 * read like a repeated-word mistake. Below 640px the button is a 40px square with only an icon (the name is still "send via…", the text is
 * sr-only), the same shape as the three brand cells: the share row only just fits one line at 390px.
 *
 * Shown only AFTER mount and only when `navigator.share` exists: the server HTML has no button, so
 * browsers without support (most desktops) never see a button that does nothing when clicked.
 * `useSyncExternalStore` with a server snapshot of `false` is how React does exactly this without
 * `useState` + `useEffect` (an extra render, and the repo's lint rule blocks setState
 * in effects) — the same way ThemeToggle reads localStorage.
 *
 * The URL is the canonical built from the slug (`postUrl`), like CopyLink: not the address bar, which may
 * still hold `?utm_source=…` or a `#section` hash.
 */
export function NativeShare({ slug, title, language }: { slug: string; title: string; language?: Locale }) {
  const t = useTranslations('Site.share')
  const supported = useSyncExternalStore(subscribe, canShare, cannotShareOnServer)
  if (!supported) return null

  async function share(): Promise<void> {
    try {
      await navigator.share({ title, url: postUrl(slug, language) })
    } catch {
      // A reader closing the share sheet is an AbortError, denied permission is NotAllowedError: neither
      // has anything to report, but neither may become a rejection nobody catches.
    }
  }

  return (
    <button
      type="button"
      onClick={() => {
        void share()
      }}
      className={`inline-flex h-11 w-11 items-center justify-center gap-1.5 rounded-md border border-neutral-200 text-xs text-neutral-600 hover:border-brand hover:text-brand sm:h-8 sm:w-auto sm:px-2.5 dark:border-neutral-800 dark:text-neutral-400 ${FOCUS_RING} ${TRANSITION}`}
    >
      <Share2Icon size={14} />
      <span className="sr-only sm:not-sr-only">{t('sendVia')}</span>
    </button>
  )
}
