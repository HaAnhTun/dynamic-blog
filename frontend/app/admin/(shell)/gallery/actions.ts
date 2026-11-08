'use server'

import { getTranslations } from 'next-intl/server'
import { updateTag } from 'next/cache'
import type { DeleteOutcome, OrderOutcome } from '@/components/admin/GalleryManager'
import type { PhotoFields, PhotoOutcome } from '@/components/admin/GalleryUploader'
import { reorderErrorMessage, runAdminAction } from '@/lib/admin-action'
import { deleteGalleryPhoto, reorderGallery, updateGalleryPhoto, uploadGalleryPhoto } from '@/lib/admin-api'
import type { Translator } from '@/i18n/translator'
import { MAX_UPLOAD_BYTES } from '@/lib/prepare-upload'

/*
 * The four actions of the photo screen. Each successful write clears two tags:
 * 'gallery' (/gallery, the photo feed on the home page and About) and 'stats': stats.galleryPhotos
 * decides whether those two photo sections show and whether /gallery is in the sitemap, so without it
 * the first uploaded photo (or the last one hidden or deleted) takes up to 300 seconds to take effect.
 * Cleared only on success: updateTag also re-renders the current page in the action's response, which is
 * useless for a failure.
 */

function invalidate() {
  updateTag('gallery')
  updateTag('stats')
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

type CleanFields = { altText: string; caption: string | null; takenOn: string | null }

/**
 * The text part shared by upload and edit. The description is required (it is the accessible name of the photo cell on
 * /gallery), checked here too because an action is an endpoint anyone can POST to. An empty field becomes
 * null: on upload, null means not sent (date → the backend reads EXIF); on edit, null means clear. The length
 * is not checked here: the backend counts characters after trim, the input already limits it with maxLength.
 */
function clean(t: Translator, altText: unknown, caption: unknown, takenOn: unknown): CleanFields | { error: string } {
  if (typeof altText !== 'string' || altText.trim() === '') return { error: t('altRequired') }
  const date = typeof takenOn === 'string' ? takenOn.trim() : ''
  if (date !== '' && !ISO_DATE.test(date)) return { error: t('badDate') }
  return {
    altText,
    caption: typeof caption === 'string' && caption.trim() !== '' ? caption : null,
    takenOn: date === '' ? null : date,
  }
}

/**
 * One file per call (`file`), with `altText`, `caption`, `takenOn`, `published`. The file is rechecked
 * in the same order as uploadCover: is a File, not empty, ≤ MAX_UPLOAD_BYTES —
 * the browser already shrank it to that size, so a larger file means the client skipped that step. The file type
 * is not checked here: `type` is declared by the client, the backend is the one reading magic bytes.
 */
export async function uploadPhoto(form: FormData): Promise<PhotoOutcome> {
  const t = await getTranslations('Admin.gallery.errors')
  const file = form.get('file')
  // An empty file picker still sends a File of size 0 with an empty name.
  if (!(file instanceof File) || file.size === 0) return { error: t('noFile') }
  if (file.size > MAX_UPLOAD_BYTES) return { error: t('fileTooLarge') }
  const fields = clean(t, form.get('altText'), form.get('caption'), form.get('takenOn'))
  if ('error' in fields) return fields
  // Visible by default, like the backend: only the exact string 'false' means hidden.
  const published = form.get('published') !== 'false'
  const result = await runAdminAction(() => uploadGalleryPhoto(file, { ...fields, published }))
  if ('error' in result) return result
  invalidate()
  return result
}

/** Replace the caption, description, taken date and visibility flag of a photo in full (PUT). */
export async function savePhoto(id: string, input: PhotoFields): Promise<PhotoOutcome> {
  const t = await getTranslations('Admin.gallery.errors')
  // The visibility flag is required: a "replace everything" missing it would have to guess hidden or visible.
  if (typeof input?.published !== 'boolean') return { error: t('missingVisibility') }
  const fields = clean(t, input.altText, input.caption, input.takenOn)
  if ('error' in fields) return fields
  const result = await runAdminAction(() => updateGalleryPhoto(id, { ...fields, published: input.published }))
  if ('error' in result) return result
  invalidate()
  return result
}

/** Delete the photo together with its bytes (204 → null). */
export async function removePhoto(id: string): Promise<DeleteOutcome> {
  const result = await runAdminAction(() => deleteGalleryPhoto(id))
  if (result !== null) return result
  invalidate()
  return null
}

/**
 * The new order of EVERY photo: the i-th photo gets order i. At this endpoint a 400 (not a full permutation:
 * VALIDATION_ERROR; unknown id: GALLERY_PHOTO_NOT_FOUND) means the list sent is stale — a photo
 * was just uploaded or deleted elsewhere — so the answer is `reorderErrorMessage`: reload the page.
 */
export async function saveOrder(photoIds: string[]): Promise<OrderOutcome> {
  const result = await runAdminAction(() => reorderGallery(photoIds), reorderErrorMessage)
  if ('error' in result) return result
  invalidate()
  return result
}
