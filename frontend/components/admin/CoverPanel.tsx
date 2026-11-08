'use client'

import Image from 'next/image'
import { useTranslations } from 'next-intl'
import { useId, useRef, useState } from 'react'
import { CoverArt } from '@/components/site/CoverArt'
import { Trash2Icon, UploadIcon } from '@/components/icons'
import { coverInputOf } from '@/lib/cover-art'
import { COVER_MIN_WIDTH, COVER_RECOMMENDED_WIDTH, isLowResolutionCover } from '@/lib/image-quality'
import { mediaPath } from '@/lib/media'
import { ACCEPTED_UPLOAD_TYPES, UploadRejectedError, prepareUpload, uploadRejectedMessage } from '@/lib/prepare-upload'
import type { MediaRef, PostSummary } from '@/lib/types'
import { ErrorAlert } from './primitives'
import { isRedirectError } from './PostEditor'
import { button, FILE_INPUT, HINT, INPUT, LABEL, STATUS_TEXT } from './ui'

/** Result of the three cover-image actions (app/admin/(shell)/posts/cover-actions.ts). */
export type CoverOutcome = { error: string } | { cover: MediaRef | null }

export type CoverPanelProps = {
  /**
   * null for an unsaved post: there is no post to attach an image to yet. `slug`, `category`, `series` (optional) are enough
   * to draw the automatic cover art the public page uses when the post has no cover image.
   */
  post: (Pick<PostSummary, 'status' | 'cover'> & Partial<Pick<PostSummary, 'slug' | 'category' | 'series'>>) | null
  /**
   * No id parameter, like the PostEditor actions: the page already bundled the post id into the Server
   * Action, and passing it again here would be two sources for the same value.
   */
  onUpload: (form: FormData) => Promise<CoverOutcome>
  onSaveAlt: (altText: string) => Promise<CoverOutcome>
  onRemove: () => Promise<CoverOutcome>
}

/** The preview frame sits in the editor's settings column (22rem, minus margins); below lg it is the full screen. */
const PREVIEW_SIZES = '(min-width: 1024px) 20rem, 100vw'

/**
 * Cover image in the editor: preview, file choice, description, upload button, save-description button,
 * remove button, errors shown in place.
 *
 * Placed OUTSIDE the PostEditor post form (the page passes it in via `aside`), and the file input has no `name`: a
 * file input inside the post form would send the image bytes with every save of the post, and Enter in the
 * description box would save the whole post. The image has a single path: choose file → prepareUpload downsizes in the browser
 * (≤ 4 MB, edge ≤ 2400) → the `onUpload` action.
 */
export default function CoverPanel(props: CoverPanelProps) {
  // Split the shell: hooks must not be called after an early return.
  if (props.post === null) return null
  return <Panel {...props} post={props.post} />
}

