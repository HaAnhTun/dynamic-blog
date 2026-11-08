'use client'

import { useTranslations } from 'next-intl'
import Image from 'next/image'
import { type DragEvent, useEffect, useId, useRef, useState } from 'react'
import { ImagePlusIcon, UploadIcon, XIcon } from '@/components/icons'
import { readExifTakenOn } from '@/lib/exif-date'
import { ACCEPTED_UPLOAD_TYPES, UploadRejectedError, prepareUpload } from '@/lib/prepare-upload'
import type { GalleryPhotoAdmin } from '@/lib/types'
import { isRedirectError } from './PostEditor'
import { ErrorAlert } from './primitives'
import { CARD, CHECKBOX, H2, HINT, ICON_BUTTON, INPUT, LABEL, LIST, SECTION_DESC, STATUS_TEXT, WARN_TEXT, button } from './ui'

/**
 * The text part of a gallery image, exactly as the boxes show it: an empty string is an empty box. The action
 * (app/admin/(shell)/gallery/actions.ts) turns an empty box into null and re-validates everything.
 */
export type PhotoFields = {
  altText: string
  caption: string
  /** `yyyy-MM-dd` of the `<input type="date">`, or empty. */
  takenOn: string
  published: boolean
}

/** Result of the action that uploads or edits an image: the image the backend saved, or an error to show in place. */
export type PhotoOutcome = GalleryPhotoAdmin | { error: string }

/** `aria-live` spelled out although role="status" implies it: the "2/3" progress must be announced. */
const LIVE = { role: 'status', 'aria-live': 'polite' } as const

export function isOutcomeError(value: unknown): value is { error: string } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'error' in value
}

/**
 * One image in a list (the queue here, the existing images in GalleryManager): full row width when the row is
 * narrow, an 11rem column beside the boxes when the row is wide enough. The switch point is a container query on the width of the
 * row itself (`@container` on the <li>, 36rem), not on the screen: the same row sits in the upload card
 * or directly on the page, beside a sidebar or not, and only its real width can say whether two columns
 * fit.
 */
export const PHOTO_ROW_LAYOUT = 'flex flex-col gap-4 @xl:flex-row @xl:gap-6'
export const PHOTO_ROW_ASIDE = 'flex shrink-0 flex-col gap-3 @xl:w-44'
export const PHOTO_FRAME = 'relative block aspect-[4/3] w-full overflow-hidden rounded-md border border-slate-200 bg-slate-100'

/**
 * `sizes` of the image in PHOTO_FRAME. Because the layout switch is a container query, `sizes` (which only knows the
 * screen width) can only give an upper bound: the image is never wider than 36rem (only rows narrower than that
 * stack), and from 1280px the row is certainly wide enough for the image to sit beside the boxes, even next to a sidebar.
 * Declaring less than the real width gives a blurry image; declaring more only costs a few hundred KB on the admin screen.
 */
export const PHOTO_FRAME_SIZES = '(min-width: 1280px) 11rem, (min-width: 640px) 36rem, 100vw'

/**
 * The boxes of one image, shared by the upload queue and the existing-images grid, so both places ask
 * exactly the same set of questions. The description (alt) is required: it is the accessible name of the image tile on /gallery,
 * and an unnamed image is left with just a numbered placeholder for screen-reader users.
 *
 * The description and caption span the full block (a sentence describing an image is longer than half a column); the capture date and the visibility
 * toggle split the width in two when the block is wide enough. Like the row that contains it, the block asks about its own width
 * (`@container`), because it sits beside the thumbnail rather than spanning the whole screen.
 */
