'use client'

import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useId, useState } from 'react'
import { postMfa } from '@/lib/mfa-client'
import type { MfaStatus } from '@/lib/types'
import { ErrorAlert } from '../primitives'
import { button, CARD, H2, HINT, INPUT, LABEL, SECTION_DESC, STATUS_TEXT } from '../ui'
import { ENDPOINTS } from './endpoints'
import type { FailedReply } from './EnrollFlow'

/** The password policy's bounds (backend PasswordPolicy). Only a pre-check: the server is the authority on every other rule. */
const PASSWORD_MIN = 12
const PASSWORD_MAX = 128

/**
 * Change password. Only for an account that has a password (an author signs in with GitHub and has none); when the server sets the
 * password itself (`ADMIN_PASSWORD`, `passwordManagedByEnvironment`) the form is replaced by the sentence that says how to change it,
 * because a password changed here would be undone at the next start.
 *
 * Fields: the current password, the new one twice and, for an account with two-step verification, a code (authenticator or recovery).
 * The client checks length, that the two copies match and that the new password differs from the current one, so that the
 * common slips cost no round trip; the common-password list and the rest of the policy are the backend's, whose answer is shown as the
 * handler translated it. Success replaces the other devices' sessions (this one is reissued) and says so.
 */
export default function PasswordForm({ status, onRefused }: { status: MfaStatus; onRefused: (reply: FailedReply) => void }) {
  const t = useTranslations('Admin.security')
  const router = useRouter()
  const ids = { current: useId(), next: useId(), repeat: useId(), code: useId(), hint: useId() }
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [repeat, setRepeat] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)

  if (!status.hasPassword) return null

  if (status.passwordManagedByEnvironment) {
    return (
      <section aria-labelledby="security-password" className={`${CARD} p-5 sm:p-6`}>
        <h2 id="security-password" className={H2}>
          {t('password.title')}
        </h2>
        <p className={SECTION_DESC}>{t('password.managedByEnvironment')}</p>
      </section>
    )
  }

  function check(): string | null {
    if (current === '') return t('password.currentRequired')
    if (next.length < PASSWORD_MIN) return t('password.tooShort', { min: PASSWORD_MIN })
    if (next.length > PASSWORD_MAX) return t('password.tooLong', { max: PASSWORD_MAX })
    if (next !== repeat) return t('password.mismatch')
    if (next === current) return t('password.same')
    if (status.enrolled && code.trim() === '') return t('codeRequired')
    return null
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setDone(false)
    const problem = check()
    setError(problem)
    if (problem !== null) return
    setBusy(true)
    const reply = await postMfa(ENDPOINTS.password, {
      currentPassword: current,
      newPassword: next,
      ...(status.enrolled ? { code: code.trim() } : {}),
    })
    setBusy(false)
    if (!reply.ok) {
      setError(reply.reauthenticate ? null : (reply.error ?? t('errors.unreachable')))
      onRefused(reply)
      return
    }
    // The fields are emptied: a password does not stay in a form that has done its job.
    setCurrent('')
    setNext('')
    setRepeat('')
    setCode('')
    setDone(true)
    router.refresh()
  }

  return (
    <section aria-labelledby="security-password" className={`${CARD} p-5 sm:p-6`}>
      <h2 id="security-password" className={H2}>
        {t('password.title')}
      </h2>
      <form method="post" action={ENDPOINTS.password} onSubmit={submit} noValidate className="mt-4 max-w-md space-y-4">
        <div>
          <label htmlFor={ids.current} className={LABEL}>
            {t('password.current')}
          </label>
          <input
            id={ids.current}
            name="currentPassword"
            type="password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            autoComplete="current-password"
            className={INPUT}
          />
        </div>
        <div>
          <label htmlFor={ids.next} className={LABEL}>
            {t('password.new')}
          </label>
          <input
            id={ids.next}
            name="newPassword"
            type="password"
            value={next}
            onChange={(event) => setNext(event.target.value)}
            autoComplete="new-password"
            aria-describedby={ids.hint}
            className={INPUT}
          />
          <p id={ids.hint} className={HINT}>
            {t('password.hint', { min: PASSWORD_MIN, max: PASSWORD_MAX })}
          </p>
        </div>
        <div>
          <label htmlFor={ids.repeat} className={LABEL}>
            {t('password.repeat')}
          </label>
          <input
            id={ids.repeat}
            name="repeatPassword"
            type="password"
            value={repeat}
            onChange={(event) => setRepeat(event.target.value)}
            autoComplete="new-password"
            className={INPUT}
          />
        </div>
        {status.enrolled && (
          <div>
            <label htmlFor={ids.code} className={LABEL}>
              {t('currentCode')}
            </label>
            <input
              id={ids.code}
              name="code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              autoComplete="one-time-code"
              spellCheck={false}
              maxLength={40}
              className={INPUT}
            />
          </div>
        )}
        {error !== null && <ErrorAlert>{error}</ErrorAlert>}
        <button type="submit" disabled={busy} className={button('primary', 'md', 'min-h-10')}>
          {busy ? t('password.submitting') : t('password.submit')}
        </button>
        <p role="status" className={`min-h-6 ${STATUS_TEXT}`}>
          {done ? t('password.done') : ''}
        </p>
      </form>
    </section>
  )
}
