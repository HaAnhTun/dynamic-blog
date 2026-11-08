'use client'

import { Link } from '@/i18n/navigation'
import { useEffect, useId, useRef, useState } from 'react'
import { formatLocalDateTime, formatLocalTime, isSameLocalDay } from '@/lib/local-time'
import { profileHref } from '@/lib/profile'
import { relativeTime } from '@/lib/relative-time'
import type { PublicComment } from '@/lib/types'
import { Avatar } from '../Avatar'
import { FOCUS, FOCUS_RING, TAP_TARGET, TITLE_LINK, TRANSITION } from '../SectionHeading'
import { CommentForm, SECONDARY, type SubmitResult } from './CommentForm'
import { CommentLikeButton } from './CommentLikeButton'
import { useLocale, useTranslations } from 'next-intl'
import { asLocale } from '@/lib/format'

/**
 * One comment, root or reply.
 *
 * - The content is plain React text in `whitespace-pre-wrap [overflow-wrap:anywhere]`: leading whitespace
 *   of pasted code is kept, a long URL does not push the page into horizontal overflow at 320px. Never
 *   `dangerouslySetInnerHTML`, no markdown, no auto-created links: `<script>` is text.
 * - The author name is in `<bdi>`: a right-to-left name does not reverse the order of the text around it. Right after
 *   the name, the site owner label when the server marks `author.siteOwner` (see OWNER_BADGE). `@login`
 *   only when present (a password-only account has no GitHub login: never "@null").
 * - The avatar and name are ONE link to the profile (the site owner goes to /about): the name is the link text, the decorative avatar
 *   (`alt=""`) sits inside the link. Without `profileSlug` (old backend) there is no link.
 * - The posting date and time is visible text, in the reader's time: `<time dateTime>14:30, 08/10/2026</time>`
 *   (on a phone nobody can see a `title`). The relative time ("3 minutes ago") comes
 *   after, as secondary text; `now` is held by CommentSection, so rendering does not read the clock itself. Edited: "edited at
 *   15:02" — only the time when on the same day as the posting, otherwise the full date and time — or a bare "edited" when the backend
 *   (the older one) has not sent an edit time. The whole line wraps at 320px thanks to `flex-wrap`.
 * - The action row: the like button comes first (CommentLikeButton) on every VISIBLE comment when the backend has
 *   comment likes (`likeCount` not null), then reply, edit, delete.
 * - A comment that is no longer VISIBLE (it only gets here when a visible reply remains): a placeholder "deleted" /
 *   "hidden", no name, no content, no buttons.
 * - `<article tabIndex={-1}>` has `data-comment-id`: CommentSection moves focus here after posting,
 *   replying, "load more" or deleting. The buttons carry `data-action` so focus returns to the right button when the form closes.
 * - `locked`: a reply, edit or delete is waiting for the server. The buttons still receive focus and are read as
 *   unavailable (`aria-disabled`, not `disabled`: the button holding focus is not kicked back to <body>),
 *   presses are dropped — including an open "Reply", whose toggle can close the form that is waiting.
 */

export type ItemMode = 'view' | 'edit' | 'delete'
export type ItemAction = 'reply' | 'edit' | 'delete'

/**
 * A small text button under a comment: the touch area is widened to 40px tall (TAP_TARGET), spaced by `gap-x-4`. When locked it
 * fades and shows the wait cursor, like the sending button of the form (CommentForm `SECONDARY`).
 */
const ACTION = `${TAP_TARGET} ${FOCUS} ${TRANSITION} font-medium text-neutral-600 hover:text-brand aria-disabled:cursor-wait aria-disabled:opacity-70 dark:text-neutral-400`

const DANGER = `inline-flex h-11 items-center justify-center rounded-md border border-red-700 bg-red-700 px-4 text-sm font-medium text-white hover:border-red-800 hover:bg-red-800 aria-disabled:cursor-wait aria-disabled:opacity-70 sm:h-9 dark:border-red-500 dark:bg-red-600 dark:hover:bg-red-700 ${TRANSITION} ${FOCUS_RING}`

/**
 * The edit time text: "15:02" when on the same day (by the reader's calendar) as the posting, "15:02, 09/10/2026" when
 * on a different day. null when no readable edit time exists: the older backend only has `edited`, so the meta line prints "edited".
 */
function editedTime(comment: PublicComment): string | null {
  if (!comment.edited || comment.editedAt === null) return null
  return isSameLocalDay(comment.createdAt, comment.editedAt)
    ? formatLocalTime(comment.editedAt)
    : formatLocalDateTime(comment.editedAt)
}

