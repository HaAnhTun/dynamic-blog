'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { HeartIcon } from '@/components/icons'
import { useLocale, useTranslations } from 'next-intl'
import { callBff } from '@/lib/bff-client'
import { asLocale, numberFormat } from '@/lib/format'
import { interactionMessage, needsLogin } from '@/lib/interaction-errors'
import { setAnonymous, useSession } from '@/lib/session-client'
import type { LikeState } from '@/lib/types'
import type { Locale } from '@/i18n/config'
import { postPath } from './ArticleJsonLd'
import { githubStartHref } from './GitHubLoginLink'
import { useRailAnchor } from './reader/use-rail-anchor'
import { FOCUS_RING, TRANSITION } from './SectionHeading'

/**
 * The post like button, placed in <article> right
 * before ShareBar.
 *
 * THE SERVER CONFIRMS, NOT OPTIMISTIC. A click sends PUT (like) or DELETE (unlike); while waiting the screen
 * stays the same, the button only shows busy (`aria-busy`). When done it shows exactly the `{ liked, count }` the server returns:
 * the number may differ from "old plus one" when someone else just liked too, and there is never a filled
 * heart that the server has not recorded. On failure there is nothing to undo — the state never changed — only
 * an error message (lib/interaction-errors.ts, context `like`) in the `role="status"` region.
 *
 * No user data in the HTML: the post page is ISR, one cached copy for everyone. The server
 * render (and the first render in the browser) is an inert placeholder — outline heart and "–". After hydration:
 *   1. wait for the session store to answer /api/session. Two requests carrying the same soon-to-expire refresh token race
 *      to rotate it, and the losing request continues as a guest (lib/session-refresh.ts): a likes GET
 *      running in parallel with /api/session may get the guest's `liked: false` for a person who already liked;
 *   2. GET the likes (auth optional);
 *   3. guest: a GitHub sign-in link with the visible sentence inviting to sign in with GitHub to like, returning to exactly
 *      this place; signed in: a `aria-pressed` toggle button.
 *
 * Two clicks while waiting: the later one is dropped (a ref, not waiting for state). Focus: the toggle button is the same
 * element across every state, so focus never falls off it; when a 401 replaces the button with a sign-in
 * link, focus follows to the link (if it was on the button).
 */

/**
 * id of the block: the `#…` target of returnTo. After signing in the reader returns to exactly the end of the post, where the button is,
 * instead of the top of the post and having to scroll to find it again. Plain ASCII text: the post's headings (rehype-slug) keep diacritics,
 * so it can never collide with a heading titled after the like count.
 */
const ANCHOR = 'luot-thich'

/**
 * Same shape as the cells of the ShareBar right below: hairline border, md radius, 40px on phones (the tap
 * target), 32px from 640px.
 */
const SHAPE = 'inline-flex h-10 shrink-0 items-center gap-1.5 rounded-md border px-3 text-sm sm:h-8 sm:px-2.5'

/**
 * Tabular digits and at least 2 characters: "–" while waiting and every number up to 99 have the same width, so the block does not
 * change size when the count arrives (the room is already reserved).
 */
const COUNT_CLASS = 'min-w-[2ch] text-center tabular-nums'

/** Count not known yet: same mold, paler, no reaction to hover. */
const PLACEHOLDER = `${SHAPE} border-neutral-200 text-neutral-400 dark:border-neutral-800 dark:text-neutral-500`

const INTERACTIVE = `${SHAPE} border-neutral-200 text-neutral-600 hover:border-brand hover:text-brand dark:border-neutral-800 dark:text-neutral-400 ${FOCUS_RING} ${TRANSITION}`

/**
 * Guest: the same frame and color as the button, plus the visible sentence inviting to sign in with GitHub to like
 * Clicking here goes to GitHub's authorization page, so that must be readable on screen and not
 * only in the accessible name, and the link must not look exactly like the signed-in user's like button.
 * Height follows the text and it can shrink (no `shrink-0`): at 320px the sentence wraps inside the frame instead of pushing the page
 * into horizontal overflow; the heart and the number do not shrink.
 */
const GUEST = `inline-flex min-h-10 items-center gap-1.5 rounded-md border border-neutral-200 px-3 py-1.5 text-left text-sm text-neutral-600 hover:border-brand hover:text-brand sm:min-h-8 sm:px-2.5 sm:py-1 dark:border-neutral-800 dark:text-neutral-400 ${FOCUS_RING} ${TRANSITION}`

/**
 * Liked: solid heart AND brand color — two states that differ by shape, not only by color.
 * `aria-pressed:` beats `dark:` (the dark variant is `:where(…)`, specificity 0). While waiting: wait cursor
 * and faded, the button can still be focused.
 */
const TOGGLE = `${INTERACTIVE} aria-pressed:border-brand aria-pressed:text-brand aria-busy:cursor-wait aria-busy:opacity-70`

function likeUrl(slug: string): string {
  return `/api/posts/${encodeURIComponent(slug)}/like`
}

/** The `LikeState` contract, checked again here: a negative number or a missing `liked` must never be shown. */
function isLikeState(value: unknown): value is LikeState {
  if (value === null || typeof value !== 'object') return false
  const like = value as Record<string, unknown>
  return typeof like.liked === 'boolean' && Number.isSafeInteger(like.count) && (like.count as number) >= 0
}

