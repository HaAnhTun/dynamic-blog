'use client'

import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'
import { ErrorAlert } from '@/components/admin/primitives'
import { button, CARD, HINT, INPUT, LABEL } from '@/components/admin/ui'
import { SETUP_ENDPOINT } from './namespaces'

const MIN_PASSWORD = 12
const MAX_PASSWORD = 128
const MAX_NAME = 60
const MAX_EMAIL = 120
const MAX_CODE = 256
const KNOWN_ERRORS = ['SETUP_CODE_INVALID', 'SETUP_CLOSED', 'VALIDATION_ERROR', 'RATE_LIMITED', 'UNAVAILABLE'] as const

type Field = 'setupCode' | 'displayName' | 'email' | 'password' | 'confirm'
type FieldErrorKey =
  'codeRequired' | 'nameRequired' | 'nameTooLong' | 'emailInvalid' | 'passwordShort' | 'passwordLong' | 'confirmMismatch'
type FieldErrors = Partial<Record<Field, FieldErrorKey>>

const FIELD_ORDER: Field[] = ['setupCode', 'displayName', 'email', 'password', 'confirm']

function validate(values: Record<Field, string>): FieldErrors {
  const errors: FieldErrors = {}
  if (values.setupCode.trim() === '') errors.setupCode = 'codeRequired'
  const name = values.displayName.trim()
  if (name === '') errors.displayName = 'nameRequired'
  else if (name.length > MAX_NAME) errors.displayName = 'nameTooLong'
  const email = values.email.trim()
  if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.length > MAX_EMAIL) errors.email = 'emailInvalid'
  if (values.password.length < MIN_PASSWORD) errors.password = 'passwordShort'
  else if (values.password.length > MAX_PASSWORD) errors.password = 'passwordLong'
  if (values.confirm !== values.password) errors.confirm = 'confirmMismatch'
  return errors
}

export default function SetupForm() {
  const t = useTranslations('Setup')
  const router = useRouter()
  const formRef = useRef<HTMLFormElement>(null)
  const inFlight = useRef(false)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inFlight.current) return
    setError(null)

    const data = new FormData(event.currentTarget)
    const read = (name: Field) => {
      const value = data.get(name)
      return typeof value === 'string' ? value : ''
    }
    const values: Record<Field, string> = {
      setupCode: read('setupCode'),
      displayName: read('displayName'),
      email: read('email'),
      password: read('password'),
      confirm: read('confirm'),
    }
    const errors = validate(values)
    setFieldErrors(errors)
    const firstInvalid = FIELD_ORDER.find((field) => errors[field])
    if (firstInvalid) {
      formRef.current?.querySelector<HTMLInputElement>(`[name="${firstInvalid}"]`)?.focus()
      return
    }

    inFlight.current = true
    setPending(true)
    try {
      const res = await fetch(SETUP_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          setupCode: values.setupCode.trim(),
          displayName: values.displayName.trim(),
          email: values.email.trim(),
          password: values.password,
        }),
      })
      const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null
      if (res.ok && body?.ok === true) {
        router.replace('/admin/login')
        return
      }
      const known = KNOWN_ERRORS.find((code) => code === body?.error)
      setError(t(`errors.${known ?? 'GENERIC'}`))
    } catch {
      setError(t('errors.NETWORK'))
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }

  function describedBy(field: Field, hint: boolean) {
    const ids = [hint ? `${field}-hint` : null, fieldErrors[field] ? `${field}-error` : null].filter(Boolean)
    return ids.length > 0 ? ids.join(' ') : undefined
  }

  function fieldError(field: Field) {
    const key = fieldErrors[field]
    return key ? (
      <p id={`${field}-error`} role="alert" className="mt-1.5 text-[13px] leading-5 text-red-700">
        {t(`fieldErrors.${key}`)}
      </p>
    ) : null
  }

  return (
    <form
      ref={formRef}
      // Before hydration (or without JavaScript) the browser submits natively: a POST that the route rejects, never a GET that would put the code and the password in the URL.
      method="post"
      action={SETUP_ENDPOINT}
      onSubmit={onSubmit}
      noValidate
      className={`${CARD} mt-8 space-y-5 p-6 sm:p-8`}
    >
      <div>
        <label htmlFor="setupCode" className={LABEL}>
          {t('code.label')}
        </label>
        <input
          id="setupCode"
          name="setupCode"
          type="password"
          required
          autoComplete="off"
          spellCheck={false}
          maxLength={MAX_CODE}
          aria-invalid={fieldErrors.setupCode !== undefined}
          aria-describedby={describedBy('setupCode', true)}
          className={INPUT}
        />
        <p id="setupCode-hint" className={HINT}>
          {t.rich('code.hint', { code: (chunks) => <code className="font-mono">{chunks}</code> })}
        </p>
        {fieldError('setupCode')}
      </div>
      <div>
        <label htmlFor="displayName" className={LABEL}>
          {t('displayName.label')}
        </label>
        <input
          id="displayName"
          name="displayName"
          type="text"
          required
          autoComplete="name"
          maxLength={MAX_NAME}
          aria-invalid={fieldErrors.displayName !== undefined}
          aria-describedby={describedBy('displayName', false)}
          className={INPUT}
        />
        {fieldError('displayName')}
      </div>
      <div>
        <label htmlFor="email" className={LABEL}>
          {t('email.label')}
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          maxLength={MAX_EMAIL}
          aria-invalid={fieldErrors.email !== undefined}
          aria-describedby={describedBy('email', false)}
          className={INPUT}
        />
        {fieldError('email')}
      </div>
      <div>
        <label htmlFor="password" className={LABEL}>
          {t('password.label')}
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="new-password"
          maxLength={MAX_PASSWORD}
          aria-invalid={fieldErrors.password !== undefined}
          aria-describedby={describedBy('password', true)}
          className={INPUT}
        />
        <p id="password-hint" className={HINT}>
          {t('password.hint', { min: MIN_PASSWORD })}
        </p>
        {fieldError('password')}
      </div>
      <div>
        <label htmlFor="confirm" className={LABEL}>
          {t('confirm.label')}
        </label>
        <input
          id="confirm"
          name="confirm"
          type="password"
          required
          autoComplete="new-password"
          maxLength={MAX_PASSWORD}
          aria-invalid={fieldErrors.confirm !== undefined}
          aria-describedby={describedBy('confirm', false)}
          className={INPUT}
        />
        {fieldError('confirm')}
      </div>
      {error !== null && <ErrorAlert>{error}</ErrorAlert>}
      <button type="submit" aria-disabled={pending} className={button('primary', 'md', 'w-full min-h-10')}>
        {pending ? t('submitting') : t('submit')}
      </button>
    </form>
  )
}
