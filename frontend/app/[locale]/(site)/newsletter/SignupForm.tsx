'use client'

import { useId, useRef, useState, type FormEvent } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { FOCUS_RING, TRANSITION } from '@/components/site/SectionHeading'
import { callBff } from '@/lib/bff-client'
import { sendError } from './messages'

/** `text-base`: below 16px Safari on iPhone zooms the page by itself when the field gets focus (like CommentForm). */
const INPUT =
  'block w-full min-w-0 rounded-md border border-neutral-300 bg-white px-3 py-2 text-base max-sm:min-h-11 text-neutral-900 read-only:bg-neutral-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:read-only:bg-neutral-950'

/** Same primary button style as /login and /profile; as tall as the input field beside it. */
const PRIMARY = `inline-flex h-11 shrink-0 items-center justify-center rounded-md border border-neutral-900 bg-neutral-900 px-5 text-sm font-medium text-white hover:border-brand hover:bg-brand aria-disabled:cursor-wait aria-disabled:opacity-70 dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:border-brand dark:hover:bg-brand dark:hover:text-white ${TRANSITION} ${FOCUS_RING}`

/** Rough check to avoid wasting an attempt of the rate limit; the real address format is decided by the backend. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+$/

type Failure = { message: string; field: boolean }

/** Where the address is POSTed: the script sends JSON here, and the form's own `action` names it for a submit before hydration. */
const SUBSCRIBE_ENDPOINT = '/api/newsletter/subscribe'

export function SignupForm() {
  const t = useTranslations('Site.newsletter')
  const locale = useLocale()
  const id = useId()
  const errorId = `${id}-loi`
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  // Block double submission: state only changes on the next render, a ref changes immediately.
  const pending = useRef(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending.current) return
    // Clear the old sentence first: resubmitting the same address changes the text of the live region, so it is read out again.
    setAccepted(false)
    const value = email.trim()
    if (!EMAIL_SHAPE.test(value)) {
      setFailure({ message: t('errors.emailInvalid'), field: true })
      return
    }
    pending.current = true
    setBusy(true)
    setFailure(null)
    const result = await callBff<unknown>(SUBSCRIBE_ENDPOINT, {
      method: 'POST',
      body: JSON.stringify({ email: value, locale }),
    })
    pending.current = false
    setBusy(false)
    if (result.ok) setAccepted(true)
    else if (result.code === 'VALIDATION_ERROR' || result.status === 413)
      setFailure({ message: t('errors.emailInvalid'), field: true })
    else setFailure({ message: sendError(result.code, result.status, t), field: false })
  }

  return (
    <form
      noValidate
      // Before hydration the browser submits natively: a POST the route refuses (JSON only), never a GET that would put the address in the URL.
      method="post"
      action={SUBSCRIBE_ENDPOINT}
      onSubmit={(event) => void submit(event)}
      className="mt-8"
    >
      <label htmlFor={id} className="block text-sm font-medium text-neutral-900 dark:text-neutral-100">
        {t('form.emailLabel')}
      </label>
      <div className="mt-2 flex flex-col gap-3 sm:flex-row">
        <input
          id={id}
          type="email"
          name="email"
          autoComplete="email"
          spellCheck={false}
          maxLength={254}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          readOnly={busy}
          aria-invalid={failure?.field || undefined}
          aria-describedby={failure !== null ? errorId : undefined}
          className={INPUT}
        />
        <button type="submit" aria-disabled={busy || undefined} className={PRIMARY}>
          {busy ? t('form.sending') : t('form.submit')}
        </button>
      </div>
      {failure !== null && (
        <p id={errorId} role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">
          {failure.message}
        </p>
      )}
      {/* Always present: a live region must exist before its text changes for the text to be announced. */}
      <p role="status" className="mt-4 text-neutral-700 dark:text-neutral-300">
        {accepted ? t('form.accepted') : ''}
      </p>
    </form>
  )
}