export function LikeButton({ slug, language, className }: { slug: string; language?: Locale; className?: string }) {
  // `key`: changing post (client-side navigation between two posts) is a brand-new button. No state and no
  // in-flight request of the old post can touch the new post.
  return <LikeControl key={slug} slug={slug} language={language} className={className} />
}

function LikeControl({ slug, language, className = '' }: { slug: string; language?: Locale; className?: string }) {
  const locale = asLocale(useLocale())
  const t = useTranslations('Site.like')
  const tErrors = useTranslations('Errors.interaction')
  const session = useSession()
  const sessionKnown = session.status !== 'loading'
  // undefined: asking; null: could not ask (backend error, post just removed, payload breaks the contract).
  const [like, setLike] = useState<LikeState | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  // Sentence for screen readers on success; on screen, the heart and the number already say it.
  const [announcement, setAnnouncement] = useState('')
  const [error, setError] = useState<string | null>(null)
  // Block clicks while waiting: state only changes on the next render, a ref changes immediately (double click).
  const pending = useRef(false)
  const button = useRef<HTMLButtonElement>(null)
  const login = useRef<HTMLAnchorElement>(null)
  // A 401 replaces the focused button with the sign-in link: the link takes focus when it appears.
  const focusLogin = useRef(false)
  // A sign-in that returns to this block must land on the rail, not on the block inside it (see use-rail-anchor.ts).
  useRailAnchor(ANCHOR)

  useEffect(() => {
    if (!sessionKnown) return
    let active = true
    void callBff<unknown>(likeUrl(slug)).then((result) => {
      if (active) setLike(result.ok && isLikeState(result.data) ? result.data : null)
    })
    return () => {
      active = false
    }
  }, [sessionKnown, slug])

  const showLogin = sessionKnown && like != null && session.status === 'anonymous'

  useEffect(() => {
    if (!showLogin || !focusLogin.current) return
    focusLogin.current = false
    login.current?.focus()
  }, [showLogin])

  async function toggle(current: LikeState): Promise<void> {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError(null)
    // Clear before each click: a sentence identical to the previous one (the "liked" sentence the second time) is still a change
    // of the live region, so it is still read.
    setAnnouncement('')
    const result = await callBff<unknown>(likeUrl(slug), { method: current.liked ? 'DELETE' : 'PUT' })
    pending.current = false
    setBusy(false)

    if (result.ok && isLikeState(result.data)) {
      setLike(result.data)
      setAnnouncement(result.data.liked ? t('liked') : t('unliked'))
      return
    }
    // 2xx but the payload breaks the contract: treat it as a broken server, do not guess the state.
    const status = result.ok ? 502 : result.status
    const code = result.ok ? 'BAD_RESPONSE' : result.code
    setError(interactionMessage(tErrors, code, status, 'like'))
    if (needsLogin(code, status)) {
      // Session expired (cookie expired, revoked): every island goes back to the guest UI, and this button becomes a sign-in
      // link. The "session expired" sentence stays beside the link so the reader knows why.
      focusLogin.current = document.activeElement === button.current
      setAnonymous()
    }
  }

  let control: ReactNode
  if (!sessionKnown || like == null) {
    // Fully inert: aria-hidden, nothing focusable. With no count there is nothing to say.
    control = (
      <span data-like-placeholder="" aria-hidden="true" className={PLACEHOLDER}>
        <HeartIcon />
        <span className={COUNT_CLASS}>–</span>
      </span>
    )
  } else if (session.status === 'authenticated') {
    const count = numberFormat(locale).format(like.count)
    control = (
      <button
        ref={button}
        type="button"
        // The fixed label is the verb "like the post"; state lives in aria-pressed (and the solid heart).
        // The count is inside the name because it is visible text on the button (the label must contain the visible text).
        aria-label={t('ariaLabel', { count, n: like.count })}
        aria-pressed={like.liked}
        aria-busy={busy}
        onClick={() => {
          void toggle(like)
        }}
        className={TOGGLE}
      >
        <HeartIcon filled={like.liked} />
        <span className={COUNT_CLASS}>{count}</span>
      </button>
    )
  } else {
    const count = numberFormat(locale).format(like.count)
    control = (
      // A plain <a>, never <Link>: prefetching a link to the start route would itself begin an
      // OAuth round (same reason as GitHubLoginLink).
      <a
        ref={login}
        href={githubStartHref(`${postPath(slug)}#${ANCHOR}`, language ?? locale)}
        rel="nofollow"
        aria-label={t('guestAriaLabel', { count, n: like.count })}
        title={t('guestLabel')}
        className={GUEST}
      >
        <HeartIcon className="shrink-0" />
        <span className={`${COUNT_CLASS} shrink-0`}>{count}</span>
        <span data-like-guest-label="" className="ms-1 max-sm:sr-only">
          {t('guestLabel')}
        </span>
      </a>
    )
  }

  return (
    // print:hidden: it cannot be clicked on paper, and the like count is not the post.
    <div id={ANCHOR} className={`flex flex-wrap items-center gap-x-3 gap-y-1 print:hidden ${className}`.trim()}>
      {control}
      {/* Always present, empty when there is nothing to say: a live region must exist BEFORE its text changes
          for it to be read. The error shows to the eye; the success sentence is only for screen readers. */}
      <p role="status" aria-live="polite" className="text-sm text-neutral-900 dark:text-neutral-100">
        {error ?? <span className="sr-only">{announcement}</span>}
      </p>
    </div>
  )
}
