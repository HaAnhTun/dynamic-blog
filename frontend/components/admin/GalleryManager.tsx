'use client'

import { useTranslations } from 'next-intl'
import Image from 'next/image'
import { useEffect, useId, useRef, useState } from 'react'
import { ArrowDownIcon, ArrowUpIcon, ImagesIcon, Trash2Icon } from '@/components/icons'
import type { Translator } from '@/i18n/translator'
import { mediaPath } from '@/lib/media'
import type { GalleryPhotoAdmin } from '@/lib/types'
import GalleryUploader, {
  PHOTO_FRAME,
  PHOTO_FRAME_SIZES,
  PHOTO_ROW_ASIDE,
  PHOTO_ROW_LAYOUT,
  type PhotoFields,
  type PhotoOutcome,
  PhotoFieldInputs,
  isOutcomeError,
} from './GalleryUploader'
import { isRedirectError } from './PostEditor'
import { EmptyState, ErrorAlert } from './primitives'
import { FOCUS_RING, H2, ICON_BUTTON, LIST, META, SECTION_DESC, STATUS_TEXT, WARN_TEXT, button } from './ui'

/** Result of saving the order: every image in the order the backend stored, or an error to show in place. */
export type OrderOutcome = GalleryPhotoAdmin[] | { error: string }
/** Result of a delete: null means deleted (the backend returns 204). */
export type DeleteOutcome = { error: string } | null

export type GalleryManagerProps = {
  /** Every image, hidden ones included, in the current order (`sort_order`, then newest first). */
  photos: GalleryPhotoAdmin[]
  onUpload: (form: FormData) => Promise<PhotoOutcome>
  onSave: (id: string, fields: PhotoFields) => Promise<PhotoOutcome>
  onDelete: (id: string) => Promise<DeleteOutcome>
  /** Must be an exact permutation of EVERY image; a stale list → the "reload the page" sentence. */
  onReorder: (photoIds: string[]) => Promise<OrderOutcome>
}

function fieldsOf(photo: GalleryPhotoAdmin): PhotoFields {
  return {
    altText: photo.image.altText ?? '',
    caption: photo.caption ?? '',
    takenOn: photo.takenOn ?? '',
    published: photo.published,
  }
}

/** Name used to talk about an image (button, message): the saved description, or the original file name when there is none. */
function nameOf(photo: GalleryPhotoAdmin, t: Translator): string {
  return photo.image.altText?.trim() || photo.originalFilename || t('noDescriptionName')
}

/**
 * Calls an action, catching rejected promises too: throwing from an async handler reaches no error boundary,
 * and the author would see nothing (an old bug). undefined when it is a redirect error (expired session):
 * the router is navigating by itself, so it is not an error to show.
 */
async function settle<T>(action: () => Promise<T>, unreachable: string): Promise<T | { error: string } | undefined> {
  try {
    return await action()
  } catch (caught) {
    if (isRedirectError(caught)) return undefined
    console.error('Gallery action failed', caught)
    return { error: unreachable }
  }
}

/**
 * The images screen: the upload area, then the existing images — edit in place (description, caption,
 * capture date, visibility), ↑↓, delete with in-place confirmation, and the save-order button.
 *
 * Edits and deletes take effect immediately; ↑↓ only reorder on screen until the save-order button is pressed, because
 * that command replaces the order of EVERY image at once (a full permutation). So the list here must always be
 * exactly every image: a just-uploaded image is put first right away (where the backend puts it), and the save-order button
 * is locked while a batch is uploading — an image still mid-upload is not in the list yet, and that save would
 * be rejected as if from a stale tab.
 *
 * The save-order button and the status line sit right under the heading, not at the bottom: the list can be many
 * screens long, and the heading is where focus returns after a delete, so the "image deleted" sentence appears
 * right next to where the user is.
 */
