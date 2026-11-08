'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useId, useTransition } from 'react'
import { button } from './ui'

/**
 * A notice under an admin table filtered by status (Comments, Users) when a row just changed
 * to a status outside the filter. CommentModeration and UserTable deliberately keep that row in place, so the
 * moderator sees what they just did and can undo it at once. But the real list on the server got shorter: pressing
 * the next-page button (computed from the old position) skips exactly that many items that just moved up onto this page, and the counts in
 * the heading and in the pagination are both wrong.
 *
 * The reload-list button is `router.refresh()`: the server redraws the exact URL being viewed, the table receives the new list
 * (the table's "adjust state when a prop changes" pattern), pagination and counts are recomputed. No updateTag:
 * only this admin page is redrawn, the public cache is not touched.
 *
 * `useRouter` is here and not in the table: only a table that is filtered and has a row leaving the filter needs the router.
 */
export function StaleListNotice({
  count,
  unit,
  kept = 'undo',
  onReload,
}: {
  /** Number of rows currently shown that no longer belong to the filter. */
  count: number
  /** The counting unit: comment, account, author application. */
  unit: 'comment' | 'user' | 'application'
  /** Why the row stays. A decided author application cannot be undone: it is "kept here so you can review it". */
  kept?: 'undo' | 'review'
  /** Called right before reloading: the table uses it to move focus to the table when the new list arrives. */
  onReload: () => void
}) {
  const router = useRouter()
  const t = useTranslations('Admin.common.staleList')
  const [pending, startTransition] = useTransition()
  const textId = useId()

  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
      <p id={textId} className="min-w-0 flex-1 text-[13px] leading-5 text-amber-900">
        {t('notice', { count, unit, kept })}
      </p>
      <button
        type="button"
        // The explanation is read along when focus reaches the button: a screen-reader user Tabbing from the row just
        // changed down to the pagination meets this button before the next-page button.
        aria-describedby={textId}
        aria-disabled={pending || undefined}
        onClick={() => {
          if (pending) return
          onReload()
          startTransition(() => router.refresh())
        }}
        className={button('secondary', 'sm', 'aria-disabled:cursor-wait aria-disabled:opacity-60')}
      >
        {pending ? t('reloading') : t('reload')}
      </button>
    </div>
  )
}
