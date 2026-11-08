'use client'

import { useTranslations } from 'next-intl'
import { useEffect, useId, useRef, useState } from 'react'
import { Trash2Icon } from '@/components/icons'
import { ErrorAlert } from './primitives'
import { isRedirectError } from './PostEditor'
import { button, LABEL } from './ui'

export type DeletePostProps = {
  title: string
  /** Published post: the confirmation also says the public path will become a 404. */
  published: boolean
  /**
   * The viewer is an AUTHOR. Their delete only hides the post (an administrator keeps it and can restore it or delete it for good),
   * so the copy says that instead of "permanently". Only chooses the words: the backend decides what the delete does.
   */
  author: boolean
  /** After deleting, the action redirects to the post list; it only returns on error. */
  onDelete: () => Promise<{ error: string }>
}

/**
 * Delete a post, at the bottom of the editor's settings column, with an in-place confirmation step like deleting a series and
 * an image (no `window.confirm`: the browser box blocks the whole page and its text cannot be set). The button is pale red
 * at rest; only the final delete button is solid red. For an administrator it says "permanently" (the post, its cover image and
 * views are gone); for an author it says the post leaves the site and their list and an administrator keeps it.
 *
 * Focus follows the replaced button: opening the confirmation step moves it to cancel (a second Enter on the same spot must
 * cancel, not delete), and cancelling returns it to the delete-post button.
 *
 * Sits OUTSIDE the post form (the page passes it in via PostEditor's `aside`): the buttons here are never
 * the post form's submit button.
 */
export default function DeletePost({ title, published, author, onDelete }: DeletePostProps) {
  const t = useTranslations('Admin.posts.delete')
  const tErrors = useTranslations('Errors.admin')
  const id = useId()
  const [confirming, setConfirming] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  // Only restore focus after the step has been opened at least once, not when the page has just loaded.
  const opened = useRef(false)

  useEffect(() => {
    if (confirming) {
      opened.current = true
      cancel.current?.focus()
    } else if (opened.current) {
      trigger.current?.focus()
    }
  }, [confirming])

  // Delete failed: both buttons are disabled while pending so focus fell back to <body>. Put it back on cancel (Shift+Tab is
  // retry); the error sentence is role="alert", so it is announced by itself.
  useEffect(() => {
    if (!pending && error !== null) cancel.current?.focus()
  }, [pending, error])

  async function confirm() {
    setError(null)
    setPending(true)
    try {
      const result = await onDelete()
      setError(result.error)
    } catch (caught) {
      // A redirect error means success (back to the list) or an expired session: the router is navigating by itself.
      if (isRedirectError(caught)) return
      console.error('Delete post action failed', caught)
      setError(tErrors('unreachable'))
    } finally {
      setPending(false)
    }
  }

  const headingId = `${id}-heading`
  const promptId = `${id}-prompt`

  return (
    <section aria-labelledby={headingId} className="border-t border-slate-200 pt-6">
      <h3 id={headingId} className={LABEL}>
        {t('heading')}
      </h3>
      {confirming ? (
        <div role="group" aria-labelledby={promptId} className="rounded-lg border border-red-200 bg-red-50/60 p-4">
          {/* The bold question sits in a <strong> (inline): the group's name is the whole paragraph, starting with the question. */}
          <p id={promptId} className="text-[13px] leading-5 text-red-900">
            <strong className="font-semibold">{t('question', { title })}</strong> {published && <>{t('publishedWarning')} </>}
            {author ? t('author.consequences') : t('consequences')}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" disabled={pending} onClick={() => void confirm()} className={button('dangerSolid', 'sm')}>
              <Trash2Icon />
              {author ? t('author.confirm') : t('forever')}
            </button>
            <button
              ref={cancel}
              type="button"
              disabled={pending}
              onClick={() => {
                setError(null)
                setConfirming(false)
              }}
              className={button('secondary', 'sm')}
            >
              {t('cancel')}
            </button>
          </div>
          {error !== null && <ErrorAlert className="mt-3">{error}</ErrorAlert>}
        </div>
      ) : (
        <>
          <p className="mb-3 text-[13px] leading-5 text-slate-600">
            {published ? t(author ? 'author.hintPublished' : 'hintPublished') : t(author ? 'author.hintDraft' : 'hintDraft')}
          </p>
          <button ref={trigger} type="button" onClick={() => setConfirming(true)} className={button('danger', 'sm')}>
            <Trash2Icon />
            {t('button')}
          </button>
        </>
      )}
    </section>
  )
}