export default function GalleryManager({ photos, onUpload, onSave, onDelete, onReorder }: GalleryManagerProps) {
  const t = useTranslations('Admin.gallery.manager')
  const id = useId()
  // State, not read from props: updateTag in the action makes the page re-render, but the new props
  // must not overwrite an order that is half sorted. Each saved change is applied from the action result.
  const [items, setItems] = useState(photos)
  const [dirty, setDirty] = useState(false)
  const [pending, setPending] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const heading = useRef<HTMLHeadingElement>(null)

  /** Locks every button of the grid until the action finishes: clicking twice does not send twice. */
  async function locked<T>(action: () => Promise<T>) {
    setError(null)
    setNotice('')
    setPending(true)
    try {
      return await settle(action, t('unreachable'))
    } finally {
      setPending(false)
    }
  }

  function move(index: number, delta: -1 | 1) {
    const target = index + delta
    if (target < 0 || target >= items.length) return
    const next = [...items]
    ;[next[index], next[target]] = [next[target], next[index]]
    setItems(next)
    setDirty(true)
    setError(null)
    // Screen-reader users cannot see the row jump: announce the new position.
    setNotice(t('movedTo', { name: nameOf(next[target], t), position: target + 1 }))
  }

  async function saveOrder() {
    const result = await locked(() => onReorder(items.map((photo) => photo.id)))
    if (result === undefined) return
    if (isOutcomeError(result)) {
      setError(result.error)
      return
    }
    setItems(result)
    setDirty(false)
    setNotice(t('orderSaved'))
  }

  async function save(photo: GalleryPhotoAdmin, fields: PhotoFields) {
    const result = await locked(() => onSave(photo.id, fields))
    if (result !== undefined && !isOutcomeError(result)) {
      setItems((current) => current.map((item) => (item.id === result.id ? result : item)))
      setNotice(t('photoSaved', { name: nameOf(result, t) }))
    }
    return result
  }

  async function remove(photo: GalleryPhotoAdmin) {
    const result = await locked(() => onDelete(photo.id))
    if (result === null) {
      setItems((current) => current.filter((item) => item.id !== photo.id))
      setNotice(t('photoDeleted', { name: nameOf(photo, t) }))
      // The permanent-delete button holding focus leaves the page with its row; without this line focus
      // would fall back to <body>. The list heading is the nearest place left, even when no images remain.
      heading.current?.focus()
    }
    return result
  }

  const headingId = `${id}-heading`
  // Counted over the list currently shown, not props: an image just uploaded, deleted or hidden counts immediately.
  const hiddenCount = items.filter((photo) => !photo.published).length
  const tally =
    hiddenCount > 0 ? t('tallyWithHidden', { count: items.length, hidden: hiddenCount }) : t('tally', { count: items.length })

  return (
    <div className="space-y-10">
      <GalleryUploader
        onUpload={onUpload}
        onUploaded={(photo) => setItems((current) => [photo, ...current.filter((item) => item.id !== photo.id)])}
        onBusyChange={setUploading}
      />

      <section aria-labelledby={headingId}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 id={headingId} ref={heading} tabIndex={-1} className={`${H2} rounded-sm ${FOCUS_RING}`}>
                {t('heading')}
              </h2>
              {items.length > 0 && <p className={META}>{tally}</p>}
            </div>
            {/* The button name inside the sentence is not split across two lines: the reader finds exactly that text on the button. */}
            <p className={SECTION_DESC}>
              {t.rich('hint', { nowrap: (chunks) => <span className="whitespace-nowrap">{chunks}</span> })}
            </p>
          </div>
          {items.length > 0 && (
            // DOM: button first, reminder after. From sm the row reverses so the button sits against the right edge: the reminder
            // appearing or disappearing never pushes the button, at both widths.
            <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 sm:flex-row-reverse">
              <button
                type="button"
                disabled={pending || uploading}
                onClick={() => void saveOrder()}
                className={button('primary')}
              >
                {t('saveOrder')}
              </button>
              {dirty && <span className={WARN_TEXT}>{t('unsaved')}</span>}
            </div>
          )}
        </div>

        <div className="mt-3 space-y-3">
          {error !== null && <ErrorAlert>{error}</ErrorAlert>}
          {/* Always present: a live region must exist before its content changes for the change to be announced.
              `min-h-6` reserves one line: the sentence appearing on save does not push the whole list down
              right under the cursor. */}
          <p role="status" className={`min-h-6 ${STATUS_TEXT}`}>
            {notice}
          </p>
        </div>

        <div className="mt-3">
          {items.length === 0 ? (
            <EmptyState icon={<ImagesIcon size={20} />} title={t('emptyTitle')}>
              {t.rich('emptyBody', { nowrap: (chunks) => <span className="whitespace-nowrap">{chunks}</span> })}
            </EmptyState>
          ) : (
            <ol aria-label={t('orderLabel')} className={LIST}>
              {items.map((photo, index) => (
                <PhotoRow
                  key={photo.id}
                  photo={photo}
                  position={index + 1}
                  first={index === 0}
                  last={index === items.length - 1}
                  busy={pending}
                  onMove={(delta) => move(index, delta)}
                  onSave={(fields) => save(photo, fields)}
                  onDelete={() => remove(photo)}
                />
              ))}
            </ol>
          )}
        </div>
      </section>
    </div>
  )
}