/**
 * The label after the author name when the server says that person is the site owner (`author.siteOwner`).
 *
 * Only by the flag, never by name: the reader's display name comes from their GitHub profile, and anyone can
 * choose exactly the site owner's name. Real text, no icon: a screen reader reads "Name, site owner" along the
 * meta line, while the name of the `<article>` (aria-labelledby into the `<bdi>`) is still only the author name.
 *
 * A neutral border and text, no brand background: brand text on a light brand background is about 4.3:1, below
 * the 4.5:1 for 12px text. neutral-700 on white is 10.4:1, neutral-300 on `#0a0a0a` is over 13:1.
 * `whitespace-nowrap`: the `flex-wrap` meta line wraps before the label, never breaking in the middle of the two words.
 */
const OWNER_BADGE =
  'inline-block rounded-full border border-neutral-300 px-1.5 text-xs leading-4 font-medium whitespace-nowrap text-neutral-700 dark:border-neutral-700 dark:text-neutral-300'

/** The text of the placeholder. */

/** The author name text: on the link when there is one (so the link's `hover:text-brand` can change the color), on the `<bdi>` when not. */
const NAME = 'font-medium text-neutral-900 dark:text-neutral-100'

export function CommentItem({
  comment,
  reply = false,
  now,
  mine,
  canLike = false,
  canReply = false,
  replyOpen = false,
  locked = false,
  mode = 'view',
  editDraft,
  onOpen,
  onClose,
  onSave,
  onDelete,
  onLike,
}: {
  comment: PublicComment
  reply?: boolean
  /** The "now" reference for relative time (ms). */
  now: number
  /** Belongs to the person reading AND the session is still valid: shows edit and delete. */
  mine: boolean
  /** Signed in: the heart is a toggle button. Guest: only the number, and only when there is at least one like. */
  canLike?: boolean
  /** A VISIBLE root, signed in, the thread not full: shows "Reply". */
  canReply?: boolean
  replyOpen?: boolean
  /** A write is waiting for the server: action buttons are `aria-disabled`, pressing does nothing. */
  locked?: boolean
  mode?: ItemMode
  /** Text pre-filled in the edit box instead of the current content: the draft left over after a session expired. */
  editDraft?: string
  onOpen: (action: ItemAction) => void
  onClose: (action: 'reply' | 'edit' | 'delete') => void
  onSave: (text: string) => Promise<SubmitResult>
  onDelete: () => Promise<SubmitResult>
  /** Like or unlike, by the state at press time. Never throws. */
  onLike: (likedNow: boolean) => Promise<SubmitResult>
}) {
  const locale = asLocale(useLocale())
  const t = useTranslations('Site.comments.item')
  const tTime = useTranslations('Site.time')
  const nameId = useId()
  const article = `${FOCUS_RING} rounded-md`

  if (comment.status !== 'VISIBLE' || comment.content === null || comment.author === null) {
    return (
      <article data-comment-id={comment.id} tabIndex={-1} aria-labelledby={nameId} className={article}>
        <p id={nameId} className="text-sm text-neutral-500 italic dark:text-neutral-400">
          {comment.status === 'HIDDEN' ? t('hidden') : t('deleted')}
        </p>
      </article>
    )
  }

  const { author, content } = comment
  const posted = formatLocalDateTime(comment.createdAt)
  const relative = relativeTime(comment.createdAt, now, locale, tTime)
  const edited = editedTime(comment)
  // null: the older backend, no comment likes yet. A guest sees the number only when it is greater than 0.
  const likes = comment.likeCount !== null && (canLike || comment.likeCount > 0) ? comment.likeCount : null
  const press = (run: () => void) => () => {
    if (!locked) run()
  }

  const href = profileHref(author)
  const who = (
    <>
      <Avatar name={author.displayName} src={author.avatarUrl} size={reply ? 28 : 32} className="absolute top-0.5 left-0" />
      <bdi id={nameId} className={`[overflow-wrap:anywhere] ${href === null ? NAME : ''}`.trim()}>
        {author.displayName}
      </bdi>
    </>
  )

  return (
    <article data-comment-id={comment.id} tabIndex={-1} aria-labelledby={nameId} className={article}>
      {/* The avatar is absolute in the left column (pl = image size + 12px) so it sits in the SAME link as the name without changing the layout. */}
      <div className={`relative ${reply ? 'pl-10' : 'pl-11'}`}>
        <div className="min-w-0">
          <p className="flex flex-wrap items-baseline gap-x-1.5 text-sm text-neutral-600 dark:text-neutral-400">
            {href !== null ? (
              // prefetch off: one page of comments can mention dozens of people, each one a prefetch.
              <Link href={href} prefetch={false} className={`${NAME} ${TITLE_LINK}`}>
                {who}
              </Link>
            ) : (
              who
            )}
            {author.siteOwner ? <span className={OWNER_BADGE}>{t('ownerBadge')}</span> : null}
            {author.githubLogin !== null ? <span className="[overflow-wrap:anywhere]">@{author.githubLogin}</span> : null}
            {posted !== null ? (
              <>
                <span aria-hidden="true">·</span>
                <time dateTime={comment.createdAt}>{posted}</time>
              </>
            ) : null}
            {relative !== null ? (
              <>
                <span aria-hidden="true">·</span>
                {/* Secondary text. neutral-500 only on a light background (4.74:1); on a dark background it is only 4.17:1, so keep 400. */}
                <span className="text-neutral-500 dark:text-neutral-400">{relative}</span>
              </>
            ) : null}
            {comment.edited ? (
              <>
                <span aria-hidden="true">·</span>
                {edited !== null && comment.editedAt !== null ? (
                  <span>
                    {t.rich('editedAt', {
                      date: edited,
                      time: (chunks) => <time dateTime={comment.editedAt as string}>{chunks}</time>,
                    })}
                  </span>
                ) : (
                  <span>{t('edited')}</span>
                )}
              </>
            ) : null}
          </p>

          {mode === 'edit' ? (
            <div className="mt-2">
              <CommentForm
                label={t('editLabel')}
                submitLabel={t('editSave')}
                pendingLabel={t('editPending')}
                initialText={editDraft ?? content}
                autoFocus
                onCancel={() => onClose('edit')}
                onSubmit={onSave}
              />
            </div>
          ) : (
            <p className="mt-1 whitespace-pre-wrap text-neutral-800 [overflow-wrap:anywhere] dark:text-neutral-200">{content}</p>
          )}

          {mode === 'delete' ? (
            <DeleteConfirm onConfirm={onDelete} onCancel={() => onClose('delete')} />
          ) : mode === 'view' && (likes !== null || canReply || mine) ? (
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
              {likes !== null ? (
                <CommentLikeButton
                  authorName={author.displayName}
                  count={likes}
                  liked={comment.likedByMe}
                  interactive={canLike}
                  onToggle={onLike}
                />
              ) : null}
              {canReply ? (
                <button
                  type="button"
                  data-action="reply"
                  aria-expanded={replyOpen}
                  aria-disabled={locked || undefined}
                  onClick={press(() => (replyOpen ? onClose('reply') : onOpen('reply')))}
                  className={ACTION}
                >
                  {t('reply')}
                </button>
              ) : null}
              {mine ? (
                <>
                  <button
                    type="button"
                    data-action="edit"
                    aria-disabled={locked || undefined}
                    onClick={press(() => onOpen('edit'))}
                    className={ACTION}
                  >
                    {t('edit')}
                  </button>
                  <button
                    type="button"
                    data-action="delete"
                    aria-disabled={locked || undefined}
                    onClick={press(() => onOpen('delete'))}
                    className={ACTION}
                  >
                    {t('delete')}
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </article>
  )
}

/**
 * In-place delete confirmation (not `window.confirm`, the same way as deleting a post in admin): when opened, focus goes to
 * "Cancel" — a second Enter on the same spot cancels, it does not delete. Escape also cancels. On failure the error sentence is
 * here, the confirmation stays open to retry.
 */
function DeleteConfirm({ onConfirm, onCancel }: { onConfirm: () => Promise<SubmitResult>; onCancel: () => void }) {
  const t = useTranslations('Site.comments.item')
  const promptId = useId()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef(false)
  const cancelButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    cancelButton.current?.focus()
  }, [])

  async function confirm() {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError(null)
    let result: SubmitResult
    try {
      result = await onConfirm()
    } finally {
      pending.current = false
      setBusy(false)
    }
    if (!result.ok) setError(result.message)
  }

  function cancel() {
    if (!pending.current) onCancel()
  }

  return (
    <div
      role="group"
      aria-labelledby={promptId}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        cancel()
      }}
      className="mt-3 rounded-md border border-red-200 bg-red-50/60 p-3 dark:border-red-900 dark:bg-red-950/40"
    >
      <p id={promptId} className="text-sm text-red-900 dark:text-red-200">
        {t('deleteConfirm')}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" onClick={() => void confirm()} aria-disabled={busy || undefined} className={DANGER}>
          {busy ? t('deleting') : t('delete')}
        </button>
        <button ref={cancelButton} type="button" onClick={cancel} aria-disabled={busy || undefined} className={SECONDARY}>
          {t('cancel')}
        </button>
      </div>
      {error !== null ? (
        <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      ) : null}
    </div>
  )
}
