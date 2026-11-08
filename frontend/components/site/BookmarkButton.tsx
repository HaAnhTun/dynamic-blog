'use client'

import { useLocale, useTranslations } from 'next-intl'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { BookmarkIcon } from '@/components/icons'
import { callBff } from '@/lib/bff-client'
import { interactionMessage, needsLogin } from '@/lib/interaction-errors'
import { setAnonymous, useSession } from '@/lib/session-client'
import type { BookmarkState } from '@/lib/types'
import type { Locale } from '@/i18n/config'
import { postPath } from './ArticleJsonLd'
import { githubStartHref } from './GitHubLoginLink'
import { useRailAnchor } from './reader/use-rail-anchor'
import { FOCUS_RING, TRANSITION } from './SectionHeading'

/**
 * The bookmark button, the same mold as LikeButton: the HTML only has an inert placeholder, wait for the session,
 * the server confirms (not optimistic), double presses are blocked, a 401 becomes a sign-in link. Unlike likes: the saved state is private (GET needs
 * a session), so a guest calls nothing and sees the sign-in link immediately.
 */

/** The `#…` target of returnTo. Unaccented text: it does not collide with the id of a heading in the post (rehype-slug keeps accents). */
const ANCHOR = 'luu-bai'

/** The same shape as the like button next to it: 40px on a phone, 32px from 640px. */
const SHAPE = 'inline-flex h-10 shrink-0 items-center gap-1.5 rounded-md border px-3 text-sm sm:h-8 sm:px-2.5'

const PLACEHOLDER = `${SHAPE} border-neutral-200 text-neutral-400 dark:border-neutral-800 dark:text-neutral-500`

const INTERACTIVE = `${SHAPE} border-neutral-200 text-neutral-600 hover:border-brand hover:text-brand dark:border-neutral-800 dark:text-neutral-400 ${FOCUS_RING} ${TRANSITION}`

/** Saved: a filled icon AND the brand color, like the heart of the like button — different by shape, not only by color. */
const TOGGLE = `${INTERACTIVE} aria-pressed:border-brand aria-pressed:text-brand aria-busy:cursor-wait aria-busy:opacity-70`

export function bookmarkUrl(slug: string): string {
  return `/api/me/bookmarks/${encodeURIComponent(slug)}`
}

/** The `{ bookmarked }` contract, checked again in the browser: a mismatched payload does not guess the state. */
export function isBookmarkState(value: unknown): value is BookmarkState {
  return value !== null && typeof value === 'object' && typeof (value as Record<string, unknown>).bookmarked === 'boolean'
}

export function BookmarkButton({ slug, language }: { slug: string; language?: Locale }) {
  // `key`: switching post on the client is a brand new button, no request of the old post can touch the new one.
  return <BookmarkControl key={slug} slug={slug} language={language} />
}

function BookmarkControl({ slug, language }: { slug: string; language?: Locale }) {
  const locale = useLocale()
  const t = useTranslations('Site.bookmarkButton')
  const tErrors = useTranslations('Errors.interaction')
  const session = useSession()
  const authenticated = session.status === 'authenticated'
  // undefined: asking; null: could not ask (backend error, post just removed, payload does not match the contract).
  const [bookmark, setBookmark] = useState<BookmarkState | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const [error, setError] = useState<string | null>(null)
  const pending = useRef(false)
  const button = useRef<HTMLButtonElement>(null)
  const login = useRef<HTMLAnchorElement>(null)
  const focusLogin = useRef(false)
  // A sign-in that returns to this block must land on the rail, not on the block inside it (see use-rail-anchor.ts).
  useRailAnchor(ANCHOR)

  useEffect(() => {
    if (!authenticated) return
    let active = true
    void callBff<unknown>(bookmarkUrl(slug)).then((result) => {
      if (!active) return
      if (!result.ok && needsLogin(result.code, result.status)) setAnonymous()
      else setBookmark(result.ok && isBookmarkState(result.data) ? result.data : null)
    })
    return () => {
      active = false
    }
  }, [authenticated, slug])

  const guest = session.status === 'anonymous'

  useEffect(() => {
    if (!guest || !focusLogin.current) return
    focusLogin.current = false
    login.current?.focus()
  }, [guest])

  async function toggle(current: BookmarkState): Promise<void> {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError(null)
    setAnnouncement('')
    const result = await callBff<unknown>(bookmarkUrl(slug), { method: current.bookmarked ? 'DELETE' : 'PUT' })
    pending.current = false
    setBusy(false)

    if (result.ok && isBookmarkState(result.data)) {
      setBookmark(result.data)
      setAnnouncement(result.data.bookmarked ? t('saved') : t('unsaved'))
      return
    }
    const status = result.ok ? 502 : result.status
    const code = result.ok ? 'BAD_RESPONSE' : result.code
    setError(interactionMessage(tErrors, code, status, 'bookmark'))
    if (needsLogin(code, status)) {
      focusLogin.current = document.activeElement === button.current
      setAnonymous()
    }
  }

  let control: ReactNode
  if (guest) {
    control = (
      // Plain <a>, not <Link>: prefetching the start route would begin an OAuth round on its own (like LikeButton).
      <a
        ref={login}
        href={githubStartHref(`${postPath(slug)}#${ANCHOR}`, language ?? locale)}
        rel="nofollow"
        aria-label={t('guestName')}
        className={INTERACTIVE}
      >
        <BookmarkIcon />
        <span>{t('label')}</span>
      </a>
    )
  } else if (authenticated && bookmark != null) {
    control = (
      <button
        ref={button}
        type="button"
        aria-pressed={bookmark.bookmarked}
        aria-busy={busy}
        onClick={() => {
          void toggle(bookmark)
        }}
        className={TOGGLE}
      >
        <BookmarkIcon filled={bookmark.bookmarked} />
        <span>{t('label')}</span>
      </button>
    )
  } else {
    control = (
      <span data-bookmark-placeholder="" aria-hidden="true" className={PLACEHOLDER}>
        <BookmarkIcon />
        <span>{t('label')}</span>
      </span>
    )
  }

  return (
    <div id={ANCHOR} className="flex flex-wrap items-center gap-x-3 gap-y-1 print:hidden">
      {control}
      <p role="status" aria-live="polite" className="text-sm text-neutral-900 dark:text-neutral-100">
        {error ?? <span className="sr-only">{announcement}</span>}
      </p>
    </div>
  )
}
