'use client'

import { useTranslations } from 'next-intl'
import { useId, useState } from 'react'
import { isRedirectError } from './PostEditor'
import { ErrorAlert } from './primitives'
import { HINT, INPUT, INPUT_MONO, LABEL, STATUS_TEXT, button } from './ui'

/** The three fields of a series that the form edits (`SeriesRequest` in the backend). */
export type SeriesFields = {
  title: string
  slug: string
  description: string | null
}

/**
 * The form's action result (app/admin/(shell)/series/actions.ts): an error to show in place, or
 * the values the backend SAVED. The create-series action returns no value on success: it
 * navigates to the edit page.
 */
export type SeriesFormOutcome = { error: string } | SeriesFields

export type SeriesFormProps = {
  /** null: the new-series create form. */
  series: SeriesFields | null
  /** The page already bundled the series id into the action (like PostEditor), so there is no id here. */
  onSubmit: (form: FormData) => Promise<SeriesFormOutcome>
}

/**
 * Create or edit the name, path and description of a series.
 *
 * Controlled boxes, submitted with onSubmit + preventDefault like PostEditor, not with `<form
 * action>`: React 19 wipes a form action after it finishes, and a failed create (duplicate name)
 * must not lose the typed text.
 *
 * It draws no frame itself: the page puts the form into its card (the create-new-series area, the details column).
 */
export default function SeriesForm({ series, onSubmit }: SeriesFormProps) {
  const t = useTranslations('Admin.series.form')
  const id = useId()
  const creating = series === null
  const [title, setTitle] = useState(series?.title ?? '')
  const [slug, setSlug] = useState(series?.slug ?? '')
  const [description, setDescription] = useState(series?.description ?? '')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState('')

  /**
   * Catches rejected promises too: throwing from an async handler reaches no error boundary, and the
   * author presses the button and sees nothing. A redirect error is the success of the create form (to the edit page) or
   * an expired session (to the login page): the router is navigating by itself, so it is not an error to show.
   */
  async function submit(form: FormData) {
    setError(null)
    setNotice('')
    setPending(true)
    try {
      const result = await onSubmit(form)
      if ('error' in result) {
        setError(result.error)
        return
      }
      // The values the backend saved, not the text just typed: the slug has been normalized (and may have
      // gained a suffix on a duplicate), the name trimmed, a blank description turned into null. The box must show the real URL.
      setTitle(result.title)
      setSlug(result.slug)
      setDescription(result.description ?? '')
      setNotice(t('saved'))
    } catch (caught) {
      if (isRedirectError(caught)) return
      console.error('Series form action failed', caught)
      setError(t('unreachable'))
    } finally {
      setPending(false)
    }
  }

  const titleId = `${id}-title`
  const slugId = `${id}-slug`
  const descriptionId = `${id}-description`

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault()
        // Block here and not only with disabled: Enter in a box still submits the form.
        if (pending) return
        void submit(new FormData(event.currentTarget))
      }}
    >
      <div>
        <label htmlFor={titleId} className={LABEL}>
          {t('titleLabel')}
        </label>
        <input
          id={titleId}
          name="title"
          value={title}
          required
          maxLength={255}
          onChange={(event) => setTitle(event.target.value)}
          className={INPUT}
        />
      </div>

      <div>
        <label htmlFor={slugId} className={LABEL}>
          {t('slugLabel')}
        </label>
        {/* A phone keyboard does not auto-capitalize or underline in red: a slug is not a sentence. */}
        <input
          id={slugId}
          name="slug"
          value={slug}
          maxLength={255}
          autoCapitalize="none"
          spellCheck={false}
          onChange={(event) => setSlug(event.target.value)}
          aria-describedby={`${slugId}-hint`}
          className={INPUT_MONO}
        />
        <p id={`${slugId}-hint`} className={HINT}>
          {/* break-words: the details column is only 20rem wide; the slug breaks at hyphens, and a continuous run
              longer than the line gets broken midway instead of overflowing sideways. */}
          <span className="font-mono break-words text-slate-600">/series/{slug.trim() || '…'}</span>
          {' · '}
          {creating
            ? t('slugHintCreate')
            : // The backend keeps the old slug when the box is empty (SeriesService.update), it does not regenerate from the name.
              t('slugHintEdit')}
        </p>
      </div>

      <div>
        <label htmlFor={descriptionId} className={LABEL}>
          {t('descriptionLabel')}
        </label>
        <textarea
          id={descriptionId}
          name="description"
          value={description}
          rows={3}
          maxLength={2000}
          onChange={(event) => setDescription(event.target.value)}
          aria-describedby={`${descriptionId}-hint`}
          className={INPUT}
        />
        <p id={`${descriptionId}-hint`} className={HINT}>
          {t('descriptionHint')}
        </p>
      </div>

      {error !== null && <ErrorAlert>{error}</ErrorAlert>}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <button type="submit" disabled={pending} className={button('primary')}>
          {creating ? t('create') : t('saveInfo')}
        </button>
        {/* Always present: a live region must exist before its content changes for the change to be announced. Placed
            next to the button: the saved message appears exactly where the eye just pressed. */}
        <p role="status" className={STATUS_TEXT}>
          {notice}
        </p>
      </div>
    </form>
  )
}
