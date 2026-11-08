'use client'

import { useLocale, useTranslations } from 'next-intl'
import { useRef, useState } from 'react'
import { HeartIcon } from '@/components/icons'
import { asLocale, numberFormat } from '@/lib/format'
import { FOCUS, TAP_TARGET, TRANSITION } from '../SectionHeading'
import type { SubmitResult } from './CommentForm'

/**
 * The like of one comment, root or reply: the first item of the action row under a
 * VISIBLE comment. The number and state come from the comment payload (`likeCount`, `likedByMe`) through the reducer
 * of CommentSection; here we only hold the "pending" state and the button's own error sentence.
 *
 * Signed in: a `<button aria-pressed>` toggle, SERVER-CONFIRMED like the post like button (LikeButton): a press is
 * `onToggle(likedNow)` — CommentSection sends PUT or DELETE, receives the server's `{ liked, count }`, updates the
 * reducer and announces the comment was liked in the area's `role="status"` region. While waiting, the screen stays
 * as it is, the button only signals busy (`aria-busy`); further presses are dropped (a ref, not waiting for state). On failure a Vietnamese
 * sentence appears right under the row (`role="alert"`), the state is unchanged because it never changed. Focus: the button is the same
 * element in every state so focus never falls off it.
 *
 * Guest (or session not yet known): only text, not a button or link — the heart `aria-hidden`, the visible number,
 * then the likes label for screen readers — and only when there is at least one like. A post with a few hundred comments
 * does not become a few hundred Tab stops leading to the same sign-in page; the area's visible sign-in invitation
 * already says how to like. When the session turns into a guest (a 401 somewhere) this button gives way to the number:
 * two different components, so every state of the old press goes with the button.
 */

/**
 * The same size as the reply, edit, delete next to it (CommentItem `ACTION`): a 40px tall touch area (TAP_TARGET).
 * Liked: a filled heart AND the brand color — the two states differ by shape, not only by color.
 * `aria-pressed:` wins over `dark:` (the dark variant is `:where(…)`, specificity 0). Waiting: the wait cursor and
 * faded, the button is still focusable.
 */
const TOGGLE = `${TAP_TARGET} ${FOCUS} ${TRANSITION} inline-flex items-center gap-1.5 font-medium text-neutral-600 hover:text-brand aria-pressed:text-brand aria-busy:cursor-wait aria-busy:opacity-70 dark:text-neutral-400`

/** Guest: the same shape, secondary text color, no reaction on hover. */
const STATIC = 'inline-flex items-center gap-1.5 text-neutral-500 dark:text-neutral-400'

export function CommentLikeButton({
  authorName,
  count,
  liked,
  interactive,
  onToggle,
}: {
  /** The author name of the comment: which button likes which comment, when hearing a list of buttons. */
  authorName: string
  count: number
  liked: boolean
  /** Signed in: a toggle button. Otherwise only the number, and only when greater than 0. */
  interactive: boolean
  /** Receives the state at press time (`true`: currently liked, i.e. unlike). Never throws. */
  onToggle: (likedNow: boolean) => Promise<SubmitResult>
}) {
  if (interactive) return <LikeToggle authorName={authorName} count={count} liked={liked} onToggle={onToggle} />
  return count > 0 ? <LikeCount count={count} /> : null
}

function LikeToggle({
  authorName,
  count,
  liked,
  onToggle,
}: {
  authorName: string
  count: number
  liked: boolean
  onToggle: (likedNow: boolean) => Promise<SubmitResult>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Block presses while waiting: state only changes on the next render, a ref changes immediately (double click).
  const pending = useRef(false)

  async function toggle() {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError(null)
    let result: SubmitResult
    try {
      result = await onToggle(liked)
    } finally {
      pending.current = false
      setBusy(false)
    }
    if (!result.ok) setError(result.message)
  }

  const locale = asLocale(useLocale())
  const t = useTranslations('Site.comments.like')
  const shown = numberFormat(locale).format(count)
  return (
    <>
      <button
        type="button"
        // The fixed label is a verb, like the post like button; the state is in aria-pressed (and the filled heart). The
        // number is in the name because it is visible text on the button (a label must contain the visible text).
        aria-label={t('ariaLabel', { author: authorName, count: shown, n: count })}
        aria-pressed={liked}
        aria-busy={busy}
        onClick={() => {
          void toggle()
        }}
        className={TOGGLE}
      >
        <HeartIcon filled={liked} />
        <span className="tabular-nums">{shown}</span>
      </button>
      {error !== null ? (
        // Inside the flex-wrap row of CommentItem: `basis-full` gives the sentence a line of its own, `order-last` puts that line
        // below the whole row. The reading order is still right after the button, where the error happened.
        <p role="alert" className="order-last basis-full text-red-700 dark:text-red-300">
          {error}
        </p>
      ) : null}
    </>
  )
}

function LikeCount({ count }: { count: number }) {
  const locale = asLocale(useLocale())
  const t = useTranslations('Site.comments.like')
  return (
    <span data-like-count="" className={STATIC}>
      <HeartIcon />
      <span className="tabular-nums">{numberFormat(locale).format(count)}</span>
      <span className="sr-only">{` ${t('countLabel', { n: count })}`}</span>
    </span>
  )
}
