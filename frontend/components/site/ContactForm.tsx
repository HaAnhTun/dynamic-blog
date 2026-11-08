'use client'

import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { iconClassName } from '@/components/icons'
import { callBff } from '@/lib/bff-client'
import { CONTACT_EMAIL_SHAPE, CONTACT_LIMITS } from '@/lib/contact-limits'
import { FOCUS_RING, TRANSITION } from './SectionHeading'

/** `text-base`: below 16px Safari on iPhone zooms the page by itself when a field gets focus (like the newsletter form). */
const FIELD =
  'block w-full min-w-0 rounded-md border max-sm:min-h-11 border-neutral-300 bg-white px-3 py-2 text-base text-neutral-900 placeholder:text-neutral-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand aria-[invalid=true]:border-red-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-400 dark:aria-[invalid=true]:border-red-400'

/** Same primary button as the newsletter form, with room for the icon. */
const PRIMARY = `inline-flex h-11 w-full items-center sm:w-auto justify-center gap-2 rounded-md border border-neutral-900 bg-neutral-900 px-5 text-sm font-medium text-white hover:border-brand hover:bg-brand disabled:cursor-wait disabled:opacity-70 dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:border-brand dark:hover:bg-brand dark:hover:text-white ${TRANSITION} ${FOCUS_RING}`

const LABEL = 'block text-sm font-medium text-neutral-900 dark:text-neutral-100'
const FIELD_ERROR = 'mt-1.5 text-sm text-red-700 dark:text-red-300'

/** lucide `send`, drawn like the icons of components/icons.tsx (that file's `Glyph` is not exported). */
function SendIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={iconClassName(16)}
    >
      <path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" />
      <path d="m21.854 2.147-10.94 10.939" />
    </svg>
  )
}

/** Where the message is POSTed: the script sends JSON here, and the form's own `action` names it for a submit before hydration. */
const CONTACT_ENDPOINT = '/api/contact'

type Fields = { name: string; email: string; subject: string; message: string; website: string }
type FieldKey = 'name' | 'email' | 'subject' | 'message'
type Banner = { kind: 'validation' | 'rateLimited' | 'generic' }

const FIELD_ORDER: FieldKey[] = ['name', 'email', 'subject', 'message']

const EMPTY: Fields = { name: '', email: '', subject: '', message: '', website: '' }

/** The same limits as the BFF route and the backend; returns the fields that fail. */
function validate(fields: Fields): Partial<Record<FieldKey, true>> {
  const name = fields.name.trim()
  const email = fields.email.trim()
  const message = fields.message.trim()
  const invalid: Partial<Record<FieldKey, true>> = {}
  if (name === '' || name.length > CONTACT_LIMITS.nameMax) invalid.name = true
  if (email.length > CONTACT_LIMITS.emailMax || !CONTACT_EMAIL_SHAPE.test(email)) invalid.email = true
  if (fields.subject.trim().length > CONTACT_LIMITS.subjectMax) invalid.subject = true
  if (message.length < CONTACT_LIMITS.messageMin || message.length > CONTACT_LIMITS.messageMax) invalid.message = true
  return invalid
}

