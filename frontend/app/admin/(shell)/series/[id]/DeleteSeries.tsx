'use client'

import { useTranslations } from 'next-intl'
import { useEffect, useId, useRef, useState } from 'react'
import { isRedirectError } from '@/components/admin/PostEditor'
import { ErrorAlert } from '@/components/admin/primitives'
import { H2, SECTION_DESC, button } from '@/components/admin/ui'
import { Trash2Icon } from '@/components/icons'

export type DeleteSeriesProps = {
  title: string
  /** Number of posts in the series, so the confirmation says plainly they are not deleted with it. */
  postCount: number
  /** After deleting, the action redirects to the series list; it only returns on error. */
  onDelete: () => Promise<{ error: string }>
}

/**
 * Delete a series with an in-place confirmation step, not `window.confirm`: the browser dialog
 * blocks the whole page, cannot carry text, and can be turned off entirely by the browser.
 *
 * At rest it is a compact danger zone: a heading, one sentence, a red-outlined button. On
 * confirmation it is a pale red frame, and only the last button ("Delete permanently") is solid red.
 *
 * Focus follows the replaced button: opening the confirmation moves to "Cancel" — a second Enter on
 * the same spot must cancel, not delete — and cancelling returns to "Delete series".
 */
export default function DeleteSeries({ title, postCount, onDelete }: DeleteSeriesProps) {
  const t = useTranslations('Admin.series.delete')
  const id = useId()
  const [confirming, setConfirming] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  // Only return focus after it has been opened at least once, not when the page has just loaded.
  const opened = useRef(false)

  useEffect(() => {
    if (confirming) {
      opened.current = true
      cancel.current?.focus()
    } else if (opened.current) {
      trigger.current?.focus()
    }
  }, [confirming])

  async function confirm() {
    setError(null)
    setPending(true)
    try {
      const result = await onDelete()
      setError(result.error)
    } catch (caught) {
      // A redirect error is success (back to the list) or an expired session: the router is navigating on its own.
      if (isRedirectError(caught)) return
      console.error('Delete series action failed', caught)
      setError(t('unreachable'))
    } finally {
      setPending(false)
    }
  }

  const headingId = `${id}-heading`
  const promptId = `${id}-prompt`

  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className={H2}>
        {t('heading')}
      </h2>
      {confirming ? (
        <div role="group" aria-labelledby={promptId} className="mt-3 rounded-lg border border-red-200 bg-red-50/60 p-4">
          {/* The bold question sits in <strong> (inline), not in its own block: the group's name is this whole
                        paragraph, and it must begin exactly with "Delete series “…”?" (E2E matches the start of the string). */}
          <p id={promptId} className="text-sm leading-6 text-red-900">
            <strong className="font-semibold">{t('confirmQuestion', { title })}</strong>{' '}
            {postCount > 0 && `${t('postsKept', { count: postCount })} `}
            {t('irreversible')}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" disabled={pending} onClick={() => void confirm()} className={button('dangerSolid')}>
              <Trash2Icon />
              {t('confirmButton')}
            </button>
            <button
              ref={cancel}
              type="button"
              disabled={pending}
              onClick={() => {
                setError(null)
                setConfirming(false)
              }}
              className={button('secondary')}
            >
              {t('cancel')}
            </button>
          </div>
          {/* Inside the confirmation frame: the error only arises at this step. "Cancel" is locked while waiting and clears the error on
                        close, so outside the frame there is never an error to show. */}
          {error !== null && <ErrorAlert className="mt-3">{error}</ErrorAlert>}
        </div>
      ) : (
        <>
          <p className={SECTION_DESC}>{postCount > 0 ? t('restKept') : t('restEmpty')}</p>
          <button ref={trigger} type="button" onClick={() => setConfirming(true)} className={button('danger', 'md', 'mt-4')}>
            <Trash2Icon />
            {t('trigger')}
          </button>
        </>
      )}
    </section>
  )
}