function Panel({ post, onUpload, onSaveAlt, onRemove }: CoverPanelProps & { post: NonNullable<CoverPanelProps['post']> }) {
  const t = useTranslations('Admin.editor.cover')
  const tImages = useTranslations('Admin.postImages')
  const tErrors = useTranslations('Errors.admin')
  const id = useId()
  const fileInput = useRef<HTMLInputElement>(null)
  // State, not read straight from props: the action result is the image just saved, available as soon as the action returns.
  // The page also re-renders (updateTag) and sends down that same image, so the two sources do not disagree.
  const [cover, setCover] = useState<MediaRef | null>(post.cover ?? null)
  const [altText, setAltText] = useState(post.cover?.altText ?? '')
  const [file, setFile] = useState<File | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState('')

  /**
   * Runs an action, locking every button until it finishes. Returns true on success.
   *
   * Catches rejected promises too, unlike PostEditor which rethrows: throwing from an async handler reaches
   * no error boundary, so the author presses a button and sees nothing (an old bug). A redirect error alone is
   * an expired session: the router is navigating to the login page by itself, so it is not an error to show.
   */
  async function run(action: () => Promise<CoverOutcome>, done: string): Promise<boolean> {
    setError(null)
    setNotice('')
    setPending(true)
    try {
      const result = await action()
      if ('error' in result) {
        setError(result.error)
        return false
      }
      setCover(result.cover)
      // The description the backend saved (trimmed, empty becomes null), not the string just typed.
      setAltText(result.cover?.altText ?? '')
      setNotice(done)
      return true
    } catch (caught) {
      if (isRedirectError(caught)) return false
      console.error('Cover action failed', caught)
      setError(tErrors('unreachable'))
      return false
    } finally {
      setPending(false)
    }
  }

  async function upload() {
    if (file === null) return
    const uploaded = await run(async () => {
      let ready: File
      try {
        ready = await prepareUpload(file)
      } catch (caught) {
        if (caught instanceof UploadRejectedError) return { error: uploadRejectedMessage(caught, tImages) }
        console.error('prepareUpload failed', caught)
        return { error: tImages('unreadable') }
      }
      const form = new FormData()
      form.append('file', ready)
      // Always sent, even when empty: the new image is described exactly as the box shows (empty → backend stores null).
      form.append('altText', altText)
      return onUpload(form)
    }, t('uploaded'))
    if (uploaded) {
      // Pressing the upload button again must not resend the very file that just became the cover image.
      setFile(null)
      if (fileInput.current !== null) fileInput.current.value = ''
    }
  }

  const headingId = `${id}-heading`
  const altId = `${id}-alt`
  const fileId = `${id}-file`

  return (
    <section aria-labelledby={headingId}>
      <h3 id={headingId} className={LABEL}>
        {t('heading')}
      </h3>

      <div className="space-y-4">
        {cover !== null ? (
          <span className="relative block aspect-[1200/630] w-full overflow-hidden rounded-md border border-slate-200 bg-slate-100">
            {/* Same aspect ratio as the post header frame (PostCover hero): the author sees exactly which part of the image gets cropped. */}
            <Image src={mediaPath(cover)} alt={t('currentAlt')} fill sizes={PREVIEW_SIZES} className="object-cover" />
          </span>
        ) : (
          <div>
            {post.slug !== undefined && (
              // The automatic art the public page draws for the post: decorative, the sentence below says what it is.
              <span className="mb-2 block aspect-[2/1] w-full overflow-hidden rounded-md border border-slate-200 bg-slate-100">
                <CoverArt input={coverInputOf({ slug: post.slug, category: post.category, series: post.series })} />
              </span>
            )}
            <p className="text-[13px] leading-5 text-slate-600">{t('none')}</p>
          </div>
        )}

        {cover !== null && isLowResolutionCover(cover) && (
          // The stored file is smaller than the frame it is shown in, so the browser enlarges it and it looks soft. Not an error: the
          // post still works, the author is told what to upload instead.
          <p
            role="note"
            className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[13px] leading-5 text-amber-900"
          >
            {t('lowResolution', { width: cover.width, min: COVER_MIN_WIDTH, recommended: COVER_RECOMMENDED_WIDTH })}
          </p>
        )}

        {post.status !== 'PUBLISHED' && (
          // Images are served publicly by a hard-to-guess UUID: a draft shows its image nowhere
          // on the site, but the image is not private. Say so, so nobody uploads something that must stay hidden.
          <p className="text-[13px] leading-5 text-slate-500">{t('draftNote')}</p>
        )}

        <div>
          <label htmlFor={altId} className={LABEL}>
            {t('altLabel')}
          </label>
          <input
            id={altId}
            type="text"
            value={altText}
            onKeyDown={(event) => {
              // Ctrl/⌘+S in this box means save the description, not the page-wide shortcut that saves the post
              // (PostEditor ignores events already preventDefault-ed). With no cover image there is no description
              // to save: only block, so the post is not saved and "saved" is not reported for a box that was typed in but never saved.
              if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 's') {
                event.preventDefault()
                if (cover !== null && !pending) void run(() => onSaveAlt(altText), t('altSaved'))
              }
            }}
            maxLength={300}
            disabled={pending}
            onChange={(event) => setAltText(event.target.value)}
            aria-describedby={`${altId}-hint`}
            className={INPUT}
          />
          <p id={`${altId}-hint`} className={HINT}>
            {t('altHint')}
          </p>
        </div>

        <div>
          <label htmlFor={fileId} className={LABEL}>
            {t('chooseLabel')}
          </label>
          {/* No `name`: see the component comment. */}
          <input
            id={fileId}
            ref={fileInput}
            type="file"
            accept={ACCEPTED_UPLOAD_TYPES.join(',')}
            disabled={pending}
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null)
              setError(null)
              setNotice('')
            }}
            aria-describedby={`${fileId}-hint`}
            className={FILE_INPUT}
          />
          <p id={`${fileId}-hint`} className={HINT}>
            {t('fileHint', { min: COVER_MIN_WIDTH, recommended: COVER_RECOMMENDED_WIDTH })}
          </p>
        </div>

        {error !== null && <ErrorAlert>{error}</ErrorAlert>}
        {/* Always present: a live region must exist before its content changes for the change to be announced. */}
        <p role="status" className={STATUS_TEXT}>
          {notice}
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={pending || file === null}
            onClick={() => void upload()}
            className={button('primary', 'sm')}
          >
            <UploadIcon />
            {t('upload')}
          </button>
          {cover !== null && (
            <>
              <button
                type="button"
                disabled={pending}
                onClick={() => void run(() => onSaveAlt(altText), t('altSaved'))}
                className={button('secondary', 'sm')}
              >
                {t('saveAlt')}
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => void run(onRemove, t('removed'))}
                className={button('danger', 'sm')}
              >
                <Trash2Icon />
                {t('remove')}
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  )
}