export function ContactForm() {
  const t = useTranslations('Site.contact')
  const locale = useLocale()
  const id = useId()
  const [fields, setFields] = useState<Fields>(EMPTY)
  const [invalid, setInvalid] = useState<Partial<Record<FieldKey, true>>>({})
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [banner, setBanner] = useState<Banner | null>(null)
  // A new object for every refused submit: the effect below then moves focus to that field.
  const [focusRequest, setFocusRequest] = useState<{ key: FieldKey } | null>(null)
  // Block double submission: state only changes on the next render, a ref changes immediately.
  const pending = useRef(false)

  const fieldId = (key: string) => `${id}-${key}`

  // After the render that shows the errors, so the field is already aria-invalid and described by its message when it is announced.
  useEffect(() => {
    if (focusRequest !== null) document.getElementById(`${id}-${focusRequest.key}`)?.focus()
  }, [focusRequest, id])
  const errorId = (key: FieldKey) => `${id}-${key}-error`

  function set(key: keyof Fields) {
    return (event: { target: { value: string } }) => setFields((current) => ({ ...current, [key]: event.target.value }))
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending.current) return
    // Clear the old confirmation first: sending again changes the text of the live region, so it is read out again.
    setSent(false)
    const problems = validate(fields)
    setInvalid(problems)
    if (Object.keys(problems).length > 0) {
      setBanner(null)
      const first = FIELD_ORDER.find((key) => problems[key])
      if (first) setFocusRequest({ key: first })
      return
    }
    pending.current = true
    setBusy(true)
    setBanner(null)
    const result = await callBff<unknown>(CONTACT_ENDPOINT, {
      method: 'POST',
      body: JSON.stringify({
        name: fields.name.trim(),
        email: fields.email.trim(),
        subject: fields.subject.trim(),
        message: fields.message.trim(),
        website: fields.website,
        locale,
      }),
    })
    pending.current = false
    setBusy(false)
    if (result.ok) {
      setFields(EMPTY)
      setSent(true)
    } else if (result.code === 'VALIDATION_ERROR' || result.status === 400 || result.status === 413) {
      // The BFF cannot say which field the backend refused, so the hint is generic.
      setBanner({ kind: 'validation' })
    } else if (result.code === 'RATE_LIMITED' || result.status === 429) {
      setBanner({ kind: 'rateLimited' })
    } else {
      setBanner({ kind: 'generic' })
    }
  }

  function describedBy(key: FieldKey): string | undefined {
    return invalid[key] ? errorId(key) : undefined
  }

  return (
    <form
      noValidate
      // Before hydration the browser submits natively: a POST the route refuses (JSON only), never a GET that would put the name, the address and the message in the URL.
      method="post"
      action={CONTACT_ENDPOINT}
      onSubmit={(event) => void submit(event)}
      className="space-y-5"
    >
      <p className="text-sm text-neutral-600 dark:text-neutral-400">{t('form.requiredNote')}</p>

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor={fieldId('name')} className={LABEL}>
            {t('form.nameLabel')}{' '}
            <span aria-hidden="true" className="text-red-700 dark:text-red-300">
              *
            </span>
          </label>
          <input
            id={fieldId('name')}
            type="text"
            name="name"
            autoComplete="name"
            required
            maxLength={CONTACT_LIMITS.nameMax}
            placeholder={t('form.namePlaceholder')}
            value={fields.name}
            onChange={set('name')}
            readOnly={busy}
            aria-invalid={invalid.name || undefined}
            aria-describedby={describedBy('name')}
            className={`mt-2 ${FIELD}`}
          />
          {invalid.name && (
            <p id={errorId('name')} className={FIELD_ERROR}>
              {t('errors.name')}
            </p>
          )}
        </div>
        <div>
          <label htmlFor={fieldId('email')} className={LABEL}>
            {t('form.emailLabel')}{' '}
            <span aria-hidden="true" className="text-red-700 dark:text-red-300">
              *
            </span>
          </label>
          <input
            id={fieldId('email')}
            type="email"
            name="email"
            autoComplete="email"
            spellCheck={false}
            required
            maxLength={CONTACT_LIMITS.emailMax}
            placeholder={t('form.emailPlaceholder')}
            value={fields.email}
            onChange={set('email')}
            readOnly={busy}
            aria-invalid={invalid.email || undefined}
            aria-describedby={describedBy('email')}
            className={`mt-2 ${FIELD}`}
          />
          {invalid.email && (
            <p id={errorId('email')} className={FIELD_ERROR}>
              {t('errors.email')}
            </p>
          )}
        </div>
      </div>

      <div>
        <label htmlFor={fieldId('subject')} className={LABEL}>
          {t('form.subjectLabel')}{' '}
          <span className="font-normal text-neutral-600 dark:text-neutral-400">{t('form.optional')}</span>
        </label>
        <input
          id={fieldId('subject')}
          type="text"
          name="subject"
          autoComplete="off"
          maxLength={CONTACT_LIMITS.subjectMax}
          placeholder={t('form.subjectPlaceholder')}
          value={fields.subject}
          onChange={set('subject')}
          readOnly={busy}
          aria-invalid={invalid.subject || undefined}
          aria-describedby={describedBy('subject')}
          className={`mt-2 ${FIELD}`}
        />
        {invalid.subject && (
          <p id={errorId('subject')} className={FIELD_ERROR}>
            {t('errors.subject')}
          </p>
        )}
      </div>

      <div>
        <label htmlFor={fieldId('message')} className={LABEL}>
          {t('form.messageLabel')}{' '}
          <span aria-hidden="true" className="text-red-700 dark:text-red-300">
            *
          </span>
        </label>
        <textarea
          id={fieldId('message')}
          name="message"
          rows={5}
          required
          maxLength={CONTACT_LIMITS.messageMax}
          placeholder={t('form.messagePlaceholder')}
          value={fields.message}
          onChange={set('message')}
          readOnly={busy}
          aria-invalid={invalid.message || undefined}
          aria-describedby={describedBy('message')}
          className={`mt-2 resize-y ${FIELD}`}
        />
        {invalid.message && (
          <p id={errorId('message')} className={FIELD_ERROR}>
            {t('errors.message')}
          </p>
        )}
      </div>

      {/* Honeypot: people never see or reach it, so a filled value means a script. Hidden from assistive tech and the tab order. */}
      <div aria-hidden="true" className="sr-only">
        <input type="text" name="website" tabIndex={-1} autoComplete="off" value={fields.website} onChange={set('website')} />
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <button type="submit" disabled={busy} className={PRIMARY}>
          <SendIcon />
          {busy ? t('form.sending') : t('form.submit')}
        </button>
        {/* Always present: a live region must exist before its text changes for the text to be announced. */}
        <p aria-live="polite" role="status" className="text-sm text-neutral-700 dark:text-neutral-300">
          {sent ? t('form.success') : ''}
        </p>
      </div>
      {banner !== null && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {banner.kind === 'validation' && t('errors.validation')}
          {banner.kind === 'rateLimited' && t('errors.rateLimited')}
          {banner.kind === 'generic' && t('errors.generic')}
        </p>
      )}
    </form>
  )
}