export function PhotoFieldInputs({
  idPrefix,
  fields,
  disabled,
  dateHint,
  onChange,
}: {
  idPrefix: string
  fields: PhotoFields
  disabled: boolean
  dateHint?: string
  onChange: (next: PhotoFields) => void
}) {
  const t = useTranslations('Admin.gallery.fields')
  const id = (name: string) => `${idPrefix}-${name}`
  const set = <K extends keyof PhotoFields>(name: K, value: PhotoFields[K]) => onChange({ ...fields, [name]: value })

  return (
    <div className="@container">
      <div className="grid gap-5 @md:grid-cols-2 @md:gap-x-4">
        <div className="@md:col-span-2">
          <label htmlFor={id('alt')} className={LABEL}>
            {t('altLabel')}
          </label>
          <input
            id={id('alt')}
            type="text"
            value={fields.altText}
            required
            maxLength={300}
            disabled={disabled}
            onChange={(event) => set('altText', event.target.value)}
            aria-describedby={id('alt-hint')}
            className={INPUT}
          />
          <p id={id('alt-hint')} className={HINT}>
            {t('altHint')}
          </p>
        </div>
        <div className="@md:col-span-2">
          <label htmlFor={id('caption')} className={LABEL}>
            {t('captionLabel')}
          </label>
          <textarea
            id={id('caption')}
            rows={2}
            value={fields.caption}
            maxLength={1000}
            disabled={disabled}
            onChange={(event) => set('caption', event.target.value)}
            className={INPUT}
          />
        </div>
        <div>
          <label htmlFor={id('date')} className={LABEL}>
            {t('dateLabel')}
          </label>
          <input
            id={id('date')}
            type="date"
            value={fields.takenOn}
            disabled={disabled}
            onChange={(event) => set('takenOn', event.target.value)}
            aria-describedby={dateHint === undefined ? undefined : id('date-hint')}
            className={INPUT}
          />
          {dateHint !== undefined && (
            <p id={id('date-hint')} className={HINT}>
              {dateHint}
            </p>
          )}
        </div>
        <div>
          <div className="flex items-center gap-2">
            <input
              id={id('published')}
              type="checkbox"
              checked={fields.published}
              disabled={disabled}
              onChange={(event) => set('published', event.target.checked)}
              aria-describedby={id('published-hint')}
              className={CHECKBOX}
            />
            <label htmlFor={id('published')} className="text-sm font-medium text-slate-800">
              {t('publishedLabel')}
            </label>
          </div>
          {/* Images are served publicly by a hard-to-guess UUID: hidden means not listed,
              not private. Say so right next to the toggle, so nobody uploads something that must stay hidden.
              `pl-6` lines up with the label text, not with the checkbox. */}
          <p id={id('published-hint')} className={`${HINT} pl-6`}>
            {t('publishedHint')}
          </p>
        </div>
      </div>
    </div>
  )
}

type QueueItem = {
  key: string
  file: File
  /** The file's own `blob:` URL, for the preview. Released (revoked) when the file leaves the queue. */
  preview: string
  fields: PhotoFields
  error: string | null
}

const BLANK: PhotoFields = { altText: '', caption: '', takenOn: '', published: true }

/**
 * Whether what is being dragged is a file. Dragging a piece of text or a link over the page does not light up the frame,
 * is not accepted, and the page blocks nothing: only files are this screen's business.
 */
function carriesFiles(transfer: DataTransfer | null): transfer is DataTransfer {
  return transfer !== null && Array.from(transfer.types).includes('Files')
}

export type GalleryUploaderProps = {
  /** One file per call: a broken image does not drag the whole batch down, and each body stays under
   *  the 5 MiB limit of the Server Action. */
  onUpload: (form: FormData) => Promise<PhotoOutcome>
  /** Each image just uploaded, as soon as it is up: the existing-images grid puts it first like the backend. */
  onUploaded?: (photo: GalleryPhotoAdmin) => void
  /** Start/end of a batch: the grid locks the save-order button meanwhile (see GalleryManager). */
  onBusyChange?: (busy: boolean) => void
}

/**
 * Upload several images to the gallery: choose or drag and drop several files → a queue with previews,
 * required description, caption, capture date, visibility → the upload button sends each file SEQUENTIALLY through
 * prepareUpload (downsized in the browser) then the action, progress "2/3" in the live region. One failed file
 * does not block the next: its error shows right next to it and it stays in the queue to fix or retry; files that are
 * up leave the queue.
 *
 * The file input has no `name` and is in no form: the image has a single path, through the action, after being
 * downsized (like CoverPanel). Dropping files on the frame follows exactly that path: the same `add` function as the input.
 */
