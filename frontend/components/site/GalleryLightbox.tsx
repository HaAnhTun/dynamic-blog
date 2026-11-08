'use client'

import Image from 'next/image'
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from 'react'
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from '@/components/icons'
import { formatDate } from '@/lib/date'
import { IMAGE_QUALITY } from '@/lib/image-quality'
import { mediaPath } from '@/lib/media'
import type { GalleryPhoto } from '@/lib/types'
import { TILE_INDEX_ATTRIBUTE, photoName } from './GalleryGrid'
import { FOCUS_INSET, TRANSITION } from './SectionHeading'
import { useLocale, useTranslations } from 'next-intl'
import { asLocale } from '@/lib/format'

/** The swipe threshold: far enough not to be confused with a tap, and it must be more horizontal than vertical. */
const SWIPE_MIN_PX = 48

/**
 * Always a dark background, whatever the theme: images read best on a dark background, and a light viewer in the middle of
 * a dark page (or the reverse) glares more than it helps. No `dark:` here is on purpose.
 *
 * Below 640px: full screen. `w-full` and not `w-screen`: a modal dialog is `position: fixed`, so
 * 100% is the viewport width NOT counting the scrollbar, while 100vw counts it. `max-*-none` removes the
 * limit the browser sets for `dialog:modal`. From 640px: a panel in the middle of the screen, at most 64rem wide (the site's
 * wide width), a fixed 92dvh tall — a definite height is what gives the `fill` image a frame to fit into.
 *
 * No animation, no shadow (the site convention).
 */
const DIALOG =
  'm-0 h-dvh max-h-none w-full max-w-none overflow-hidden bg-neutral-950 p-0 text-neutral-100 backdrop:bg-black/80 sm:m-auto sm:h-[92dvh] sm:w-[calc(100%-2rem)] sm:max-w-5xl sm:rounded-md'

/**
 * One grid for both layouts, so every button has a single copy in the DOM (two copies = two buttons with the same name).
 * Below 640px: row 1 the top bar (counter, Close), row 2 the image, row 3 the bottom bar (Previous … Next) — the buttons
 * within thumb reach. From 640px: Previous | image | Next on one row.
 *
 * `touch-pan-y touch-pinch-zoom`: horizontal gestures are left to JS (swipe to switch image) instead of the browser treating them as
 * scrolling and firing pointercancel; vertical scrolling and two-finger zoom still belong to the browser.
 */
const SLIDE =
  'grid h-full touch-pan-y touch-pinch-zoom grid-cols-[auto_minmax(0,1fr)_auto] grid-rows-[auto_minmax(0,1fr)_auto] sm:grid-rows-[auto_minmax(0,1fr)]'

/**
 * A 44px button, a 20px icon. The focus ring is drawn INSIDE the button (FOCUS_INSET): "Close" sits against the top-right
 * corner of the `overflow-hidden` dialog, "Previous photo"/"Next photo" against the left/right edge, so the usual ring
 * (pushed out 4px) is cut by the dialog — measured on "Close", where focus lands right when it opens: only the left edge
 * and the bottom edge remain.
 */
const BUTTON = `inline-flex h-11 w-11 items-center justify-center rounded-sm text-neutral-100 hover:bg-white/10 ${FOCUS_INSET} ${TRANSITION}`

/**
 * The image shows in the whole frame (`object-contain`) in the panel: ≤64rem from 640px, the full width below 640px.
 * An upper bound, not exact: a portrait image in a landscape panel is narrower than that, costing only one srcset step.
 */
const SLIDE_SIZES = '(min-width: 640px) 64rem, 100vw'

type Press = { x: number; y: number; onBackdrop: boolean }

/**
 * The photo viewer of the gallery. A small client island wrapping the server grid (`children`): it does not
 * render any cell, it only catches the press on a cell with event delegation — finding `data-gallery-index` — and opens a
 * `<dialog>` with `showModal()` (the top layer, the rest of the page becomes inert). Without JS the
 * press is a normal link to the image file.
 *
 * - Keyboard: ←/→ switch image (wrapping around within the page), Esc closes.
 * - Touch: a horizontal swipe ≥48px and more horizontal than vertical. Touch/pen only: dragging the mouse selects the
 *   caption text, it does not flip the image.
 * - Backdrop press closes: a press on ::backdrop has the `<dialog>` itself as its target. A separate handler because Safari
 *   has no `closedby`. Only when the press also started on the backdrop — pressing inside the image and releasing outside also
 *   produces a click on the dialog, and closing because of that would be a mistaken close.
 * - Focus: goes to "Close" when opened, back to the exact cell that was opened when closed (even after flipping to another image).
 * - Page scroll lock: the rule `html:has(dialog[open]:modal)` in globals.css, no JS.
 *
 * Every way of closing (button, Esc, backdrop, the Android Back button) goes through `dialog.close()` or the browser's
 * native close, so all of them fire the `close` event: the state is cleaned up in ONE place, `onClose`.
 */
