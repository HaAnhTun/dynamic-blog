'use client'

import Image from 'next/image'
import { useTranslations } from 'next-intl'
import { useEffect, useId, useRef, useState } from 'react'
import { ImagePlusIcon, Trash2Icon } from '@/components/icons'
import { mediaPath } from '@/lib/media'
import type { MediaRef } from '@/lib/types'
import { button, FOCUS_RING, HINT, LABEL, META } from './ui'

export type PostImagesPanelProps = {
  /** Images uploaded for the post body, newest first; null when the list could not be loaded. */
  images: MediaRef[] | null
  /** false for a post never saved: there is no post to attach images to yet. */
  canUpload: boolean
  /** id of the "save the post first" sentence, so the insert-image button on the content box can point `aria-describedby` at it. */
  hintId: string
  /** An image is being uploaded or deleted: the buttons are locked. */
  busy: boolean
  /** Whether the content (being edited or saved) points to this image. */
  inUse: (image: MediaRef) => boolean
  onInsert: (image: MediaRef) => void
  /** Returns true when deleted. The error is shown by the editor, in the shared error box. */
  onDelete: (image: MediaRef) => Promise<boolean>
}

function labelOf(image: MediaRef, noDescription: string): string {
  const alt = image.altText?.trim() ?? ''
  return alt === '' ? noDescription : alt
}

/**
 * The in-post images section in the settings column: the images already uploaded for the post body, re-insert an image at
 * the cursor, or delete an image from the server for good (with an in-place confirmation step like deleting a post, no `window.confirm`).
 * Uploading lives in the insert-image button on the content box, and in paste and drag-and-drop into that box (PostEditor).
 *
 * Deleting an image the content still points to leaves a broken image there: the confirmation sentence says so when that is the case.
 * Focus: opening the confirmation goes to cancel (another Enter on the same spot must be safe), cancelling returns to the delete button of
 * that image, and after deleting it goes to the region heading (the image's row is gone).
 */
export default function PostImagesPanel({ images, canUpload, hintId, busy, inUse, onInsert, onDelete }: PostImagesPanelProps) {
  const t = useTranslations('Admin.postImages')
  const id = useId()
  const headingId = `${id}-heading`
  const heading = useRef<HTMLHeadingElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  // The image whose confirmation was just closed (cancel): focus returns to its delete button. Only read and written in an effect and handler.
  const returnTo = useRef<string | null>(null)
  // Delete failed: focus goes to cancel once that button is unlocked (focus() on a disabled button is a no-op).
  const refocusCancel = useRef(false)

  useEffect(() => {
    if (confirming !== null) {
      cancel.current?.focus()
      return
    }
    const target = returnTo.current
    returnTo.current = null
    if (target === null || list.current === null) return
    const trigger = Array.from(list.current.querySelectorAll<HTMLElement>('[data-delete-for]')).find(
      (element) => element.dataset.deleteFor === target,
    )
    trigger?.focus()
  }, [confirming])

  useEffect(() => {
    if (deleting || !refocusCancel.current) return
    refocusCancel.current = false
    cancel.current?.focus()
  }, [deleting])

  async function remove(image: MediaRef) {
    setDeleting(true)
    const removed = await onDelete(image)
    if (removed) {
      // The image's row vanishes together with the button that held focus: move focus to the region heading.
      setConfirming(null)
      heading.current?.focus()
    } else {
      // The error is already shown in the shared error box; both buttons were locked while waiting so focus fell back to <body>.
      refocusCancel.current = true
    }
    setDeleting(false)
  }

  const locked = busy || deleting

  return (
    <section aria-labelledby={headingId}>
      <h3 id={headingId} ref={heading} tabIndex={-1} className={`${LABEL} rounded-sm ${FOCUS_RING}`}>
        {t('heading')}
      </h3>

      {!canUpload ? (
        <p id={hintId} className="text-[13px] leading-5 text-slate-600">
          {t('saveFirst')}
        </p>
      ) : images === null ? (
        <p className="text-[13px] leading-5 text-slate-600">{t('loadFailed')}</p>
      ) : images.length === 0 ? (
        <p className="text-[13px] leading-5 text-slate-600">{t('empty')}</p>
      ) : (
        <ul ref={list} className="divide-y divide-slate-200/70">
          {images.map((image) => {
            const label = labelOf(image, t('noDescription'))
            const used = inUse(image)
            const questionId = `${id}-question-${image.id}`
            const detailsId = `${id}-details-${image.id}`
            return (
              <li key={image.id} className="flex gap-3 py-2.5">
                <Image
                  src={mediaPath(image)}
                  alt=""
                  width={image.width}
                  height={image.height}
                  sizes="48px"
                  className="h-12 w-12 shrink-0 rounded border border-slate-200 bg-slate-100 object-cover"
                  style={image.dominantColor === null ? undefined : { backgroundColor: image.dominantColor }}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] text-slate-800">{label}</p>
                  <p className={META}>
                    {t(used ? 'sizeInUse' : 'size', { width: String(image.width), height: String(image.height) })}
                  </p>
                  {confirming === image.id ? (
                    // The group name is the question and the explanation is the description: each is read in its proper role.
                    <div
                      role="group"
                      aria-labelledby={questionId}
                      aria-describedby={detailsId}
                      className="mt-2 rounded-md border border-red-200 bg-red-50/60 p-3"
                    >
                      <p className="text-[13px] leading-5 text-red-900">
                        <strong id={questionId} className="font-semibold">
                          {t('deleteQuestion', { label })}
                        </strong>{' '}
                        <span id={detailsId}>{used ? t('deleteDetailsInUse') : t('deleteDetails')}</span>
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={locked}
                          onClick={() => void remove(image)}
                          className={button('dangerSolid', 'sm')}
                        >
                          <Trash2Icon />
                          {t('deleteForever')}
                        </button>
                        <button
                          ref={cancel}
                          type="button"
                          disabled={locked}
                          onClick={() => {
                            returnTo.current = image.id
                            setConfirming(null)
                          }}
                          className={button('secondary', 'sm')}
                        >
                          {t('cancel')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        data-image-control=""
                        disabled={locked}
                        aria-label={t('reinsertAria', { label })}
                        onClick={() => onInsert(image)}
                        className={button('ghost', 'sm', '-ml-2 px-2')}
                      >
                        <ImagePlusIcon size={14} />
                        {t('reinsert')}
                      </button>
                      <button
                        type="button"
                        data-delete-for={image.id}
                        disabled={locked}
                        aria-label={t('deleteAria', { label })}
                        onClick={() => setConfirming(image.id)}
                        className={button('ghost', 'sm', 'px-2 text-red-700 hover:bg-red-50 hover:text-red-800')}
                      >
                        <Trash2Icon size={14} />
                        {t('delete')}
                      </button>
                    </div>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {canUpload && (
        // Like the cover image (CoverPanel): the image is not private, say so to keep anyone from uploading something that must stay hidden.
        <p className={HINT}>{t('publicHint')}</p>
      )}
    </section>
  )
}