export default function GalleryUploader({ onUpload, onUploaded, onBusyChange }: GalleryUploaderProps) {
  const t = useTranslations('Admin.gallery.uploader')
  const id = useId()
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [dragging, setDragging] = useState(false)
  const nextKey = useRef(0)
  // Every blob URL still alive, to release them when leaving the page midway (a blob keeps the whole file in memory).
  const previews = useRef(new Set<string>())
  // Number of dragenter events without a matching dragleave. The pointer going from text to a button inside the frame also fires
  // dragleave on the text (after dragenter on the button), so the frame only turns off when this reaches 0, without flicker.
  const dragDepth = useRef(0)

  useEffect(() => {
    const live = previews.current
    return () => {
      for (const url of live) URL.revokeObjectURL(url)
      live.clear()
    }
  }, [])

  useEffect(() => {
    // A file dropped outside the frame makes the browser by default OPEN it in this very tab: leaving the page and
    // losing the half-filled queue. On this page a file dropped outside the frame does nothing (the "drop not
    // allowed" cursor). The frame already cancels the default before the event bubbles to window, so it is not blocked along with it.
    function guard(event: globalThis.DragEvent) {
      if (event.defaultPrevented || !carriesFiles(event.dataTransfer)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'none'
    }
    window.addEventListener('dragover', guard)
    window.addEventListener('drop', guard)
    return () => {
      window.removeEventListener('dragover', guard)
      window.removeEventListener('drop', guard)
    }
  }, [])

  function add(files: FileList | null) {
    if (files === null || files.length === 0) return
    const added = Array.from(files, (file): QueueItem => {
      nextKey.current += 1
      const preview = URL.createObjectURL(file)
      previews.current.add(preview)
      return { key: `f${nextKey.current}`, file, preview, fields: BLANK, error: null }
    })
    setQueue((current) => [...current, ...added])
    setProgress('')
  }

  function drop(item: QueueItem) {
    URL.revokeObjectURL(item.preview)
    previews.current.delete(item.preview)
    setQueue((current) => current.filter((queued) => queued.key !== item.key))
  }

  function patch(key: string, change: Partial<QueueItem>) {
    setQueue((current) => current.map((item) => (item.key === key ? { ...item, ...change } : item)))
  }

  /** One file: downsize, then the action. undefined when the action redirects (expired session): the router is
   *  navigating by itself, it is not an error to show, and no further file must be sent. */
  async function uploadOne(item: QueueItem): Promise<PhotoOutcome | undefined> {
    let ready: File
    try {
      ready = await prepareUpload(item.file)
    } catch (caught) {
      if (caught instanceof UploadRejectedError) return { error: caught.message }
      console.error('prepareUpload failed', caught)
      return { error: t('unreadable') }
    }
    // The date box is empty and the image was just redrawn through canvas: the new JPEG has no EXIF, so the backend has nowhere to read
    // the capture date. Read DateTimeOriginal from the ORIGINAL file here so the promise under the date box stays true. A file sent
    // as is leaves the backend to read it as before; a date the user typed always wins.
    const takenOn =
      item.fields.takenOn.trim() === '' && ready !== item.file ? ((await readExifTakenOn(item.file)) ?? '') : item.fields.takenOn
    const form = new FormData()
    form.append('file', ready)
    form.append('altText', item.fields.altText)
    form.append('caption', item.fields.caption)
    form.append('takenOn', takenOn)
    form.append('published', String(item.fields.published))
    try {
      return await onUpload(form)
    } catch (caught) {
      // Catch rejected promises too: throwing from an async handler reaches no error boundary, and
      // the author would see nothing (an old bug).
      if (isRedirectError(caught)) return undefined
      console.error('Gallery upload action failed', caught)
      return { error: t('unreachable') }
    }
  }

  async function uploadAll() {
    // Snapshot taken at click time: every box is locked while uploading, so the content does not change midway.
    const batch = queue
    if (busy || batch.length === 0 || batch.some((item) => item.fields.altText.trim() === '')) return
    setBusy(true)
    onBusyChange?.(true)
    let uploaded = 0
    try {
      for (const [index, item] of batch.entries()) {
        setProgress(t('progress', { current: index + 1, total: batch.length }))
        patch(item.key, { error: null })
        const outcome = await uploadOne(item)
        if (outcome === undefined) return
        if (isOutcomeError(outcome)) {
          patch(item.key, { error: outcome.error })
          continue
        }
        uploaded += 1
        drop(item)
        onUploaded?.(outcome)
      }
      const failed = batch.length - uploaded
      setProgress(
        failed > 0
          ? t('doneWithFailures', { uploaded, total: batch.length, failed })
          : t('done', { uploaded, total: batch.length }),
      )
    } finally {
      setBusy(false)
      onBusyChange?.(false)
    }
  }

  /*
   * Drag and drop onto the frame. Cancelling the default on dragenter/dragover is what lets the browser allow the drop here;
   * on drop it keeps the browser from opening the file itself. While uploading the frame still cancels the default (so the browser
   * does not open the file) but shows the "drop not allowed" cursor and ignores the file, like the locked file input.
   */
  function dragEnter(event: DragEvent<HTMLDivElement>) {
    if (!carriesFiles(event.dataTransfer)) return
    event.preventDefault()
    dragDepth.current += 1
    setDragging(true)
  }

  function dragOver(event: DragEvent<HTMLDivElement>) {
    if (!carriesFiles(event.dataTransfer)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = busy ? 'none' : 'copy'
  }

  function dragLeave(event: DragEvent<HTMLDivElement>) {
    if (!carriesFiles(event.dataTransfer)) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }

  function dropFiles(event: DragEvent<HTMLDivElement>) {
    if (!carriesFiles(event.dataTransfer)) return
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    if (busy) return
    add(event.dataTransfer.files)
  }

  const headingId = `${id}-heading`
  const fileId = `${id}-file`
  const missingAlt = queue.some((item) => item.fields.altText.trim() === '')

  return (
    <section aria-labelledby={headingId} className={`${CARD} p-5 sm:p-6`}>
      <h2 id={headingId} className={H2}>
        {t('heading')}
      </h2>
      <p className={SECTION_DESC}>{t('intro')}</p>

      <div className="mt-5 space-y-5">
        {/* Drop frame: dashed border, thicker while files are dragged over it (`data-dragging`). Not a button:
            the real button is the file input, hidden from sight but still where Tab stops, with the choose-images label drawn like a
            secondary button. The drag-and-drop sentence is OUTSIDE the label, so the input's accessible name is exactly the choose-images label. */}
        <div
          data-dragging={dragging && !busy ? '' : undefined}
          onDragEnter={dragEnter}
          onDragOver={dragOver}
          onDragLeave={dragLeave}
          onDrop={dropFiles}
          className="group relative flex flex-col items-center rounded-lg border-2 border-dashed border-slate-300 bg-white px-4 py-8 text-center transition-colors duration-150 motion-reduce:transition-none data-dragging:border-slate-500 data-dragging:bg-slate-50 sm:px-6 sm:py-10"
        >
          <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-500 transition-colors duration-150 motion-reduce:transition-none group-data-dragging:bg-white group-data-dragging:text-slate-900">
            <ImagePlusIcon size={20} />
          </span>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <span className="text-sm text-slate-700">{t('dropPrompt')}</span>
            {/* No `name`: see the component comment. `peer`: the label right after it carries the focus ring
                and the locked look of the input, because nobody sees the input itself. */}
            <input
              id={fileId}
              type="file"
              multiple
              accept={ACCEPTED_UPLOAD_TYPES.join(',')}
              disabled={busy}
              onChange={(event) => {
                add(event.target.files)
                // Choosing exactly the same files again (after removing them from the queue) must still fire a change event.
                event.target.value = ''
              }}
              aria-describedby={`${fileId}-hint`}
              className="peer sr-only"
            />
            <label
              htmlFor={fileId}
              className={button(
                'secondary',
                'sm',
                'cursor-pointer peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 outline-brand peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
              )}
            >
              {t('choose')}
            </label>
          </div>
          {/* `text-balance`: one line when the frame is wide enough, wrapping gives two lines of similar length
              instead of an orphan word in the middle of a centered frame. */}
          <p id={`${fileId}-hint`} className={`${HINT} text-balance`}>
            {t('chooseHint')}
          </p>
        </div>

        {queue.length > 0 && (
          <ul aria-label={t('queueLabel')} className={LIST}>
            {queue.map((item) => (
              <li key={item.key} className="@container p-4 sm:p-5">
                <div className={PHOTO_ROW_LAYOUT}>
                  <div className={PHOTO_ROW_ASIDE}>
                    <span className={PHOTO_FRAME}>
                      {/* With blob: next/image skips optimization (get-img-props) and uses the URL directly. */}
                      <Image
                        src={item.preview}
                        alt={t('previewAlt', { name: item.file.name })}
                        fill
                        sizes={PHOTO_FRAME_SIZES}
                        className="object-cover"
                      />
                    </span>
                  </div>
                  <div className="min-w-0 flex-1 space-y-5">
                    <div className="flex items-start justify-between gap-3">
                      <p className="min-w-0 pt-1.5 text-sm font-medium break-all text-slate-900">{item.file.name}</p>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => drop(item)}
                        title={t('removeFromQueue')}
                        className={ICON_BUTTON}
                      >
                        <XIcon />
                        <span className="sr-only">{t('removeFromQueueLabel', { name: item.file.name })}</span>
                      </button>
                    </div>
                    {/* The error of this very file, right under its name: visible without scrolling past
                        the boxes, and it talks about the file (format, size) more than about the boxes. */}
                    {item.error !== null && <ErrorAlert>{item.error}</ErrorAlert>}
                    <PhotoFieldInputs
                      idPrefix={`${id}-${item.key}`}
                      fields={item.fields}
                      disabled={busy}
                      dateHint={t('dateHint')}
                      onChange={(fields) => patch(item.key, { fields })}
                    />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <button
            type="button"
            disabled={busy || queue.length === 0 || missingAlt}
            onClick={() => void uploadAll()}
            className={button('primary')}
          >
            <UploadIcon />
            {t('upload')}
          </button>
          {missingAlt && !busy && <span className={WARN_TEXT}>{t('altNeeded')}</span>}
          {/* Always present: a live region must exist before its content changes for the change to be announced. Placed
              after the button in the same row: text getting longer or shorter does not push the button elsewhere. */}
          <p {...LIVE} className={`min-w-0 ${STATUS_TEXT}`}>
            {progress}
          </p>
        </div>
      </div>
    </section>
  )
}