export function GalleryLightbox({ photos, children }: { photos: GalleryPhoto[]; children: ReactNode }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const pressRef = useRef<Press | null>(null)
  const swipedRef = useRef(false)
  const [index, setIndex] = useState<number | null>(null)

  const count = photos.length
  const photo = index === null ? undefined : photos[index]

  useEffect(() => {
    const dialog = dialogRef.current
    // Only while closed: showModal() on a dialog that is already open is an InvalidStateError in older
    // browsers, and this effect re-runs on every image change.
    if (index === null || !dialog || dialog.open) return
    dialog.showModal()
    // showModal() focuses the first focusable element itself — the Close button, since it is first in the DOM. Call it
    // again to be sure: it does not depend on DOM order, and covers environments without that algorithm (jsdom).
    closeRef.current?.focus()
  }, [index])

  function step(delta: number) {
    setIndex((current) => (current === null ? current : (current + delta + count) % count))
  }

  function close() {
    dialogRef.current?.close()
  }

  function onClose() {
    setIndex(null)
    pressRef.current = null
    swipedRef.current = false
    const opener = openerRef.current
    openerRef.current = null
    opener?.focus()
  }

  function onGridClick(event: MouseEvent<HTMLDivElement>) {
    // Ctrl/⌘/Shift/Alt + press means "open in a new tab", "download"…: the browser's job, do not intercept.
    if (event.defaultPrevented || event.button !== 0) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return

    const tile = (event.target as Element).closest<HTMLElement>(`[${TILE_INDEX_ATTRIBUTE}]`)
    if (!tile || !event.currentTarget.contains(tile)) return
    const at = Number(tile.getAttribute(TILE_INDEX_ATTRIBUTE))
    // A cell that matches no image: just let the link do its own job.
    if (!Number.isInteger(at) || at < 0 || at >= count) return

    event.preventDefault()
    openerRef.current = tile
    setIndex(at)
  }

  function onKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    // Alt+← is the browser's "back"; a key with a modifier is not this dialog's.
    if (event.altKey || event.ctrlKey || event.metaKey) return

    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault()
      if (count > 1) step(event.key === 'ArrowRight' ? 1 : -1)
    } else if (event.key === 'Escape') {
      // The browser closes a modal dialog itself on Esc; do it here too so every path runs the same way,
      // and prevent the default so there is no second close.
      event.preventDefault()
      close()
    }
  }

  function onPointerDown(event: PointerEvent<HTMLDialogElement>) {
    if (!event.isPrimary) return
    swipedRef.current = false
    pressRef.current = { x: event.clientX, y: event.clientY, onBackdrop: event.target === event.currentTarget }
  }

  function onPointerUp(event: PointerEvent<HTMLDialogElement>) {
    const press = pressRef.current
    if (!press || !event.isPrimary || event.pointerType === 'mouse' || count < 2) return

    const dx = event.clientX - press.x
    const dy = event.clientY - press.y
    if (Math.abs(dx) >= SWIPE_MIN_PX && Math.abs(dx) > Math.abs(dy)) {
      // Swiping left flips to the next image, like turning a page.
      step(dx < 0 ? 1 : -1)
      // The press (if any) following this swipe must not close the viewer.
      swipedRef.current = true
    }
  }

  function onDialogClick(event: MouseEvent<HTMLDialogElement>) {
    if (swipedRef.current) {
      swipedRef.current = false
      return
    }
    if (event.target === event.currentTarget && pressRef.current?.onBackdrop) close()
  }

  const locale = asLocale(useLocale())
  const t = useTranslations('Site.gallery')
  const date = photo ? formatDate(photo.takenOn, 'long', locale) : null
  const caption = photo?.caption?.trim() || null

  return (
    <>
      {/* Event delegation: a press from a cell (a link; the Enter key also produces a click) bubbles up to here. */}
      <div onClick={onGridClick}>{children}</div>

      <dialog
        ref={dialogRef}
        aria-label={index === null ? undefined : t('dialogLabel', { index: index + 1, total: count })}
        onClose={onClose}
        onClick={onDialogClick}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          pressRef.current = null
        }}
        className={DIALOG}
      >
        {photo && index !== null ? (
          <div className={SLIDE}>
            <div className="col-span-3 flex items-center justify-between gap-4 pl-4">
              {/* The eye sees "2 / 6"; a screen reader hears the full sentence when the image changes. */}
              <p aria-live="polite" aria-atomic="true" className="text-sm tabular-nums text-neutral-400">
                <span aria-hidden="true">{`${index + 1} / ${count}`}</span>
                <span className="sr-only">{t('dialogLabel', { index: index + 1, total: count })}</span>
              </p>
              <button ref={closeRef} type="button" onClick={close} className={BUTTON}>
                <XIcon size={20} />
                <span className="sr-only">{t('close')}</span>
              </button>
            </div>

            <figure className="col-span-3 row-start-2 flex min-h-0 flex-col gap-3 px-4 pb-4 sm:col-span-1 sm:col-start-2 sm:px-2">
              {/* The `fill` frame takes the remaining height of the row; the image fits whole in it. `key`: a new image
                  is a new element, it does not linger behind the old image's caption while loading. */}
              <div className="relative min-h-0 w-full flex-1">
                <Image
                  key={photo.id}
                  src={mediaPath(photo.image)}
                  alt={photoName(photo, index, t)}
                  fill
                  sizes={SLIDE_SIZES}
                  quality={IMAGE_QUALITY.sharp}
                  loading="eager"
                  className="object-contain"
                />
              </div>
              {caption || date ? (
                <figcaption className="max-h-28 shrink-0 overflow-y-auto text-center text-sm text-neutral-300">
                  {caption}
                  {caption && date ? ' · ' : null}
                  {date && photo.takenOn ? <time dateTime={photo.takenOn}>{date}</time> : null}
                </figcaption>
              ) : null}
            </figure>

            {count > 1 ? (
              <>
                <button
                  type="button"
                  onClick={() => step(-1)}
                  className={`col-start-1 row-start-3 self-center sm:row-start-2 ${BUTTON}`}
                >
                  <ChevronLeftIcon size={20} />
                  <span className="sr-only">{t('previous')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => step(1)}
                  className={`col-start-3 row-start-3 self-center sm:row-start-2 ${BUTTON}`}
                >
                  <ChevronRightIcon size={20} />
                  <span className="sr-only">{t('next')}</span>
                </button>
              </>
            ) : null}
          </div>
        ) : null}
      </dialog>
    </>
  )
}