function PhotoRow({
  photo,
  position,
  first,
  last,
  busy,
  onMove,
  onSave,
  onDelete,
}: {
  photo: GalleryPhotoAdmin
  /** Position on screen, from 1: changes as soon as ↑↓ is pressed, even before saving. */
  position: number
  first: boolean
  last: boolean
  busy: boolean
  onMove: (delta: -1 | 1) => void
  onSave: (fields: PhotoFields) => Promise<PhotoOutcome | undefined>
  onDelete: () => Promise<DeleteOutcome | undefined>
}) {
  const t = useTranslations('Admin.gallery.manager')
  const id = useId()
  // The boxes being edited, belonging to this image only; kept when the row moves (key is the image id).
  const [fields, setFields] = useState(() => fieldsOf(photo))
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  // Only restore focus after the confirmation step has been opened at least once, not when the page has just loaded.
  const opened = useRef(false)

  // Like DeleteSeries: opening the confirmation step puts focus on cancel (a second Enter on the same spot must be
  // cancel, not delete), and cancelling returns it to the delete button.
  useEffect(() => {
    if (confirming) {
      opened.current = true
      cancel.current?.focus()
    } else if (opened.current) {
      trigger.current?.focus()
    }
  }, [confirming])

  async function save() {
    setError(null)
    const result = await onSave(fields)
    if (result === undefined) return
    if (isOutcomeError(result)) {
      setError(result.error)
      return
    }
    // The values the backend saved (trimmed, a blank box becomes empty), not the string just typed.
    setFields(fieldsOf(result))
  }

  async function confirmDelete() {
    setError(null)
    const result = await onDelete()
    // On success this row leaves the list; only an error is left to show.
    if (result !== undefined && result !== null) setError(result.error)
  }

  const name = nameOf(photo, t)
  const promptId = `${id}-prompt`

  return (
    <li className="@container p-4 sm:p-5">
      <div className={PHOTO_ROW_LAYOUT}>
        <div className={PHOTO_ROW_ASIDE}>
          <span className={PHOTO_FRAME}>
            <Image
              src={mediaPath(photo.image)}
              alt={photo.image.altText ?? t('noDescriptionAlt')}
              fill
              sizes={PHOTO_FRAME_SIZES}
              className="object-cover"
            />
            {/* The ordinal number is for sighted users; <ol> already announces the position to screen readers. */}
            <span
              aria-hidden="true"
              className="absolute top-2 left-2 min-w-6 rounded bg-slate-900/80 px-1.5 text-center text-xs leading-5 font-semibold tabular-nums text-white"
            >
              {position}
            </span>
            {/* Real text, not aria-hidden: the status must be read out together with the image. A near-white background
                keeps it readable on any image; a colored dot like StatusBadge, never color alone. */}
            {!photo.published && (
              <span className="absolute bottom-2 left-2 inline-flex items-center gap-1.5 rounded bg-white/95 px-1.5 text-xs leading-5 font-medium text-amber-800 shadow-sm">
                <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
                {t('hiddenBadge')}
              </span>
            )}
          </span>
          <div className="flex items-center gap-1">
            {/* aria-disabled at the first/last position instead of disabled: the button that just moved an image to the top still keeps
                focus, not falling back to <body> midway while reordering by keyboard. */}
            <button
              type="button"
              disabled={busy}
              aria-disabled={first ? true : undefined}
              onClick={() => onMove(-1)}
              title={t('moveUp')}
              className={ICON_BUTTON}
            >
              <ArrowUpIcon />
              <span className="sr-only">{t('moveUpLabel', { name })}</span>
            </button>
            <button
              type="button"
              disabled={busy}
              aria-disabled={last ? true : undefined}
              onClick={() => onMove(1)}
              title={t('moveDown')}
              className={ICON_BUTTON}
            >
              <ArrowDownIcon />
              <span className="sr-only">{t('moveDownLabel', { name })}</span>
            </button>
          </div>
        </div>

        <div className="min-w-0 flex-1 space-y-5">
          <PhotoFieldInputs idPrefix={id} fields={fields} disabled={busy} onChange={setFields} />

          {error !== null && <ErrorAlert>{error}</ErrorAlert>}

          {/* Save on the left, delete pushed to the right edge. The confirmation step replaces the delete button in place and spans the whole
              row (w-full wraps to its own line), so the save button stays put while asking. */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              disabled={busy || fields.altText.trim() === ''}
              onClick={() => void save()}
              className={button('secondary', 'sm')}
            >
              {/* Whitespace goes OUTSIDE the span: the accessible name trims leading/trailing whitespace of each child
                  element, so a leading space inside the span would glue the words together in the button name. */}
              {t('save')} <span className="sr-only">{t('photoSubject', { name })}</span>
            </button>
            {confirming ? (
              <div role="group" aria-labelledby={promptId} className="w-full rounded-lg border border-red-200 bg-red-50/60 p-4">
                <p id={promptId} className="text-sm font-medium text-red-900">
                  {t('deleteQuestion')}
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void confirmDelete()}
                    className={button('dangerSolid', 'sm')}
                  >
                    <Trash2Icon />
                    {t('deleteConfirm')}
                  </button>
                  <button
                    ref={cancel}
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setError(null)
                      setConfirming(false)
                    }}
                    className={button('secondary', 'sm')}
                  >
                    {t('cancel')}
                  </button>
                </div>
              </div>
            ) : (
              <button
                ref={trigger}
                type="button"
                disabled={busy}
                onClick={() => setConfirming(true)}
                className={button('danger', 'sm')}
              >
                <Trash2Icon />
                {t('delete')} <span className="sr-only">{t('photoSubject', { name })}</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </li>
  )
}
