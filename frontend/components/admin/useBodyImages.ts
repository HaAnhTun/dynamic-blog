'use client'

import { useTranslations } from 'next-intl'
import { useRef, useState } from 'react'
import { altFromFileName } from '@/lib/post-markdown'
import { UploadRejectedError, prepareUpload, uploadRejectedMessage } from '@/lib/prepare-upload'
import type { MediaRef } from '@/lib/types'
import type { ActionError, ImageListOutcome, ImageUploadOutcome } from './editor-types'

export type BodyImages = {
  /** Images of the post body, newest first; null when the list could not be loaded when the page opened. */
  images: MediaRef[] | null
  canUpload: boolean
  /** Uploading or deleting: one job at a time. */
  busy: boolean
  uploading: boolean
  /** Sentence for the status region next to the insert-image button (uploading, image inserted into the content). */
  status: string
  /** Uploads then inserts each file in turn. Never rejects: errors go through `report`/`failed`. */
  upload: (files: File[]) => Promise<void>
  /** Returns true when deleted. */
  remove: (image: MediaRef) => Promise<boolean>
}

/**
 * Images inside the post body: the list of images already uploaded for the post, and the upload path shared by the
 * insert-image button, paste and drag-and-drop. Each file takes exactly one path, like the cover image: prepareUpload downsizes in the browser
 * (≤ 4 MB, edge ≤ 2400; the Server Action only accepts 5 MB) → the `onUpload` action (a Server Action that does not
 * navigate) → `insert` puts `![alt](/media/<file>)` at the cursor.
 *
 * One job at a time (`running`, a ref to block even two clicks within the same frame): two overlapping uploads
 * would insert into each other, and the image quota is shared.
 */
export function useBodyImages({
  initial,
  onUpload,
  onDelete,
  insert,
  report,
  failed,
}: {
  initial: MediaRef[] | null | undefined
  /** Absent for an unsaved post: there is no post to attach images to yet. */
  onUpload?: (form: FormData) => Promise<ImageUploadOutcome>
  onDelete?: (mediaId: string) => Promise<ImageListOutcome>
  /**
   * Inserts an image at the cursor. `selectAlt`: preselect the alt text (to type over it). Only for the LAST image of a run of several
   * files: the next image is inserted at the selection, and having the previous alt selected would make the next image replace it.
   */
  insert: (image: MediaRef, alt: string, selectAlt: boolean) => void
  report: (outcome: ActionError) => void
  /** The action promise was rejected (the editor ignores navigation errors by itself). */
  failed: (caught: unknown) => void
}): BodyImages {
  const t = useTranslations('Admin.postImages')
  // State, not read straight from props: the action result is the new list, available as soon as the action returns.
  const [images, setImages] = useState<MediaRef[] | null>(initial === undefined ? [] : initial)
  const [uploading, setUploading] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [status, setStatus] = useState('')
  const running = useRef(false)

  async function upload(files: File[]): Promise<void> {
    if (onUpload === undefined) {
      setStatus(t('needSave'))
      return
    }
    if (files.length === 0) return
    if (running.current) {
      setStatus(t('oneAtATime'))
      return
    }
    running.current = true
    setUploading(true)
    let done = 0
    try {
      for (const [index, file] of files.entries()) {
        setStatus(
          files.length > 1
            ? t('uploadingProgress', { current: String(done + 1), total: String(files.length) })
            : t('uploadingOne'),
        )
        let ready: File
        try {
          ready = await prepareUpload(file)
        } catch (caught) {
          if (!(caught instanceof UploadRejectedError)) console.error('prepareUpload failed', caught)
          report({ error: caught instanceof UploadRejectedError ? uploadRejectedMessage(caught, t) : t('unreadable') })
          break
        }
        const alt = altFromFileName(file.name, t)
        const form = new FormData()
        form.append('file', ready)
        form.append('altText', alt)
        let result: ImageUploadOutcome
        try {
          result = await onUpload(form)
        } catch (caught) {
          failed(caught)
          break
        }
        if ('error' in result) {
          report(result)
          break
        }
        const image = result.image
        setImages((now) => [image, ...(now ?? []).filter((item) => item.id !== image.id)])
        insert(image, alt, index === files.length - 1)
        done += 1
      }
    } finally {
      running.current = false
      setUploading(false)
      setStatus(done === 0 ? '' : done === 1 ? t('insertedOne') : t('insertedMany', { count: done }))
    }
  }

  async function remove(image: MediaRef): Promise<boolean> {
    if (onDelete === undefined || running.current) return false
    running.current = true
    setDeleting(true)
    try {
      const result = await onDelete(image.id)
      if ('error' in result) {
        report(result)
        return false
      }
      setImages(result.images)
      setStatus(t('deleted'))
      return true
    } catch (caught) {
      failed(caught)
      return false
    } finally {
      running.current = false
      setDeleting(false)
    }
  }

  return {
    images,
    canUpload: onUpload !== undefined,
    busy: uploading || deleting,
    uploading,
    status,
    upload,
    remove,
  }
}
